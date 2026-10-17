// 自然隐藏只复用暂停场景的持久草稿准备，不调用或伪造 STOP/CONT 阶段。
import type { SelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { z } from 'zod'
import { parseSelftestReport, selftestPassed } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { createLocalPauseSession } from './pause-session.ts'

const complete = z.strictObject({ kind: z.literal('complete'), runId: z.uuid(), documentId: z.uuid(), bootId: z.uuid(), report: z.unknown() })
const windowQuery = z.strictObject({ kind: z.literal('window-state'), runId: z.uuid(), documentId: z.uuid(), bootId: z.uuid() })
const commonChecks = ['first-save', 'hidden-upload', 'after-hidden-edit', 'local-ready', 'outcome']

export function createNaturalObservation(options: Omit<Parameters<typeof createLocalPauseSession>[0], 'mode'> & { readonly waitForWindow?: boolean }) {
  const preparation = createLocalPauseSession({ ...options, mode: 'native' })
  const problems: string[] = []
  let report: SelftestReport | undefined
  let diagnostic: Pick<SelftestReport, 'scenario' | 'documentId' | 'finishedAt' | 'visibility' | 'checks' | 'pageErrors' | 'consoleErrors' | 'failure'> | undefined
  let reportedAt: number | undefined
  let lastAt = 0
  let windowReadyAt: number | undefined
  const fail = (): { readonly kind: 'stop' } => {
    if (problems.length === 0)
      problems.push('自然观察消息缺少本轮身份、持久草稿或完整页面结果')
    return { kind: 'stop' }
  }
  return {
    receive(value: unknown, at: number): { readonly kind: 'prepare' | 'prepare-window' | 'window-ready' | 'wait' | 'stop' } {
      if (problems.length > 0 || report !== undefined || !Number.isSafeInteger(at) || at <= 0 || at < lastAt || at >= options.deadline)
        return fail()
      lastAt = at
      const window = windowQuery.safeParse(value)
      if (window.success) {
        const state = preparation.snapshot()
        if (!options.waitForWindow || state.phase !== 'preparing' || window.data.runId !== options.runId || window.data.documentId !== options.documentId || window.data.bootId !== state.bootId)
          return fail()
        return { kind: windowReadyAt === undefined ? 'wait' : 'window-ready' }
      }
      const parsed = complete.safeParse(value)
      if (!parsed.success) {
        const response = preparation.receive(value, at)
        const local = preparation.snapshot().local
        if (response.kind === 'stop' || (options.waitForWindow && local !== undefined && (windowReadyAt === undefined || local.writtenAt < windowReadyAt)))
          return fail()
        return response.kind === 'prepare' && options.waitForWindow ? { kind: 'prepare-window' } : response
      }
      const state = preparation.snapshot()
      const event = parsed.data
      if (event.runId !== options.runId || event.documentId !== options.documentId || event.bootId !== state.bootId)
        return fail()
      try {
        const candidate = parseSelftestReport(event.report)
        const facts = candidate.facts
        const ended = Date.parse(candidate.finishedAt)
        if (candidate.scenario !== 'paused-local-holder' || candidate.documentId !== options.documentId || !Number.isFinite(ended) || ended < state.bootAt || ended > at)
          return fail()
        // 失败页的原因也须留档；只复制已核对归属的诊断字段，不保存任意扩展字段或正文。
        diagnostic = structuredClone({
          scenario: candidate.scenario,
          documentId: candidate.documentId,
          finishedAt: candidate.finishedAt,
          visibility: candidate.visibility,
          checks: candidate.checks.map(({ id, pass, detail, ms }) => ({ id, pass, detail, ms })),
          pageErrors: candidate.pageErrors,
          consoleErrors: candidate.consoleErrors,
          failure: candidate.failure,
        })
        if (state.phase !== 'ready' || state.local === undefined)
          return fail()
        const needed = [...commonChecks, ...(candidate.path === 'handed-over' ? ['server'] : ['stale-save', 'copy', 'local-cleaned'])]
        if (!selftestPassed(candidate) || candidate.scenario !== 'paused-local-holder' || candidate.documentId !== options.documentId
          || !['handed-over', 'lost-after-pause'].includes(candidate.path ?? '') || !Number.isFinite(ended) || ended < state.bootAt || ended > at
          || !needed.every(id => candidate.checks.some(check => check.id === `request.holder.${id}` && check.pass))
          || facts?.localSnapshotHash !== state.local.snapshotHash || facts.localDraftSeq !== state.local.draftSeq) {
          return fail()
        }
        if (candidate.path === 'lost-after-pause') {
          const sent = facts.staleSaveSentAt
          const answered = facts.staleSaveAnsweredAt
          if (facts.localDraftRemaining !== false || !z.uuid().safeParse(facts.copyDocumentId).success || facts.copyDocumentId === options.documentId
            || !z.uuid().safeParse(facts.staleSaveRequestId).success || facts.staleSaveStatus !== 409 || facts.staleSaveCode !== 'EDIT_LEASE_LOST' || facts.staleSaveReason !== 'replaced'
            || typeof sent !== 'number' || typeof answered !== 'number' || !Number.isSafeInteger(sent) || !Number.isSafeInteger(answered)
            || sent < state.local.writtenAt || answered < sent || answered > ended) {
            return fail()
          }
        }
        report = structuredClone(candidate)
        reportedAt = at
        return { kind: 'wait' }
      }
      catch {
        return fail()
      }
    },
    /** 仅宿主的真实窗口回执能调用；页面查询不能推进这一条件。 */
    confirmWindowReady(at: number): boolean {
      if (!options.waitForWindow || problems.length > 0 || preparation.snapshot().phase !== 'preparing' || windowReadyAt !== undefined || !Number.isSafeInteger(at) || at < lastAt || at >= options.deadline) {
        fail()
        return false
      }
      lastAt = at
      windowReadyAt = at
      return true
    },
    snapshot: () => {
      const state = preparation.snapshot()
      return structuredClone({ mode: 'natural-observation', phase: problems.length > 0 ? 'failed' : report !== undefined ? 'reported' : state.phase, problems, bootId: state.bootId, bootAt: state.bootAt, local: state.local, report, diagnostic, reportedAt, windowReadyAt })
    },
  }
}
