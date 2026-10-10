// 一次编辑会话的持久写入资格。宿主只管放置；此处唯一负责暂停、核对租约和登记，调用方拿不到绕过资格检查的 DraftWriter。
import type { LocalKeyHandle } from '../../../shared/outbox/draft-codec.ts'
import type { MirrorStatus } from '../../../shared/outbox/draft-mirror.ts'
import type { DraftKey, InFlightSave } from '../../../shared/outbox/draft-record.ts'
import type { CaptureToWrite, CaptureWritten, ConfirmResult, DedupeKey, DraftRead, KeyChange, OpenedRecord, ResealResult, WriterProblem } from '../../../shared/outbox/draft-writer.ts'
import type { FailureDescription } from '../../../shared/outbox/failure.ts'
import type { LocalKeyKeeper, LocalKeyProblem } from '../../../shared/outbox/local-key.ts'
import type { PersistOutcome } from '../../../shared/outbox/storage-status.ts'
import type { WriterIdentity } from '../../../shared/outbox/writer-fence.ts'
import type { LeaseVerdict } from '../edit-lease.ts'
import type { DraftMemoryReason } from '../working-draft.ts'
import type { OutboxHost } from './outbox-host.ts'
import { describeFailure } from '../../../shared/outbox/failure.ts'
import { requestPersistence } from '../../../shared/outbox/storage-status.ts'
import { createOutboxHost } from './outbox-host.ts'

/** 准备结果只保留事实；登记暂时读出的正文交还 GC，不能留在 state 或已完成的 ready Promise 里。 */
export type ExistingDraftSummary = Exclude<OpenedRecord, { readonly kind: 'draft' }> | Omit<Extract<OpenedRecord, { readonly kind: 'draft' }>, 'gzip'>

export type OutboxPreparation
  = | { readonly kind: 'ready', readonly writer: WriterIdentity, readonly lastDraftSeq: number, readonly mirror: MirrorStatus, readonly hostKind: OutboxHost['kind'] }
    | { readonly kind: 'memory', readonly reason: DraftMemoryReason, readonly existing?: ExistingDraftSummary, readonly lastDraftSeq?: number, readonly keyProblem?: LocalKeyProblem, readonly problem?: WriterProblem, readonly verdict?: LeaseVerdict }
    | { readonly kind: 'lost', readonly verdict: Extract<LeaseVerdict, { readonly kind: 'ended' | 'superseded' }> }
    | { readonly kind: 'disposed' }

export type OutboxSessionState = OutboxPreparation | { readonly kind: 'preparing' }
export type SessionCapture = Omit<CaptureToWrite, 'key' | 'writer' | 'adoptSeq'>

export interface OutboxSession {
  /** 初次准备的结果；对象同步返回，使准备过程也可暂停/销毁。 */
  readonly ready: () => Promise<OutboxPreparation>
  readonly view: () => OutboxSessionState
  readonly persistence: () => PersistOutcome | undefined
  readonly write: (capture: SessionCapture) => Promise<CaptureWritten>
  readonly markInFlight: (inFlight: InFlightSave) => Promise<ResealResult>
  readonly confirm: (confirmedSeq: number, revision: number) => Promise<ConfirmResult>
  /** 暂停仍可临时读回内容给内存退路；resume 会关闭旧宿主，调用方须先完成需要的读取。 */
  readonly read: () => Promise<DraftRead>
  /** 宿主失效时临时建一只读宿主；不登记/force、不改变写入资格，读完即关。内容身份仍由来源核对。 */
  readonly readRecovered: () => Promise<DraftRead>
  readonly seedDigest: (seed: DedupeKey | undefined) => Promise<void>
  readonly setKey: (key: LocalKeyHandle | undefined) => Promise<KeyChange>
  /** 原写入资格仍有效时在原宿主取新钥，保留其重封缓存；没有可续用宿主才交回 no-host。 */
  readonly refreshKey: () => Promise<KeyChange | { readonly kind: 'no-host' }>
  readonly suspend: () => void
  /** 每次调用至多准备一次，不自行重试；并发调用共用正在进行的准备。 */
  readonly resume: () => Promise<OutboxPreparation>
  readonly dispose: () => void
}

export interface OutboxSessionOptions {
  readonly enabled: boolean
  readonly key: DraftKey
  readonly writeEpoch: number
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
}

interface PreparationRun {
  readonly generation: number
  readonly controller: AbortController
  readonly promise: Promise<OutboxPreparation>
  host: OutboxHost | undefined
  stopped: OutboxPreparation | undefined
}

const INACTIVE: FailureDescription = { name: 'OutboxSessionInactive', message: '本机草稿写入资格已暂停、失效或尚未准备好' }

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
  let state: OutboxSessionState = { kind: 'preparing' }
  let active: PreparedHost | undefined
  let pending: PreparationRun | undefined
  let generation = 0
  let keyChange = 0
  let disposed = false
  let suspended = false
  let persistenceRequested = false
  let persistence: PersistOutcome | undefined
  let initial: Promise<OutboxPreparation>
  const closed = new WeakSet<OutboxHost>()
  const recoveries = new Map<AbortController, OutboxHost | undefined>()

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

  function current(run: PreparationRun): boolean {
    return live() && !suspended && generation === run.generation
  }

  function finish(run: PreparationRun, result: OutboxPreparation, prepared?: PreparedHost): OutboxPreparation {
    if (!current(run)) {
      close(run.host)
      return run.stopped ?? { kind: 'disposed' }
    }
    if (prepared === undefined)
      close(run.host)
    active = prepared
    state = result
    return result
  }

  function requestPersistOnce(): void {
    if (persistenceRequested)
      return
    persistenceRequested = true
    // 用户决定可能迟迟不回来，不能挡住编辑；只记事实，不参与写入资格。
    const failed = (error: unknown) => {
      if (live())
        persistence = { kind: 'failed', error: describeFailure(error) }
    }
    try {
      void (options.persist ?? requestPersistence)().then((outcome) => {
        if (live())
          persistence = outcome
      }, failed)
    }
    catch (error) {
      failed(error)
    }
  }

  function stop(result: OutboxPreparation): void {
    generation += 1
    keyChange += 1
    if (pending !== undefined) {
      pending.stopped = result
      pending.controller.abort()
      close(pending.host)
      pending = undefined
    }
    state = result
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
      let writer: WriterIdentity = { writeEpoch: options.writeEpoch, writerId: options.newWriterId() }
      let registered = await host.writer.register(options.key, writer, false)
      if (!current(run))
        return finish(run, { kind: 'disposed' })
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
        writer = { writeEpoch: options.writeEpoch, writerId: options.newWriterId() }
        registered = await host.writer.register(options.key, writer, true)
        if (!current(run))
          return finish(run, { kind: 'disposed' })
        if (options.keeper.current() !== key)
          return finish(run, { kind: 'memory', reason: 'no-key' })
      }
      if (registered.kind === 'registered') {
        if (registered.existing !== undefined) {
          const existing = registered.existing.kind === 'draft' ? { kind: 'draft' as const, meta: registered.existing.meta } : registered.existing
          return finish(run, { kind: 'memory', reason: 'existing-draft', existing, lastDraftSeq: registered.lastDraftSeq })
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
    suspended = false
    state = { kind: 'preparing' }
    generation += 1
    let resolve!: (result: OutboxPreparation) => void
    const promise = new Promise<OutboxPreparation>((done) => {
      resolve = done
    })
    const run: PreparationRun = { generation, controller: new AbortController(), promise, host: undefined, stopped: undefined }
    pending = run
    void prepare(run, verify).then(resolve)
    void promise.finally(() => {
      if (pending === run)
        pending = undefined
    })
    return promise
  }

  function writable(): PreparedHost | undefined {
    if (!live() || suspended || state.kind !== 'ready' || active?.host.broken() !== false || active.installedKey === undefined || active.installedKey !== options.keeper.current())
      return undefined
    return active
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

  function dispose(): void {
    if (disposed)
      return
    disposed = true
    stop({ kind: 'disposed' })
    close(active?.host)
    active = undefined
    for (const [controller, host] of recoveries) {
      controller.abort()
      close(host)
    }
    recoveries.clear()
  }

  const session: OutboxSession = {
    ready: async () => initial,
    view: () => {
      if (!live())
        return { kind: 'disposed' }
      if (state.kind === 'ready') {
        if (active?.host.broken() !== false)
          return { kind: 'memory', reason: 'worker-failed' }
        if (active.installedKey === undefined || active.installedKey !== options.keeper.current())
          return { kind: 'memory', reason: 'no-key' }
      }
      return state
    },
    persistence: () => persistence,
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
    readRecovered: async () => {
      if (!live() || !options.enabled || !(options.supported ?? supported)())
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
      if (!live() || suspended || state.kind !== 'ready' || active === undefined || active.host.broken() || (handle !== undefined && handle !== options.keeper.current()))
        return { kind: 'failed', error: INACTIVE }
      const target = active
      const started = generation
      const change = ++keyChange
      target.installedKey = undefined
      const result = await target.host.writer.setKey(handle)
      if (!live() || suspended || generation !== started || active !== target || keyChange !== change || (handle !== undefined && handle !== options.keeper.current()))
        return { kind: 'failed', error: INACTIVE }
      if (result.kind === 'key-set')
        target.installedKey = handle
      return result
    },
    refreshKey: async () => {
      if (!live())
        return { kind: 'failed', error: INACTIVE }
      if (suspended || state.kind !== 'ready' || active === undefined || active.host.broken())
        return { kind: 'no-host' }
      const target = active
      const started = generation
      const change = keyChange
      const key = await options.keeper.ensure()
      if (!live() || suspended || generation !== started || keyChange !== change || active !== target || target.host.broken() || 'kind' in key || options.keeper.current() !== key)
        return { kind: 'failed', error: INACTIVE }
      return session.setKey(key)
    },
    suspend: () => {
      if (disposed || suspended)
        return
      suspended = true
      stop({ kind: 'memory', reason: 'paused' })
    },
    resume: async () => {
      if (!live())
        return { kind: 'disposed' }
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
