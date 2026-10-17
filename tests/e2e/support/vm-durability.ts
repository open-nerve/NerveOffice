// 仅处理实验事实，不发系统信号。append 的完成契约是宿主 journal 已 fsync。
import { freezeVmJournal } from './vm-journal-barrier.ts'
import { isVmBoot, isVmRebootProof } from './vm-reboot.ts'

export type VmDurability = 'strict' | 'default'
export type VmExperimentMode = 'vm-power-cut' | 'reload-calibration' | 'control'
type ActualDurability = VmDurability | 'relaxed'
type Phase = 'waiting' | 'writing' | 'ready' | 'frozen' | 'recovering' | 'reading' | 'passed' | 'lost' | 'unreadable' | 'failed'
interface Command { readonly kind: 'write' | 'wait' | 'read' | 'done' | 'stop' }

export interface VmBoot {
  readonly resourceId: string
  readonly pid: number
  readonly uid: number
  readonly startedAt: string
  readonly guestBootId: string
  readonly disk: { readonly path: string, readonly device: number, readonly inode: number }
}

export interface VmCompleted {
  readonly kind: 'completed'
  readonly runId: string
  readonly bootId: string
  readonly requested: VmDurability
  readonly actual: ActualDurability
  readonly seq: number
  readonly digest: string
  readonly completedAt: number
}

interface VmStored {
  readonly runId: string
  readonly requested: VmDurability
  readonly actual: ActualDurability
  readonly seq: number
  readonly digest: string
  readonly bodyDigest: string
}

interface VmRead {
  readonly kind: 'read'
  readonly runId: string
  readonly bootId: string
  readonly record: VmStored | null
}

interface VmFailure {
  readonly kind: 'failed'
  readonly runId: string
  readonly bootId: string
  readonly stage: string
  readonly errorName: string
}
export const VM_FAILURE_NAMES = ['AbortError', 'ConstraintError', 'DataError', 'InvalidAccessError', 'InvalidStateError', 'NotFoundError', 'NotReadableError', 'QuotaExceededError', 'ReadOnlyError', 'SecurityError', 'TransactionInactiveError', 'UnknownError', 'VersionError', 'DataCloneError', 'TimeoutError', 'NetworkError', 'OperationError', 'Error', 'TypeError', 'UnexpectedError'] as const
const FAILURE_STAGES = ['control', 'write-open', 'write-hash', 'write-transaction', 'read-open', 'read-transaction', 'read-hash']

export interface VmFrozenReceipt {
  readonly runId: string
  readonly mode: VmExperimentMode
  readonly completed: VmCompleted
  readonly before: VmBoot | undefined
  readonly journaledAt: number
}

interface Options {
  readonly runId: string
  readonly mode: VmExperimentMode
  readonly durability: VmDurability
  readonly cutAtSeq: number
  readonly before?: VmBoot
  readonly digestFor: (seq: number) => string
  readonly append: (event: unknown) => Promise<void>
  readonly now?: () => number
}

const frozenReceipts = new WeakSet<object>()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const BOOT_KEYS = ['kind', 'runId', 'bootId']
const STORED_KEYS = ['runId', 'requested', 'actual', 'seq', 'digest', 'bodyDigest']
const COMPLETED_KEYS = [...BOOT_KEYS, 'requested', 'actual', 'seq', 'digest', 'completedAt']

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** 只认本模块在 journal 完成之后实际签发的同一对象；JSON 或 snapshot 的副本无资格。 */
export function isVmFrozenReceipt(value: unknown): value is VmFrozenReceipt {
  return object(value) && frozenReceipts.has(value)
}

export function createVmDurabilityRound(options: Options) {
  if (!UUID.test(options.runId) || !['vm-power-cut', 'reload-calibration', 'control'].includes(options.mode)
    || !['strict', 'default'].includes(options.durability) || !positive(options.cutAtSeq)
    || (options.mode === 'vm-power-cut' && !isVmBoot(options.before))) {
    throw new Error('VM 实验配置或启动事实无效')
  }
  const config = { ...options, before: options.before === undefined ? undefined : structuredClone(options.before) }
  const now = options.now ?? Date.now
  let phase: Phase = 'waiting'
  let firstBoot: string | undefined
  let nextBoot: string | undefined
  let completed: VmCompleted | undefined
  let recovered: VmRead | undefined
  let readFailure: VmFailure | undefined
  let frozen: VmFrozenReceipt | undefined
  const problems: string[] = []
  let queue = Promise.resolve()

  async function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work)
    queue = result.then(() => {}, () => {})
    return result
  }

  function fail(reason: string, kind: 'failed' | 'lost' | 'unreadable' = 'failed'): Command {
    problems.push(reason)
    phase = kind
    return { kind: 'stop' }
  }

  async function record(event: unknown): Promise<boolean> {
    try {
      await config.append(structuredClone(event))
      return true
    }
    catch {
      fail('宿主 journal 未完成落盘')
      return false
    }
  }

  function validCompleted(message: Record<string, unknown>): message is Record<string, unknown> & VmCompleted {
    return exact(message, COMPLETED_KEYS) && message.kind === 'completed'
      && message.requested === config.durability && ['strict', 'default', 'relaxed'].includes(message.actual as string)
      && (config.durability !== 'strict' || message.actual === 'strict')
      && positive(message.seq) && message.seq === (completed?.seq ?? 0) + 1
      && typeof message.digest === 'string' && HASH.test(message.digest) && message.digest === config.digestFor(message.seq)
      && typeof message.completedAt === 'number' && Number.isFinite(message.completedAt) && message.completedAt > 0
  }

  function safeRead(message: Record<string, unknown>): message is Record<string, unknown> & VmRead {
    if (!exact(message, [...BOOT_KEYS, 'record']) || message.kind !== 'read')
      return false
    const item = message.record
    return item === null || (object(item) && exact(item, STORED_KEYS) && typeof item.runId === 'string' && UUID.test(item.runId)
      && ['strict', 'default'].includes(item.requested as string) && ['strict', 'default', 'relaxed'].includes(item.actual as string)
      && positive(item.seq) && typeof item.digest === 'string' && HASH.test(item.digest)
      && typeof item.bodyDigest === 'string' && HASH.test(item.bodyDigest))
  }

  async function beginReading(): Promise<boolean> {
    if (phase !== 'frozen' || frozen === undefined)
      return false
    if (!await record({ kind: 'recovery-started', at: now(), mode: config.mode }))
      return false
    phase = 'recovering'
    return true
  }

  return {
    receive: async (input: unknown): Promise<Command> => {
      // 在首次 await 之前复制，调用者不能在排队中改变证据。
      const message: unknown = structuredClone(input)
      return serial(async () => {
        if (!object(message) || message.runId !== config.runId || typeof message.bootId !== 'string' || !UUID.test(message.bootId))
          return { kind: 'stop' }
        if (message.kind === 'failed' && ((phase === 'writing' && message.bootId === firstBoot) || (phase === 'reading' && message.bootId === nextBoot))) {
          if (!exact(message, [...BOOT_KEYS, 'stage', 'errorName']) || !FAILURE_STAGES.includes(message.stage as string)
            || !VM_FAILURE_NAMES.includes(message.errorName as typeof VM_FAILURE_NAMES[number])) {
            return fail('页面错误报告的阶段、名称或字段无效')
          }
          const failure = structuredClone(message) as unknown as VmFailure
          if (!await record({ kind: 'page-failure', failure, receivedAt: now() }))
            return { kind: 'stop' }
          if (phase === 'reading' && ['read-open', 'read-transaction'].includes(failure.stage)) {
            readFailure = failure
            return fail(`浏览器存储无法读取：${failure.stage}/${failure.errorName}`, 'unreadable')
          }
          return fail(`页面操作失败：${failure.stage}/${failure.errorName}`)
        }
        if (message.kind === 'boot' && exact(message, BOOT_KEYS)) {
          if (phase === 'waiting') {
            if (!await record({ kind: 'boot', ...message, at: now() }))
              return { kind: 'stop' }
            firstBoot = message.bootId
            phase = 'writing'
            return { kind: 'write' }
          }
          if (phase === 'recovering' && message.bootId !== firstBoot) {
            if (!await record({ kind: 'recovery-boot', bootId: message.bootId, at: now() }))
              return { kind: 'stop' }
            nextBoot = message.bootId
            phase = 'reading'
            return { kind: 'read' }
          }
          return { kind: 'stop' }
        }
        if (phase === 'writing' && message.bootId === firstBoot) {
          if (!validCompleted(message))
            return fail('完成报告的字段、持久性、序号或摘要不符')
          if (!await record({ kind: 'completed', completed: message, receivedAt: now() }))
            return { kind: 'stop' }
          completed = structuredClone(message)
          if (completed.seq === config.cutAtSeq) {
            phase = 'ready'
            return { kind: 'wait' }
          }
          return { kind: 'write' }
        }
        if (phase === 'reading' && message.bootId === nextBoot) {
          if (!safeRead(message))
            return fail('回读报告格式无效')
          if (!await record({ kind: 'read', recovered: message, receivedAt: now() }))
            return { kind: 'stop' }
          recovered = structuredClone(message)
          const item = message.record
          if (item === null || completed === undefined || item.runId !== config.runId || item.requested !== config.durability
            || item.actual !== completed.actual || item.seq < completed.seq
            || item.digest !== config.digestFor(item.seq) || item.bodyDigest !== item.digest) {
            return fail('原磁盘回读缺失、序号回退或正文损坏', 'lost')
          }
          phase = 'passed'
          return { kind: 'done' }
        }
        return { kind: 'stop' }
      })
    },
    freeze: async (): Promise<VmFrozenReceipt | undefined> => serial(async () => {
      if (frozen !== undefined)
        return frozen
      if (phase !== 'ready' || completed === undefined)
        return undefined
      try {
        frozen = await freezeVmJournal({ kind: 'frozen', runId: config.runId, completed, before: config.before, mode: config.mode, at: now() }, async (event) => {
          if (!await record(event))
            throw new Error('冻结记录未落盘')
        }, now)
      }
      catch {
        fail('宿主冻结 journal 未完成落盘')
        return undefined
      }
      if (config.mode === 'vm-power-cut')
        frozenReceipts.add(frozen)
      phase = 'frozen'
      return frozen
    }),
    beginRecovery: async (input: unknown): Promise<boolean> => {
      const proof: unknown = structuredClone(input)
      return serial(async () => {
        if (config.mode !== 'vm-power-cut')
          return false
        if (phase !== 'frozen' || frozen === undefined || config.before === undefined)
          return false
        if (!isVmRebootProof(proof, config.before)) {
          fail('没有同磁盘、原 VM 突停与客体重新启动的完整证明')
          return false
        }
        if (!await record({ kind: 'vm-reboot', proof, at: now() }))
          return false
        return beginReading()
      })
    },
    beginCalibrationRecovery: async (): Promise<boolean> => serial(async () => {
      if (config.mode === 'vm-power-cut')
        return false
      return beginReading()
    }),
    snapshot: () => structuredClone({ runId: config.runId, mode: config.mode, durability: config.durability, phase, completed, recovered, readFailure, frozen, problems }),
  }
}
