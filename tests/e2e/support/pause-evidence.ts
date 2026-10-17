import type { Buffer } from 'node:buffer'
import type { ServerRequest } from './selftest-handover.ts'
import type { RequestRun } from './selftest-request.ts'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { PAUSED_HOLDER_EDITS } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { withDatabase } from './database.ts'

export const pauseHash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const PAUSE_CONTENT_HASH = pauseHash(JSON.stringify(PAUSED_HOLDER_EDITS.map(cell => cell.value)))
export const PAUSE_CLOUD_HASH = pauseHash(JSON.stringify([...PAUSED_HOLDER_EDITS.slice(0, 2).map(cell => cell.value), null]))

/** 数据库原件独立解压；不使用页面报告或产品恢复器的内存正文。 */
export async function pauseCloudState(documentId: string) {
  return withDatabase(async (client) => {
    const row = (await client.query<{ revision: number, snapshot: Buffer }>('SELECT d.revision, c.snapshot FROM documents d JOIN document_contents c ON c.document_id = d.id WHERE d.id = $1', [documentId])).rows[0]
    if (row === undefined)
      throw new Error('本轮暂停测试文档不存在')
    const book = JSON.parse(gunzipSync(row.snapshot).toString('utf8')) as { sheets: Record<string, { cellData?: Record<number, Record<number, { v?: unknown }>> }> }
    const values = PAUSED_HOLDER_EDITS.map(cell => book.sheets[cell.sheetId]?.cellData?.[cell.row]?.[cell.column]?.v ?? null)
    return { revision: row.revision, contentHash: pauseHash(JSON.stringify(values)) }
  })
}

/** HTTP 日志的 time 是完成时刻，扣去 duration 才是发起时刻。 */
const requestStart = (request: ServerRequest): number => request.time - (request.durationMs ?? 0)

export function pauseServerProblems(run: RequestRun, window: { readonly pausedAt: number, readonly resumedAt: number, readonly holderId: string, readonly native: boolean }): string[] {
  const problems = [...run.judgement.problems]
  const { pausedAt, resumedAt, holderId, native } = window
  if (run.voided !== undefined)
    problems.push('本轮已作废')
  if (!Number.isSafeInteger(pausedAt) || !Number.isSafeInteger(resumedAt) || pausedAt <= 0 || resumedAt <= pausedAt
    || (run.marks.requestedAt ?? 0) < pausedAt || (run.marks.acquiredAt ?? 0) <= pausedAt || (run.marks.acquiredAt ?? Number.POSITIVE_INFINITY) >= resumedAt) {
    problems.push('暂停、协作者请求/接手和恢复的先后不符')
  }
  const holder = run.requests.filter(request => request.userId === holderId)
  if (native && holder.some(request => requestStart(request) >= pausedAt && requestStart(request) < resumedAt))
    problems.push('原生停止期间服务端仍收到持有者的文档请求')
  const sent = run.report?.facts?.staleSaveSentAt
  const answered = run.report?.facts?.staleSaveAnsweredAt
  const saves = holder.filter(request => request.method === 'PUT' && request.route?.endsWith('/content') === true && requestStart(request) >= resumedAt)
  if (typeof sent !== 'number' || typeof answered !== 'number' || sent < resumedAt || answered < sent || saves.length !== 1
    || !saves.every(request => request.statusCode === 409 && !request.aborted && requestStart(request) >= sent - 2 && request.time <= answered + 1000)) {
    problems.push('缺少恢复之后本轮旧保存被 409 拒绝的独立 HTTP 证据')
  }
  return problems
}

/** 不保存 PeerCall 的任意 body、token 或原始错误说明；所需原件是时序、代次和 HTTP 状态。 */
export function pauseRequestEvidence(run: RequestRun) {
  return {
    problems: run.judgement.problems,
    marks: run.marks,
    states: run.states,
    requests: run.requests,
    notesCount: run.notes.length,
    voided: run.voided !== undefined,
    calls: run.calls.map(({ body, ...call }) => {
      const kind = typeof body === 'object' && body !== null ? (body as { kind?: unknown }).kind : undefined
      return { ...call, kind: typeof kind === 'string' && ['pending', 'free', 'reserved'].includes(kind) ? kind : undefined }
    }),
  }
}
