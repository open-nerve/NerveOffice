import type { LocalSaveConfig, LocalSaveIdentity, LocalSaveSample } from '../../../apps/web/src/editor/testing/local-save-report.ts'
import type { SelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { z } from 'zod'
import { localSavePrefixProblems, localSaveProblems, localSaveTargets, readLocalSaveSample } from '../../../apps/web/src/editor/testing/local-save-report.ts'
import { parseSelftestReport, selftestPassed } from '../../../apps/web/src/editor/testing/selftest-report.ts'

const integer = z.number().int().nonnegative().safe()
const positive = integer.positive()
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const common = { runId: z.uuid(), documentId: z.uuid(), bootId: z.uuid() }
const configSchema = z.strictObject({ sample: z.enum(['1m', '5m', 'perf-50k']), network: z.enum(['online', 'offline']), rounds: positive.min(2).max(20) })
const readySchema = z.strictObject({ ...common, kind: z.literal('ready'), userId: z.uuid(), writerId: z.uuid(), writeEpoch: positive, lastDraftSeq: integer, baseRevision: positive })
const message = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('boot') }),
  readySchema,
  z.strictObject({ ...common, kind: z.literal('network-state') }),
  z.strictObject({ ...common, kind: z.literal('sample'), sample: z.unknown() }),
  z.strictObject({ ...common, kind: z.literal('round-state'), round: positive }),
  z.strictObject({ ...common, kind: z.literal('complete'), report: z.unknown(), measurement: z.strictObject({ config: configSchema, samples: z.array(z.unknown()).max(20) }) }),
  z.strictObject({ ...common, kind: z.literal('failed') }),
])
type Phase = 'waiting' | 'preparing' | 'ready' | 'measuring' | 'checking' | 'reported' | 'passed' | 'failed'

function safePageReport(value: unknown): SelftestReport | undefined {
  try {
    const { format, scenario, documentId, userAgent, startedAt, finishedAt, page, checks, visibility, pageErrors, consoleErrors, ignoredNotices, failure, facts } = parseSelftestReport(value)
    const diagnostics = Object.fromEntries(['localSaveAttemptRound', 'localSaveWallStartedAt', 'localSaveStartedAt', 'localSaveSavedAt', 'localSaveEditorSeq', 'localSaveDraftSeq', 'localSaveDraftUpdatedAt'].flatMap((field) => {
      const value = facts?.[field]
      return typeof value === 'number' && Number.isFinite(value) ? [[field, value]] : []
    }))
    return structuredClone({ format, scenario, documentId, userAgent, startedAt, finishedAt, page, checks, visibility, pageErrors, consoleErrors, ignoredNotices, failure, facts: { ...diagnostics, localSaveTransportFailed: facts?.localSaveTransportFailed === true } })
  }
  catch { return undefined }
}

export interface LocalSaveSessionOptions {
  readonly runId: string
  readonly documentId: string
  readonly userId: string
  readonly config: LocalSaveConfig
  readonly baseRevision: number
  readonly baseHash: string
  readonly deadline: number
}
export interface LocalSaveNetworkProof {
  readonly cutAt: number | null
  readonly inFlight: number
  readonly clientInstanceId: string
  readonly revision: number
  readonly contentHash: string
}
export function createLocalSaveSession(options: LocalSaveSessionOptions) {
  configSchema.parse(options.config)
  let phase: Phase = 'waiting'
  const problems: string[] = []
  const samples: LocalSaveSample[] = []
  const confirmations: { round: number, at: number }[] = []
  let lastAt = 0
  let bootId: string | undefined
  let readyAt = 0
  let ready: z.infer<typeof readySchema> | undefined
  let networkAt = 0
  let network: LocalSaveNetworkProof | undefined
  let identity: LocalSaveIdentity | undefined
  let report: SelftestReport | undefined
  let pageReport: SelftestReport | undefined
  const refuse = (problem: string): false => {
    if (phase !== 'failed' && phase !== 'passed') {
      problems.push(problem)
      phase = 'failed'
    }
    return false
  }
  const time = (at: number): boolean => {
    if (phase === 'failed' || phase === 'passed')
      return false
    if (!Number.isSafeInteger(at) || at <= 0 || at < lastAt || at >= options.deadline)
      return refuse('测量会话时钟倒退、无效或超时')
    lastAt = at
    return true
  }
  return {
    receive(value: unknown, at: number): { kind: 'stop' | 'wait' | 'prepare' | 'measure' | 'next', config?: LocalSaveConfig, clientInstanceId?: string } {
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
        phase = 'preparing'
        return { kind: 'prepare', config: { ...options.config } }
      }
      if (event.kind === 'boot' || event.kind === 'failed' || event.bootId !== bootId) {
        refuse('页面重复启动、身份变化或报告失败')
        return { kind: 'stop' }
      }
      if (event.kind === 'complete')
        pageReport = safePageReport(event.report)
      if (event.kind === 'ready' && phase === 'preparing' && event.userId === options.userId && event.baseRevision === options.baseRevision) {
        ready = event
        readyAt = at
        phase = 'ready'
        return { kind: 'wait' }
      }
      if (event.kind === 'network-state' && (phase === 'ready' || phase === 'measuring'))
        return network === undefined ? { kind: 'wait' } : { kind: 'measure', clientInstanceId: network.clientInstanceId }
      if (event.kind === 'sample' && phase === 'measuring' && identity !== undefined && ready !== undefined) {
        const sample = readLocalSaveSample(event.sample)
        if (sample !== undefined && localSavePrefixProblems([...samples, sample], options.config, identity).length === 0
          && sample.wallStartedAt >= networkAt && sample.checkedAt <= at && sample.draftSeq > ready.lastDraftSeq
          && (samples.length > 0 || sample.baseRevision === options.baseRevision)) {
          samples.push(structuredClone(sample))
          phase = 'checking'
          return { kind: 'wait' }
        }
      }
      if (event.kind === 'round-state' && event.round === samples.length && (phase === 'checking' || phase === 'measuring'))
        return { kind: phase === 'checking' ? 'wait' : 'next' }
      if (event.kind === 'complete' && phase === 'measuring' && identity !== undefined && samples.length === options.config.rounds && confirmations.length === samples.length) {
        try {
          const candidate = pageReport
          if (candidate === undefined)
            throw new Error('报告格式无效')
          const finished = Date.parse(candidate.finishedAt)
          const checks = ['local-save.ready', ...samples.map(sample => `local-save.round.${sample.round}`), 'local-save.targets']
          if (!selftestPassed(candidate) || candidate.scenario !== `local-save-${options.config.network}` || candidate.documentId !== options.documentId
            || candidate.visibility.some(entry => entry.endsWith(' hidden')) || (options.config.network === 'offline' && candidate.facts?.localSaveTransportFailed !== true)
            || !checks.every(id => candidate.checks.filter(check => check.id === id && check.pass).length === 1)
            || !Number.isFinite(finished) || finished < (samples.at(-1)?.checkedAt ?? Infinity) || finished > at
            || Object.entries(options.config).some(([key, expected]) => event.measurement.config[key as keyof LocalSaveConfig] !== expected)
            || localSaveProblems(event.measurement.samples, options.config, identity).length > 0 || localSaveTargets(samples, options.config).length > 0
            || !samples.every((sample, index) => {
              const final = readLocalSaveSample(event.measurement.samples[index])
              return final !== undefined && Object.entries(sample).every(([key, expected]) => final[key as keyof LocalSaveSample] === expected)
            })) {
            throw new Error('报告不完整')
          }
          // 只保留已知报告字段；未知顶层内容不进入原件。
          report = structuredClone(candidate)
          phase = 'reported'
          return { kind: 'wait' }
        }
        catch {
          refuse('缺少本轮完整报告或样本被改写')
          return { kind: 'stop' }
        }
      }
      refuse('页面消息阶段或逐轮持久事实不符')
      return { kind: 'stop' }
    },
    /** 仅宿主完成 API 排空/切断与独立数据库读取后调用。 */
    confirmNetwork(proof: LocalSaveNetworkProof, at: number): boolean {
      if (!time(at))
        return false
      if (phase !== 'ready' || ready === undefined || proof.inFlight !== 0 || !z.uuid().safeParse(proof.clientInstanceId).success
        || proof.revision !== options.baseRevision || !hash.safeParse(proof.contentHash).success || proof.contentHash !== options.baseHash
        || (options.config.network === 'online' ? proof.cutAt !== null : !Number.isSafeInteger(proof.cutAt) || proof.cutAt === null || proof.cutAt < readyAt || proof.cutAt > at)) {
        return refuse('网络排空、切断或数据库基线未满足')
      }
      network = { ...proof }
      networkAt = at
      identity = { userId: ready.userId, documentId: options.documentId, writerId: ready.writerId, writeEpoch: ready.writeEpoch, writtenBy: proof.clientInstanceId }
      phase = 'measuring'
      return true
    },
    confirmRound(round: number, independentProblems: readonly string[], at: number): boolean {
      if (!time(at))
        return false
      if (phase !== 'checking' || round !== samples.length || confirmations.length !== round - 1 || independentProblems.length > 0)
        return refuse('逐轮数据库或传输核对未通过')
      confirmations.push({ round, at })
      phase = 'measuring'
      return true
    },
    finish(independentProblems: readonly string[], at: number): boolean {
      if (!time(at))
        return false
      if (phase !== 'reported' || independentProblems.length > 0)
        return refuse('完整页面结果或最终独立核对未通过')
      phase = 'passed'
      return true
    },
    fail: refuse,
    snapshot: () => structuredClone({ phase, problems, bootId, ready, readyAt, network, networkAt, identity, samples, confirmations, report, pageReport }),
  }
}
