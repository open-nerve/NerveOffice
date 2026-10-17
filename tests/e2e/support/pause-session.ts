// 暂停测试的阶段证据；不选择进程、不发信号、不授予产品编辑权。原生身份链另由 profile-pause 校验。
import type { SelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { PauseEvent } from '../safari/profile-pause.ts'
import { z } from 'zod'
import { parseSelftestReport, selftestPassed } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { pauseEvent } from '../safari/profile-pause.ts'

const integer = z.number().int().nonnegative().safe()
const positive = integer.positive()
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const identity = { runId: z.uuid(), documentId: z.uuid(), bootId: z.uuid() }
const boot = z.strictObject({ kind: z.literal('boot'), ...identity })
const ready = z.strictObject({
  kind: z.literal('local-ready'),
  ...identity,
  userId: z.uuid(),
  clientInstanceId: z.uuid(),
  writerId: z.uuid(),
  writeEpoch: positive,
  draftSeq: positive,
  baseRevision: z.literal(3),
  contentHash: hash,
  snapshotHash: hash,
  writtenAt: positive,
  workerConfirmed: z.literal(true),
  inFlight: z.literal(false),
  formulasPending: z.literal(false),
  visible: z.literal(false),
  pageErrors: z.literal(0),
})
const message = z.discriminatedUnion('kind', [boot, ready, z.strictObject({ kind: z.literal('complete'), ...identity, report: z.unknown() }), z.strictObject({ kind: z.literal('failed'), ...identity })])
const calibration = z.strictObject({ kind: z.literal('heartbeat-calibration') })
const requiredChecks = ['first-save', 'hidden-upload', 'after-hidden-edit', 'local-ready', 'outcome', 'stale-save', 'copy', 'local-cleaned'].map(id => `request.holder.${id}`)
export type PauseLocalReady = z.infer<typeof ready>
type Phase = 'waiting' | 'preparing' | 'ready' | 'authorized' | 'paused' | 'resumed' | 'reported' | 'passed' | 'failed'

export function createLocalPauseSession(options: {
  readonly mode: 'native' | 'heartbeat-calibration'
  readonly runId: string
  readonly documentId: string
  readonly userId: string
  readonly contentHash: string
  readonly cloudHash: string
  readonly deadline: number
}) {
  let phase: Phase = 'waiting'
  const problems: string[] = []
  let lastAt = 0
  let bootAt = 0
  let bootId: string | undefined
  let local: PauseLocalReady | undefined
  let authorizedAt: number | undefined
  let stopped: Extract<PauseEvent, { kind: 'stopped' }> | undefined
  let finished: Extract<PauseEvent, { kind: 'finished' }> | undefined
  let resumedAt: number | undefined
  let reportedAt: number | undefined
  let report: SelftestReport | undefined
  function refuse(problem: string): false {
    if (phase !== 'failed' && phase !== 'passed') {
      phase = 'failed'
      problems.push(problem)
    }
    return false
  }
  function time(at: number): boolean {
    if (phase === 'failed' || phase === 'passed')
      return false
    if (!Number.isSafeInteger(at) || at <= 0 || at < lastAt || at >= options.deadline)
      return refuse('暂停会话时钟倒退、无效或超时')
    lastAt = at
    return true
  }
  return {
    receive(value: unknown, at: number): { readonly kind: 'prepare' | 'wait' | 'stop' } {
      if (!time(at))
        return { kind: 'stop' }
      const parsed = message.safeParse(value)
      if (!parsed.success || parsed.data.runId !== options.runId || parsed.data.documentId !== options.documentId) {
        refuse('页面消息格式或本轮身份不符')
        return { kind: 'stop' }
      }
      const event = parsed.data
      if (event.kind === 'boot' && phase === 'waiting') {
        bootId = event.bootId
        bootAt = at
        phase = 'preparing'
        return { kind: 'prepare' }
      }
      if (event.bootId !== bootId || event.kind === 'boot' || event.kind === 'failed') {
        refuse('页面重复启动、身份变化或报告失败')
        return { kind: 'stop' }
      }
      if (event.kind === 'local-ready' && phase === 'preparing' && event.userId === options.userId && event.contentHash === options.contentHash && event.writtenAt >= bootAt && event.writtenAt <= at) {
        local = structuredClone(event)
        phase = 'ready'
        return { kind: 'wait' }
      }
      if (event.kind === 'complete' && (phase === 'paused' || phase === 'resumed') && report === undefined) {
        try {
          const candidate = parseSelftestReport(event.report)
          const copyId = candidate.facts?.copyDocumentId
          const ended = Date.parse(candidate.finishedAt)
          const sent = candidate.facts?.staleSaveSentAt
          const answered = candidate.facts?.staleSaveAnsweredAt
          if (!selftestPassed(candidate) || candidate.scenario !== 'paused-local-holder' || candidate.documentId !== options.documentId || candidate.path !== 'lost-after-pause'
            || !requiredChecks.every(id => candidate.checks.some(check => check.id === id && check.pass))
            || candidate.facts?.localDraftRemaining !== false || candidate.facts.localSnapshotHash !== local?.snapshotHash
            || candidate.facts.staleSaveStatus !== 409 || candidate.facts.staleSaveCode !== 'EDIT_LEASE_LOST' || candidate.facts.staleSaveReason !== 'replaced'
            || !z.uuid().safeParse(candidate.facts.staleSaveRequestId).success || typeof sent !== 'number' || typeof answered !== 'number'
            || !Number.isSafeInteger(sent) || !Number.isSafeInteger(answered) || sent < (resumedAt ?? bootAt) || answered < sent || answered > ended
            || !z.uuid().safeParse(copyId).success || copyId === options.documentId || !Number.isFinite(ended) || ended < bootAt || ended > at) {
            throw new Error('页面缺少本轮失权、副本或清理事实')
          }
          report = structuredClone(candidate)
          reportedAt = at
          if (resumedAt !== undefined)
            phase = 'reported'
          return { kind: 'wait' }
        }
        catch {
          refuse('页面缺少本轮失权、副本或清理事实')
          return { kind: 'stop' }
        }
      }
      refuse('页面消息阶段或持久事实不符')
      return { kind: 'stop' }
    },
    /** 来自宿主的独立数据库读取，页面 JSON 不能调用。 */
    authorizePause(cloud: { readonly revision: number, readonly contentHash: string }, at: number): boolean {
      if (!time(at))
        return false
      if (phase !== 'ready' || cloud.revision !== 3 || cloud.contentHash !== options.cloudHash)
        return refuse('暂停之前云端没有保持已确认的两格')
      authorizedAt = at
      phase = 'authorized'
      return true
    },
    paused(proof: unknown, at: number): boolean {
      if (!time(at))
        return false
      if (phase !== 'authorized' || authorizedAt === undefined)
        return refuse('没有本机与云端前提，不能确认暂停')
      if (options.mode === 'native') {
        const parsed = pauseEvent.safeParse(proof)
        if (!parsed.success || parsed.data.kind !== 'stopped' || parsed.data.signalAt < authorizedAt || parsed.data.at < parsed.data.signalAt || parsed.data.at > at || parsed.data.monoMs < parsed.data.signalMonoMs)
          return refuse('缺少本轮有效原生停止回执')
        stopped = parsed.data
      }
      else if (!calibration.safeParse(proof).success) {
        return refuse('心跳校准不能冒称原生暂停')
      }
      phase = 'paused'
      return true
    },
    resumed(proof: unknown, at: number): boolean {
      if (!time(at))
        return false
      if (phase !== 'paused')
        return refuse('没有对应的暂停或已经恢复')
      let actualContinueAt = at
      if (options.mode === 'native') {
        const parsed = pauseEvent.safeParse(proof)
        if (!parsed.success || parsed.data.kind !== 'finished' || stopped === undefined)
          return refuse('没有有效的原生恢复回执')
        const end = parsed.data
        if (end.reason !== 'requested' || end.stopSignals !== 1 || end.continueSignals !== 1 || !end.stoppedConfirmed || !end.resumedConfirmed || end.target === null
          || !Object.entries(stopped.target).every(([key, value]) => end.target?.[key as keyof typeof end.target] === value)
          || end.continueAt === null || end.continueMonoMs === null || end.continueAt < stopped.at || end.at < end.continueAt || end.at > at
          || end.continueMonoMs < stopped.monoMs || end.monoMs < end.continueMonoMs || end.monoMs - stopped.signalMonoMs > stopped.maxPauseMs + 2000) {
          return refuse('原生恢复提前、失败、超时或目标改变')
        }
        finished = end
        actualContinueAt = end.continueAt
      }
      else if (!calibration.safeParse(proof).success) {
        return refuse('心跳校准不能冒称原生恢复')
      }
      if ((reportedAt !== undefined && reportedAt < actualContinueAt) || (report !== undefined && Number(report.facts?.staleSaveSentAt) < actualContinueAt))
        return refuse('页面在实际恢复之前已经完成')
      resumedAt = actualContinueAt
      phase = report === undefined ? 'resumed' : 'reported'
      return true
    },
    /** 必须先跑独立数据库/HTTP 判定；页面报告本身不能把会话推进为通过。 */
    finish(serverProblems: readonly string[], at: number): boolean {
      if (!time(at))
        return false
      if (phase !== 'reported' || serverProblems.length > 0)
        return refuse('页面、原生恢复或独立服务端核对未通过')
      phase = 'passed'
      return true
    },
    fail: refuse,
    snapshot: () => structuredClone({ mode: options.mode, phase, problems, bootId, bootAt, local, authorizedAt, stopped, finished, resumedAt, reportedAt, report }),
  }
}
