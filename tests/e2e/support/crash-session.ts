// 真实 Safari 与 Playwright 校准共用的驱动状态机。只接收非敏感事实；不操作页面、系统进程或数据库。
// 页面启动标识仅关联测试报告，不写入产品的原页身份、恢复记号或导航类型。

interface Boot {
  readonly kind: 'boot'
  readonly runId: string
  readonly documentId: string
  readonly bootId: string
}

export interface CrashReady extends Omit<Boot, 'kind'> {
  readonly kind: 'ready'
  readonly userId: string
  readonly clientInstanceId: string
  readonly writerId: string
  readonly draftSeq: number
  readonly baseRevision: number
  readonly contentHash: string
  readonly snapshotHash: string
  readonly workerWrites: number
  readonly inFlight: false
  readonly visible: true
  readonly pageErrors: 0
}

export interface CrashRestored extends Omit<Boot, 'kind'> {
  readonly kind: 'restored'
  readonly contentHash: string
  readonly mode: 'editing'
  readonly recoveredNotice: true
  readonly draftRemaining: false
  readonly visible: true
  readonly pageErrors: 0
}

export interface CrashServerEvidence {
  readonly revision: number
  readonly contentHash: string
  /** 仅重载之后的真实 HTTP 申请；不保留 Cookie、CSRF 或租约令牌。 */
  readonly acquires: readonly { readonly clientInstanceId: string, readonly takeover: string | null, readonly status: number }[]
  readonly saves: readonly { readonly status: number }[]
}

interface CrashOptions {
  readonly mode: 'process-kill' | 'reload-calibration'
  readonly runId: string
  readonly documentId: string
  readonly userId: string
  readonly contentHash: string
  readonly deadline: number
}

type Phase = 'waiting' | 'preparing' | 'ready' | 'signaled' | 'observing' | 'restored' | 'passed' | 'failed'
interface Command { readonly kind: 'prepare' | 'observe' | 'wait' | 'stop' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const BOOT_KEYS = ['kind', 'runId', 'documentId', 'bootId']
const READY_KEYS = [...BOOT_KEYS, 'userId', 'clientInstanceId', 'writerId', 'draftSeq', 'baseRevision', 'contentHash', 'snapshotHash', 'workerWrites', 'inFlight', 'visible', 'pageErrors']
const RESTORED_KEYS = [...BOOT_KEYS, 'contentHash', 'mode', 'recoveredNotice', 'draftRemaining', 'visible', 'pageErrors']

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isReady(value: Record<string, unknown>, options: CrashOptions): value is Record<string, unknown> & CrashReady {
  return exactKeys(value, READY_KEYS) && value.kind === 'ready'
    && value.userId === options.userId && uuid(value.clientInstanceId) && uuid(value.writerId)
    && positiveInteger(value.draftSeq) && value.baseRevision === 1 && positiveInteger(value.workerWrites)
    && value.contentHash === options.contentHash && typeof value.snapshotHash === 'string' && HASH.test(value.snapshotHash)
    && value.inFlight === false && value.visible === true && value.pageErrors === 0
}

function isRestored(value: Record<string, unknown>, options: CrashOptions): value is Record<string, unknown> & CrashRestored {
  return exactKeys(value, RESTORED_KEYS) && value.kind === 'restored'
    && value.contentHash === options.contentHash && value.mode === 'editing' && value.recoveredNotice === true
    && value.draftRemaining === false && value.visible === true && value.pageErrors === 0
}

export function createCrashSession(options: CrashOptions) {
  if (!['process-kill', 'reload-calibration'].includes(options.mode) || ![options.runId, options.documentId, options.userId].every(uuid) || !HASH.test(options.contentHash) || !positiveInteger(options.deadline))
    throw new Error('崩溃会话的测试身份、正文指纹或时限无效')
  const config = { ...options }
  let phase: Phase = 'waiting'
  let firstBoot: string | undefined
  let nextBoot: string | undefined
  let ready: CrashReady | undefined
  let restored: CrashRestored | undefined
  let lastAt = 0
  const problems: string[] = []

  const fail = (reason: string): Command => {
    if (phase !== 'failed' && phase !== 'passed') {
      problems.push(reason)
      phase = 'failed'
    }
    return { kind: 'stop' }
  }
  const live = (now: number): boolean => {
    if (phase === 'failed' || phase === 'passed')
      return false
    if (!Number.isSafeInteger(now) || now < lastAt) {
      fail('驱动时刻无效或倒退')
      return false
    }
    lastAt = now
    if (now >= config.deadline) {
      fail('超过本次崩溃复核的总时限')
      return false
    }
    return true
  }

  return {
    receive(message: unknown, now: number): Command {
      if (!live(now))
        return { kind: 'stop' }
      if (!object(message) || message.runId !== config.runId || message.documentId !== config.documentId || !uuid(message.bootId))
        return fail('页面报告的测试身份无效')
      if (message.kind === 'boot' && exactKeys(message, BOOT_KEYS)) {
        if (phase === 'waiting') {
          firstBoot = message.bootId
          phase = 'preparing'
          return { kind: 'prepare' }
        }
        if (phase === 'preparing' && message.bootId === firstBoot)
          return { kind: 'prepare' }
        if (phase === 'ready' && message.bootId === firstBoot)
          return { kind: 'wait' }
        if (phase === 'signaled' && message.bootId !== firstBoot) {
          nextBoot = message.bootId
          phase = 'observing'
          return { kind: 'observe' }
        }
        if (phase === 'observing' && message.bootId === nextBoot)
          return { kind: 'observe' }
        return fail('重复页面、提前重载或旧页面冒充崩溃后的新页面')
      }
      if (message.kind === 'ready' && message.bootId === firstBoot && isReady(message, config)) {
        if (phase === 'ready' && ready !== undefined && READY_KEYS.every(key => message[key] === (ready as unknown as Record<string, unknown>)[key]))
          return { kind: 'wait' }
        if (phase !== 'preparing')
          return fail('持久就绪报告到达时序不符')
        ready = Object.freeze({ ...message })
        phase = 'ready'
        return { kind: 'wait' }
      }
      if (message.kind === 'restored' && message.bootId === nextBoot && isRestored(message, config)) {
        if (phase !== 'observing')
          return fail('恢复报告到达时序不符')
        restored = Object.freeze({ ...message })
        phase = 'restored'
        return { kind: 'wait' }
      }
      return fail('页面证据不满足真实持久或自动恢复前提')
    },
    /** 只能由已确认实际发送信号的驱动调用，HTTP 控制路径没有这个操作。 */
    signaled(now: number): boolean {
      if (!live(now) || phase !== 'ready')
        return false
      if (config.mode !== 'process-kill') {
        fail('普通刷新校准不能标成真实进程崩溃')
        return false
      }
      phase = 'signaled'
      return true
    },
    /** 仅 Playwright 校准用，由真实导航请求证明已开始重载；报告明确保留校准类型。 */
    reloadedForCalibration(now: number): boolean {
      if (!live(now) || phase !== 'ready')
        return false
      if (config.mode !== 'reload-calibration') {
        fail('真实崩溃场景不能用普通刷新代替')
        return false
      }
      phase = 'signaled'
      return true
    },
    cancel(reason: string): void {
      fail(reason)
    },
    finish(server: CrashServerEvidence, now: number): readonly string[] {
      if (!live(now))
        return [...problems]
      if (phase !== 'restored' || ready === undefined) {
        fail('缺少完整的崩溃后页面恢复报告')
        return [...problems]
      }
      if (server.revision !== 2 || server.contentHash !== config.contentHash)
        problems.push('服务端正文或修订号不符，应当只新增一次修订')
      const acquire = server.acquires[0]
      if (server.acquires.length !== 1 || acquire?.clientInstanceId !== ready.clientInstanceId || acquire.takeover !== null || acquire.status !== 201)
        problems.push('重载后没有以原 clientInstanceId 恰好普通申请一次')
      if (server.saves.length !== 1 || server.saves[0]?.status !== 200)
        problems.push('重载后没有恰好完成一次真实保存')
      phase = problems.length === 0 ? 'passed' : 'failed'
      return [...problems]
    },
    snapshot: () => ({ mode: config.mode, phase, ready, restored, problems: [...problems] }),
  }
}
