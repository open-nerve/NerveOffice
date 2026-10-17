// 真实暂停的页面侧准备；只读生产 Worker/IDB 事实，不改产品身份、租约或恢复规则。
import type { SelftestReport } from './selftest-report.ts'
import type { Session } from './selftest-session.ts'
import { autosaveControl } from './selftest-autosave.ts'
import { readSelftestDraft } from './selftest-local-draft.ts'
import { decryptSelftestDraft, observeSelftestWrites, selftestSha256 } from './selftest-persistence.ts'
import { PAUSED_HOLDER_EDITS } from './selftest-report.ts'
import { check, fail } from './selftest-session.ts'
import { observeStaleSelftestSave } from './selftest-stale-save.ts'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const LOCAL_WAIT_MS = 30_000

export function pauseControlFrom(href: string): { readonly endpoint: string, readonly runId: string } | undefined {
  try {
    const page = new URL(href)
    const endpoint = new URL(page.searchParams.get('next') ?? '')
    const runId = new RegExp(`^/__nerve-pause/(${UUID})$`, 'i').exec(endpoint.pathname)?.[1]
    if (page.searchParams.get('selftest') !== 'paused-local-holder' || endpoint.origin !== page.origin || endpoint.username !== '' || endpoint.password !== '' || endpoint.search !== '' || endpoint.hash !== '' || runId === undefined)
      return undefined
    return { endpoint: endpoint.href, runId }
  }
  catch {
    return undefined
  }
}

/** 取值不经过产品 Reader 或 SDK 恢复；缺少本轮单元格就保留为空。 */
export function pauseCellValues(text: string): readonly unknown[] {
  const value = JSON.parse(text) as { snapshot?: unknown }
  const book = (value.snapshot ?? value) as { sheets?: Record<string, { cellData?: Record<number, Record<number, { v?: unknown }>> }> }
  return PAUSED_HOLDER_EDITS.map(cell => book.sheets?.[cell.sheetId]?.cellData?.[cell.row]?.[cell.column]?.v ?? null)
}

export interface LocalPauseSelftest {
  readonly beforeThird?: (() => Promise<void>) | undefined
  readonly persist: (session: Session) => Promise<boolean>
  readonly cleaned: (session: Session) => Promise<boolean>
  readonly rejected: (session: Session) => Promise<boolean>
  readonly report: (report: SelftestReport) => Promise<void>
  readonly dispose: () => void
}

/** 在 page.load 前安装；新场景才使用同源 POST 报告，旧场景的跳转不变。 */
export async function prepareLocalPauseSelftest(documentId: string): Promise<LocalPauseSelftest> {
  const control = pauseControlFrom(location.href)
  if (control === undefined)
    throw new Error('本机草稿暂停缺少合法同源控制入口')
  const common = { runId: control.runId, documentId, bootId: crypto.randomUUID() }
  const writes = observeSelftestWrites()
  const stale = observeStaleSelftestSave(documentId, location.origin)
  let disposed = false
  const dispose = (): void => {
    disposed = true
    writes.dispose()
    stale.dispose()
  }
  const post = async (kind: string, facts: Record<string, unknown> = {}): Promise<string> => {
    const response = await fetch(control.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, ...common, ...facts }), signal: AbortSignal.timeout(10_000) })
    if (!response.ok)
      throw new Error(`暂停证据通道拒绝消息：${response.status}`)
    const command = await response.json() as { kind?: unknown }
    if (typeof command.kind !== 'string' || !['prepare', 'prepare-window', 'window-ready', 'wait'].includes(command.kind))
      throw new Error('暂停证据被驱动拒绝')
    return command.kind
  }
  let waitForWindow = false
  try {
    const command = await post('boot')
    if (command !== 'prepare' && command !== 'prepare-window')
      throw new Error('暂停场景没有取得准备许可')
    waitForWindow = command === 'prepare-window'
  }
  catch (error) {
    dispose()
    throw error
  }
  let userId: string | undefined
  let posted = false
  return {
    beforeThird: waitForWindow
      ? async () => {
        const until = performance.now() + 10_000
        while (performance.now() < until) {
          if (disposed)
            break
          const command = await post('window-state')
          if (command === 'window-ready') {
            if (document.visibilityState !== 'hidden')
              throw new Error('窗口已经确认，但页面没有保持隐藏')
            return
          }
          if (command !== 'wait')
            throw new Error('窗口条件回应不符')
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error('窗口条件未在十秒内确认或本轮已结束')
      }
      : undefined,
    persist: async session => check(session, 'request.holder.local-ready', async () => {
      if (posted || !autosaveControl().held())
        fail('本机准备重复运行或定时上传没有暂停')
      const response = await fetch('/api/auth/session', { signal: AbortSignal.timeout(10_000) })
      if (!response.ok)
        fail('暂停准备无法取得本轮测试会话')
      const auth = await response.json() as { user: { id: string }, csrfToken: string }
      userId = auth.user.id
      // 不调用 flush；恢复的是捕获节奏，timed upload 的 hold 保留。
      autosaveControl().resetLimits()
      const until = performance.now() + LOCAL_WAIT_MS
      while (performance.now() < until) {
        const draft = await readSelftestDraft(userId, documentId)
        if (draft !== undefined && draft.baseRevision === 3 && draft.inFlight === null && !draft.formulasPending) {
          const text = await decryptSelftestDraft(draft, auth.csrfToken)
          const values = pauseCellValues(text)
          const snapshotHash = await selftestSha256(text)
          if (values.every((value, index) => value === PAUSED_HOLDER_EDITS[index]?.value) && writes.writtenFor(draft, snapshotHash)) {
            const pageErrors = session.host.pageErrors().length + session.host.consoleErrors().length
            if (pageErrors !== 0 || document.visibilityState !== 'hidden' || session.host.view().mode !== 'editing')
              fail('本机正文就绪时页面有错误、已经回到前台或失去编辑权')
            const compressed = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
            stale.prepare({ clientInstanceId: draft.writtenBy, localSeq: session.probe.changeSeq(), compressed })
            const command = await post('local-ready', {
              userId,
              clientInstanceId: draft.writtenBy,
              writerId: draft.writerId,
              writeEpoch: draft.writeEpoch,
              draftSeq: draft.draftSeq,
              baseRevision: draft.baseRevision,
              contentHash: await selftestSha256(JSON.stringify(values)),
              snapshotHash,
              writtenAt: draft.updatedAt,
              workerConfirmed: true,
              inFlight: false,
              formulasPending: false,
              visible: false,
              pageErrors,
            })
            if (command !== 'wait')
              fail('驱动没有接受本机持久证据')
            posted = true
            session.facts.localSnapshotHash = snapshotHash
            session.facts.localDraftSeq = draft.draftSeq
            return `第三格已随生产捕获写成本机草稿 ${draft.draftSeq}；Worker 回复匹配同一写入者和摘要，IDB 原件独立解密为三格，云端上传仍暂停`
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      fail('第三格没有在期限内形成匹配的 Worker 写成回复与独立解密原件')
    }, LOCAL_WAIT_MS + 15_000),
    rejected: async session => check(session, 'request.holder.stale-save', async () => {
      if (!posted || document.visibilityState !== 'visible' || session.host.view().mode !== 'lost')
        fail('旧保存核对只能在本轮回到前台并失权之后进行')
      const receipt = await stale.attempt()
      session.facts.staleSaveRequestId = receipt.requestId
      session.facts.staleSaveSentAt = receipt.sentAt
      session.facts.staleSaveAnsweredAt = receipt.answeredAt
      session.facts.staleSaveStatus = receipt.status
      session.facts.staleSaveCode = receipt.code
      session.facts.staleSaveReason = receipt.reason
      return '同一旧租约和 client、全新请求标识提交已持久的三格正文，实际收到 409 EDIT_LEASE_LOST/replaced；没有重放旧成功回执'
    }),
    cleaned: async session => check(session, 'request.holder.local-cleaned', async () => {
      if (!posted || userId === undefined || typeof session.facts.copyDocumentId !== 'string')
        fail('缺少本轮本机原件或成功副本的身份')
      const until = performance.now() + 10_000
      let draft = await readSelftestDraft(userId, documentId)
      while (draft !== undefined && performance.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 100))
        draft = await readSelftestDraft(userId, documentId)
      }
      if (draft !== undefined)
        fail('副本成功之后本轮本机原件仍然存在')
      session.facts.localDraftRemaining = false
      return '副本包含第三格，原文档仍只有前两格；成功副本之后本轮原件已按产品写入者栅栏清理'
    }),
    report: async (report) => {
      try {
        if (await post('complete', { report }) !== 'wait')
          throw new Error('驱动没有接受本轮页面结果')
      }
      finally {
        dispose()
      }
    },
    dispose,
  }
}
