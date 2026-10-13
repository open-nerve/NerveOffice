// 一次编辑会话的持久写入资格。宿主只管放置；此处唯一负责暂停、核对租约和登记，调用方拿不到绕过资格检查的 DraftWriter。
import type { LocalKeyHandle } from '../../../shared/outbox/draft-codec.ts'
import type { MirrorStatus } from '../../../shared/outbox/draft-mirror.ts'
import type { DraftObservation } from '../../../shared/outbox/draft-observation.ts'
import type { DraftKey, InFlightSave } from '../../../shared/outbox/draft-record.ts'
import type { AdoptionCapture, CaptureToWrite, CaptureWritten, ConfirmResult, DedupeKey, DraftRead, KeyChange, ObservedRemoveResult, ObserveResult, OpenedRecord, RecoveryProblem, ResealResult } from '../../../shared/outbox/draft-writer.ts'
import type { FailureDescription } from '../../../shared/outbox/failure.ts'
import type { LocalKeyKeeper, LocalKeyProblem } from '../../../shared/outbox/local-key.ts'
import type { PersistOutcome } from '../../../shared/outbox/storage-status.ts'
import type { WriterIdentity } from '../../../shared/outbox/writer-fence.ts'
import type { LeaseClock, LeaseVerdict } from '../edit-lease.ts'
import type { DraftMemoryReason } from '../working-draft.ts'
import type { OutboxHost } from './outbox-host.ts'
import { describeFailure } from '../../../shared/outbox/failure.ts'
import { requestPersistence } from '../../../shared/outbox/storage-status.ts'
import { isSameWriter } from '../../../shared/outbox/writer-fence.ts'
import { createOutboxHost } from './outbox-host.ts'

/** 准备结果只保留事实；登记暂时读出的正文交还 GC，不能留在 state 或已完成的 ready Promise 里。 */
export type ExistingDraftSummary = Exclude<OpenedRecord, { readonly kind: 'draft' }> | Omit<Extract<OpenedRecord, { readonly kind: 'draft' }>, 'gzip'>

export type OutboxPreparation
  = | { readonly kind: 'ready', readonly writer: WriterIdentity, readonly lastDraftSeq: number, readonly mirror: MirrorStatus, readonly hostKind: OutboxHost['kind'] }
    | { readonly kind: 'memory', readonly reason: DraftMemoryReason, readonly existing?: ExistingDraftSummary, readonly lastDraftSeq?: number, readonly keyProblem?: LocalKeyProblem, readonly problem?: RecoveryProblem, readonly verdict?: LeaseVerdict, readonly recordKnown?: true }
    | { readonly kind: 'lost', readonly verdict: Extract<LeaseVerdict, { readonly kind: 'ended' | 'superseded' }> }
    | { readonly kind: 'disposed' }

export type OutboxSessionState = OutboxPreparation | { readonly kind: 'preparing' }
export type SessionCapture = Omit<CaptureToWrite, 'key' | 'writer' | 'adoptSeq'>
export type SessionAdoption = Omit<AdoptionCapture, 'key' | 'writer'>

export interface OutboxSession {
  /** 初次准备的结果；对象同步返回，使准备过程也可暂停/销毁。 */
  readonly ready: () => Promise<OutboxPreparation>
  readonly view: () => OutboxSessionState
  readonly persistence: () => PersistOutcome | undefined
  readonly subscribe: (listener: () => void) => () => void
  readonly write: (capture: SessionCapture) => Promise<CaptureWritten>
  readonly markInFlight: (inFlight: InFlightSave) => Promise<ResealResult>
  readonly confirm: (confirmedSeq: number, revision: number) => Promise<ConfirmResult>
  /** 暂停仍可临时读回内容给内存退路；resume 会关闭旧宿主，调用方须先完成需要的读取。 */
  readonly read: () => Promise<DraftRead>
  /** 宿主失效时临时建一只读宿主；不登记/force、不改变写入资格，读完即关。内容身份仍由来源核对。 */
  readonly readRecovered: () => Promise<DraftRead>
  /** 显式恢复模式在登记后观察，普通写入仍关闭。凭证只属于本次会话/宿主，不接受复制字段。 */
  readonly observeRecovery: () => Promise<ObserveResult>
  readonly adopt: (observation: DraftObservation, capture: SessionAdoption) => Promise<CaptureWritten>
  /** 旧请求已确认、放弃等决定后的条件清理；成功后登记已成墓碑，需重新准备才能编辑。 */
  readonly removeRecovery: (observation: DraftObservation) => Promise<ObservedRemoveResult>
  readonly seedDigest: (seed: DedupeKey | undefined) => Promise<void>
  readonly setKey: (key: LocalKeyHandle | undefined) => Promise<KeyChange>
  /** 原写入资格仍有效时在原宿主取新钥，保留其重封缓存；没有可续用宿主才交回 no-host。 */
  readonly refreshKey: () => Promise<KeyChange | { readonly kind: 'no-host' }>
  /** 同步停写，返回只绑定原宿主的收尾；来源读回正文之后才调用，不影响新一轮宿主。 */
  readonly suspend: () => () => void
  /** 同步停准备、写入和 recovery；保留原宿主供最后读回。返回的幂等收尾只关闭这个旧宿主，不能影响之后 resume 的宿主。 */
  readonly beginKeyDiscard: () => () => void
  /** 每次调用至多准备一次，不自行重试；并发调用共用正在进行的准备。 */
  readonly resume: () => Promise<OutboxPreparation>
  readonly dispose: () => void
}

export interface OutboxSessionOptions {
  readonly enabled: boolean
  readonly recoverExisting?: boolean
  readonly clock?: LeaseClock
  readonly key: DraftKey
  readonly writeEpoch: number | (() => number)
  readonly newWriterId: () => string
  readonly keeper: LocalKeyKeeper
  readonly confirm: () => Promise<LeaseVerdict>
  readonly host?: (signal: AbortSignal) => Promise<OutboxHost>
  readonly persist?: () => Promise<PersistOutcome>
  readonly supported?: () => boolean
  /** 外层编辑会话仍是这一代，不能只看此对象是否显式 dispose。 */
  readonly still: () => boolean
}

interface PreparedHost {
  readonly host: OutboxHost
  readonly writer: WriterIdentity
  installedKey: LocalKeyHandle | undefined
  recovering?: boolean
}

interface PreparationRun {
  readonly writeEpoch: number
  readonly generation: number
  readonly controller: AbortController
  readonly promise: Promise<OutboxPreparation>
  host: OutboxHost | undefined
  stopped: OutboxPreparation | undefined
  /** 本轮中途已见原件；后续换钥/重登失败不抹去，不含旧钥、正文或观察凭证。 */
  recordKnown: boolean
}

const INACTIVE: FailureDescription = { name: 'OutboxSessionInactive', message: '本机草稿写入资格已暂停、失效或尚未准备好' }
/** 旧页失锁后须先读回正文再关闭镜像句柄；只等待这种短暂交接，不延长本人交接/单请求看门狗。 */
const RECOVERY_MIRROR_WAIT_MS = 2_000
const RECOVERY_MIRROR_RECHECK_MS = 500
// 发件箱也被独立探针引用；不能运行时引入租约/API/zod，打乱入口关闭 JIT 的顺序。
const recoveryClock: LeaseClock = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

function supported(): boolean {
  try {
    return typeof globalThis.navigator?.locks?.request === 'function' && globalThis.crypto?.subtle !== undefined
  }
  catch {
    return false
  }
}

function verdictResult(verdict: LeaseVerdict): OutboxPreparation | undefined {
  switch (verdict.kind) {
    case 'current': return undefined
    case 'unknown': return { kind: 'memory', reason: 'fenced', verdict }
    case 'ended':
    case 'superseded': return { kind: 'lost', verdict }
  }
}

export function prepareOutboxSession(options: OutboxSessionOptions): OutboxSession {
  const clock = options.clock ?? recoveryClock
  let state: OutboxSessionState = { kind: 'preparing' }
  let active: PreparedHost | undefined
  let pending: PreparationRun | undefined
  let generation = 0
  let keyChange = 0
  let disposed = false
  let suspended = false
  let recoveringAllowed = true
  let persistenceRequested = false
  let persistence: PersistOutcome | undefined
  let recoveryObservation: DraftObservation | undefined
  let recoverySerial = 0
  let cancelObservation: (() => void) | undefined
  let recoveryBusy: PreparedHost | undefined
  let initial: Promise<OutboxPreparation>
  const closed = new WeakSet<OutboxHost>()
  const recoveries = new Map<AbortController, OutboxHost | undefined>()
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const listener of [...listeners])
      listener()
  }

  function close(host: OutboxHost | undefined): void {
    if (host === undefined || closed.has(host))
      return
    closed.add(host)
    host.dispose()
  }

  function live(): boolean {
    if (!options.still())
      dispose()
    return !disposed
  }

  function writeEpoch(): number {
    return typeof options.writeEpoch === 'number' ? options.writeEpoch : options.writeEpoch()
  }

  /** 新租约不能沿用旧宿主的登记；旧宿主仅留给临时读回，恢复时再核对并登记。 */
  function checkEpoch(): void {
    if (!live())
      return
    const epoch = writeEpoch()
    if ((pending !== undefined && pending.writeEpoch !== epoch) || ((state.kind === 'ready' || active?.recovering === true) && active !== undefined && active.writer.writeEpoch !== epoch)) {
      const lastDraftSeq = state.kind === 'ready' || state.kind === 'memory' ? state.lastDraftSeq : undefined
      suspended = true
      stop({ kind: 'memory', reason: 'fenced', ...(lastDraftSeq === undefined ? {} : { lastDraftSeq }) })
    }
  }

  function current(run: PreparationRun): boolean {
    if (!live() || generation !== run.generation)
      return false
    checkEpoch()
    return !suspended && generation === run.generation
  }

  function finish(run: PreparationRun, result: OutboxPreparation, prepared?: PreparedHost): OutboxPreparation {
    if (!current(run)) {
      close(run.host)
      return run.stopped ?? { kind: 'disposed' }
    }
    if (prepared === undefined)
      close(run.host)
    if (result.kind === 'memory' && run.recordKnown)
      result = { ...result, recordKnown: true }
    active = prepared
    state = result
    notify()
    return result
  }

  function requestPersistOnce(): void {
    if (persistenceRequested)
      return
    persistenceRequested = true
    // 用户决定可能迟迟不回来，不能挡住编辑；只记事实，不参与写入资格。
    const failed = (error: unknown) => {
      if (live()) {
        persistence = { kind: 'failed', error: describeFailure(error) }
        notify()
      }
    }
    try {
      void (options.persist ?? requestPersistence)().then((outcome) => {
        if (live()) {
          persistence = outcome
          notify()
        }
      }, failed)
    }
    catch (error) {
      failed(error)
    }
  }

  function invalidateObservation(): void {
    recoveryObservation = undefined
    recoverySerial += 1
    cancelObservation?.()
    cancelObservation = undefined
  }

  function stop(result: OutboxPreparation): void {
    generation += 1
    keyChange += 1
    invalidateObservation()
    recoveryBusy = undefined
    // 恢复尚未成为普通内容来源，原件仍在库里。关掉宿主并作废观察，避免暂停后排队的接手才开始提交。
    if (active?.recovering === true) {
      close(active.host)
      active = undefined
    }
    if (pending !== undefined) {
      pending.stopped = result
      pending.controller.abort()
      close(pending.host)
      pending = undefined
    }
    state = result
    notify()
  }

  async function prepare(run: PreparationRun, verify: boolean): Promise<OutboxPreparation> {
    try {
      if (!current(run))
        return finish(run, { kind: 'disposed' })
      if (!options.enabled)
        return finish(run, { kind: 'memory', reason: 'disabled' })
      if (!(options.supported ?? supported)())
        return finish(run, { kind: 'memory', reason: 'unsupported' })
      requestPersistOnce()
      if (verify) {
        const verdict = await options.confirm()
        if (!current(run))
          return finish(run, { kind: 'disposed' })
        const stopped = verdictResult(verdict)
        if (stopped !== undefined)
          return finish(run, stopped)
      }
      const key = await options.keeper.ensure()
      if (!current(run))
        return finish(run, { kind: 'disposed' })
      if ('kind' in key)
        return finish(run, { kind: 'memory', reason: 'no-key', keyProblem: key })
      if (options.keeper.current() !== key)
        return finish(run, { kind: 'memory', reason: 'no-key' })
      const host = await (options.host ?? (async signal => createOutboxHost({ signal })))(run.controller.signal)
      run.host = host
      if (!current(run))
        return finish(run, { kind: 'disposed' })
      if (host.broken())
        return finish(run, { kind: 'memory', reason: 'worker-failed' })
      if (options.keeper.current() !== key)
        return finish(run, { kind: 'memory', reason: 'no-key' })
      const set = await host.writer.setKey(key)
      if (!current(run))
        return finish(run, { kind: 'disposed' })
      if (options.keeper.current() !== key)
        return finish(run, { kind: 'memory', reason: 'no-key' })
      if (set.kind === 'failed')
        return finish(run, { kind: 'memory', reason: host.broken() ? 'worker-failed' : 'unavailable', problem: set })
      let writer: WriterIdentity = { writeEpoch: run.writeEpoch, writerId: options.newWriterId() }
      let registered = await host.writer.register(options.key, writer, false)
      if (!current(run))
        return finish(run, { kind: 'disposed' })
      run.recordKnown ||= registered.recordKnown === true || (registered.kind === 'registered' && registered.existing !== undefined)
      if (options.keeper.current() !== key)
        return finish(run, { kind: 'memory', reason: 'no-key' })
      if (registered.kind === 'superseded') {
        const verdict = await options.confirm()
        if (!current(run))
          return finish(run, { kind: 'disposed' })
        const stopped = verdictResult(verdict)
        if (stopped !== undefined)
          return finish(run, stopped)
        if (options.keeper.current() !== key)
          return finish(run, { kind: 'memory', reason: 'no-key' })
        writer = { writeEpoch: run.writeEpoch, writerId: options.newWriterId() }
        registered = await host.writer.register(options.key, writer, true)
        if (!current(run))
          return finish(run, { kind: 'disposed' })
        run.recordKnown ||= registered.recordKnown === true || (registered.kind === 'registered' && registered.existing !== undefined)
        if (options.keeper.current() !== key)
          return finish(run, { kind: 'memory', reason: 'no-key' })
      }
      if (registered.kind === 'registered') {
        // 显式恢复不能把“只有新版镜像”当成空草稿；保留端口重新核对，普通登记语义不变。
        if (registered.existing !== undefined || (options.recoverExisting === true && run.recordKnown)) {
          const existing = registered.existing?.kind === 'draft' ? { kind: 'draft' as const, meta: registered.existing.meta } : registered.existing
          return finish(run, { kind: 'memory', reason: 'existing-draft', existing, lastDraftSeq: registered.lastDraftSeq }, options.recoverExisting === true ? { host, writer, installedKey: key, recovering: true } : undefined)
        }
        return finish(run, { kind: 'ready', writer, lastDraftSeq: registered.lastDraftSeq, mirror: registered.mirror, hostKind: host.kind }, { host, writer, installedKey: key })
      }
      if (registered.kind === 'superseded')
        return finish(run, { kind: 'memory', reason: 'fenced' })
      return finish(run, { kind: 'memory', reason: host.broken() ? 'worker-failed' : registered.kind === 'quota' ? 'quota' : 'unavailable', problem: registered })
    }
    catch (error) {
      return finish(run, { kind: 'memory', reason: 'unavailable', problem: { kind: 'failed', error: describeFailure(error) } })
    }
  }

  async function begin(verify: boolean): Promise<OutboxPreparation> {
    close(active?.host)
    active = undefined
    invalidateObservation()
    recoveryBusy = undefined
    suspended = false
    recoveringAllowed = true
    state = { kind: 'preparing' }
    generation += 1
    let resolve!: (result: OutboxPreparation) => void
    const promise = new Promise<OutboxPreparation>((done) => {
      resolve = done
    })
    const run: PreparationRun = { writeEpoch: writeEpoch(), generation, controller: new AbortController(), promise, host: undefined, stopped: undefined, recordKnown: false }
    pending = run
    notify()
    void prepare(run, verify).then(resolve)
    void promise.finally(() => {
      if (pending === run)
        pending = undefined
    })
    return promise
  }

  function writable(): PreparedHost | undefined {
    checkEpoch()
    if (!live() || suspended || state.kind !== 'ready' || active?.host.broken() !== false || active.installedKey === undefined || active.installedKey !== options.keeper.current())
      return undefined
    return active
  }

  function recoveryTarget(): PreparedHost | undefined {
    checkEpoch()
    if (!live() || suspended || options.recoverExisting !== true || state.kind !== 'memory' || state.reason !== 'existing-draft' || active?.recovering !== true)
      return undefined
    if (active.host.broken() || active.installedKey === undefined || active.installedKey !== options.keeper.current()) {
      const reason = active.host.broken() ? 'worker-failed' : 'no-key'
      stop({ kind: 'memory', reason })
      return undefined
    }
    return active
  }

  function claimRecovery(observation: DraftObservation): PreparedHost | undefined {
    const target = recoveryTarget()
    if (target === undefined || recoveryBusy !== undefined || recoveryObservation !== observation)
      return undefined
    recoveryObservation = undefined
    recoveryBusy = target
    return target
  }

  /** 每次观察已放开存储互斥才等待；到期只交回占用，不让迟到回包获得安装、重放或清理资格。 */
  async function observeDuringHandover(target: PreparedHost, serial: number, started: number): Promise<ObserveResult> {
    const inactive: ObserveResult = { kind: 'failed', error: INACTIVE }
    const valid = (): boolean => serial === recoverySerial && started === generation && recoveryTarget() === target
    let cancel!: () => void
    const cancelled = new Promise<ObserveResult>((resolve) => {
      cancel = () => resolve(inactive)
    })
    cancelObservation = cancel
    let cancelDelay: (() => void) | undefined
    let cancelDeadline: (() => void) | undefined
    try {
      let result = await Promise.race([target.host.writer.observe(options.key), cancelled])
      if (!valid() || result.kind !== 'failed' || result.error.name !== 'MirrorBusy')
        return valid() ? result : inactive
      const firstBusy = result
      const until = clock.now() + RECOVERY_MIRROR_WAIT_MS
      const deadline = new Promise<ObserveResult>((resolve) => {
        cancelDeadline = clock.schedule(() => resolve(firstBusy), RECOVERY_MIRROR_WAIT_MS)
      })
      while (valid() && result.kind === 'failed' && result.error.name === 'MirrorBusy') {
        const busy = result
        if (clock.now() >= until)
          return busy
        const delayMs = Math.min(RECOVERY_MIRROR_RECHECK_MS, until - clock.now())
        const delay = new Promise<ObserveResult>((resolve) => {
          cancelDelay = clock.schedule(() => resolve(busy), delayMs)
        })
        await Promise.race([delay, cancelled, deadline])
        cancelDelay?.()
        cancelDelay = undefined
        if (!valid())
          return inactive
        if (clock.now() >= until)
          return busy
        result = await Promise.race([target.host.writer.observe(options.key), cancelled, deadline])
        if (clock.now() >= until)
          return busy
      }
      return valid() ? result : inactive
    }
    finally {
      cancelDelay?.()
      cancelDeadline?.()
      if (cancelObservation === cancel)
        cancelObservation = undefined
    }
  }

  async function withFence<T extends { readonly kind: string }>(target: PreparedHost, work: () => Promise<T>): Promise<T> {
    const started = generation
    const result = await work()
    if (result.kind === 'fenced' && generation === started && active === target && live()) {
      suspended = true
      stop({ kind: 'memory', reason: 'fenced' })
    }
    return result
  }

  function closeRecoveries(): void {
    for (const [controller, host] of recoveries) {
      controller.abort()
      close(host)
    }
    recoveries.clear()
  }

  function dispose(): void {
    if (disposed)
      return
    disposed = true
    stop({ kind: 'disposed' })
    close(active?.host)
    active = undefined
    closeRecoveries()
    listeners.clear()
  }

  const session: OutboxSession = {
    ready: async () => initial,
    view: () => {
      if (!live())
        return { kind: 'disposed' }
      checkEpoch()
      if (state.kind === 'ready') {
        if (active?.host.broken() !== false)
          return { kind: 'memory', reason: 'worker-failed' }
        if (active.installedKey === undefined || active.installedKey !== options.keeper.current())
          return { kind: 'memory', reason: 'no-key' }
      }
      return state
    },
    persistence: () => persistence,
    subscribe: (listener) => {
      if (!disposed)
        listeners.add(listener)
      return () => listeners.delete(listener)
    },
    write: async (capture) => {
      const target = writable()
      return target === undefined ? { kind: 'failed', error: INACTIVE, gzip: null } : withFence(target, async () => target.host.writer.write({ ...capture, key: options.key, writer: target.writer }))
    },
    markInFlight: async (inFlight) => {
      const target = writable()
      return target === undefined ? { kind: 'failed', error: INACTIVE } : withFence(target, async () => target.host.writer.markInFlight(options.key, target.writer, inFlight))
    },
    confirm: async (confirmedSeq, revision) => {
      const target = writable()
      return target === undefined ? { kind: 'failed', error: INACTIVE } : withFence(target, async () => target.host.writer.confirm(options.key, target.writer, confirmedSeq, revision))
    },
    read: async () => {
      if (!live() || active === undefined || active.host.broken())
        return { kind: 'failed', error: INACTIVE }
      return active.host.writer.read(options.key)
    },
    observeRecovery: async () => {
      const target = recoveryTarget()
      if (target === undefined || recoveryBusy !== undefined)
        return { kind: 'failed', error: INACTIVE }
      invalidateObservation()
      const serial = recoverySerial
      const started = generation
      const result = await observeDuringHandover(target, serial, started)
      if (serial !== recoverySerial || started !== generation || recoveryTarget() !== target)
        return { kind: 'failed', error: INACTIVE }
      if (result.kind === 'observed') {
        if (result.writer === undefined || !isSameWriter(result.writer, target.writer) || result.observation.key.userId !== options.key.userId || result.observation.key.documentId !== options.key.documentId) {
          stop({ kind: 'memory', reason: 'fenced' })
          return { kind: 'failed', error: INACTIVE }
        }
        recoveryObservation = Object.freeze({ id: result.observation.id, key: Object.freeze({ ...result.observation.key }) })
        return { ...result, observation: recoveryObservation }
      }
      return result
    },
    adopt: async (observation, capture) => {
      const target = claimRecovery(observation)
      if (target === undefined)
        return { kind: 'failed', error: INACTIVE, gzip: null }
      const started = generation
      const result = await target.host.writer.adopt(observation, { ...capture, key: options.key, writer: target.writer })
      if (recoveryBusy === target)
        recoveryBusy = undefined
      if (started !== generation || recoveryTarget() !== target)
        return { kind: 'failed', error: INACTIVE, gzip: 'gzip' in result ? result.gzip : null }
      if (result.kind === 'written') {
        target.recovering = false
        state = { kind: 'ready', writer: target.writer, lastDraftSeq: capture.draftSeq, mirror: result.mirror, hostKind: target.host.kind }
        notify()
      }
      else if (result.kind === 'fenced') {
        stop({ kind: 'memory', reason: 'fenced' })
      }
      else {
        // 未提交的配额/临时失败没有消费原观察；内存退路在真实云端确认后仍须条件清理那份原件。
        recoveryObservation = observation
      }
      return result
    },
    removeRecovery: async (observation) => {
      const target = claimRecovery(observation)
      if (target === undefined)
        return { kind: 'failed', error: INACTIVE }
      const started = generation
      const result = await target.host.writer.removeObserved(observation)
      if (recoveryBusy === target)
        recoveryBusy = undefined
      if (started === generation && recoveryTarget() === target) {
        if (result.kind === 'removed' || result.kind === 'absent' || result.kind === 'changed')
          stop({ kind: 'memory', reason: 'fenced' })
        else
          recoveryObservation = observation
      }
      // 库已删除的事实不因之后会话失效而改成“未删除”；页面仍按自己的恢复代次忽略旧结果。
      return result
    },
    readRecovered: async () => {
      if (!live() || !recoveringAllowed || !options.enabled || !(options.supported ?? supported)())
        return { kind: 'failed', error: INACTIVE }
      const controller = new AbortController()
      recoveries.set(controller, undefined)
      let host: OutboxHost | undefined
      try {
        const key = options.keeper.current() ?? await options.keeper.ensure()
        if (!live() || controller.signal.aborted || 'kind' in key || options.keeper.current() !== key)
          return { kind: 'failed', error: INACTIVE }
        host = await (options.host ?? (async signal => createOutboxHost({ signal })))(controller.signal)
        if (!live() || controller.signal.aborted || options.keeper.current() !== key)
          return { kind: 'failed', error: INACTIVE }
        recoveries.set(controller, host)
        const installed = await host.writer.setKey(key)
        if (!live() || controller.signal.aborted || options.keeper.current() !== key)
          return { kind: 'failed', error: INACTIVE }
        if (installed.kind === 'failed')
          return installed
        const result = await host.writer.read(options.key)
        return !live() || controller.signal.aborted || options.keeper.current() !== key ? { kind: 'failed', error: INACTIVE } : result
      }
      catch (error) {
        return { kind: 'failed', error: !live() ? INACTIVE : describeFailure(error) }
      }
      finally {
        recoveries.delete(controller)
        close(host)
      }
    },
    seedDigest: async (seed) => {
      const target = writable()
      if (target !== undefined)
        await target.host.writer.seedDigest(options.key, seed)
    },
    setKey: async (handle) => {
      checkEpoch()
      if (!live() || suspended || state.kind !== 'ready' || active === undefined || active.host.broken() || (handle !== undefined && handle !== options.keeper.current()))
        return { kind: 'failed', error: INACTIVE }
      const target = active
      const started = generation
      const change = ++keyChange
      target.installedKey = undefined
      notify()
      const result = await target.host.writer.setKey(handle)
      checkEpoch()
      if (!live() || suspended || generation !== started || active !== target || keyChange !== change || (handle !== undefined && handle !== options.keeper.current()))
        return { kind: 'failed', error: INACTIVE }
      if (result.kind === 'key-set')
        target.installedKey = handle
      notify()
      return result
    },
    refreshKey: async () => {
      if (!live())
        return { kind: 'failed', error: INACTIVE }
      checkEpoch()
      if (suspended || state.kind !== 'ready' || active === undefined || active.host.broken())
        return { kind: 'no-host' }
      const target = active
      const started = generation
      const change = keyChange
      const key = await options.keeper.ensure()
      checkEpoch()
      if (!live() || suspended || generation !== started || keyChange !== change || active !== target || target.host.broken() || 'kind' in key || options.keeper.current() !== key)
        return { kind: 'failed', error: INACTIVE }
      return session.setKey(key)
    },
    suspend: () => {
      const target = active
      if (!disposed && !suspended) {
        suspended = true
        stop({ kind: 'memory', reason: 'paused' })
      }
      return () => {
        close(target?.host)
        if (active === target)
          active = undefined
      }
    },
    beginKeyDiscard: () => {
      const finish = session.suspend()
      recoveringAllowed = false
      closeRecoveries()
      if (active !== undefined)
        active.installedKey = undefined
      return finish
    },
    resume: async () => {
      if (!live())
        return { kind: 'disposed' }
      checkEpoch()
      if (pending !== undefined)
        return pending.promise
      if (writable() !== undefined && state.kind === 'ready')
        return state
      return begin(true)
    },
    dispose,
  }
  initial = begin(false)
  return session
}
