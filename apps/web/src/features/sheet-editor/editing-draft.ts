// 一次编辑的来源与密钥所有权。准备句柄立即返回；宿主准备/换钥中也能停写、清钥和销毁。
import type { LocalKeyHandle } from '../../shared/outbox/draft-codec.ts'
import type { MirrorStatus } from '../../shared/outbox/draft-mirror.ts'
import type { LocalKeyKeeper, LocalKeyProblem } from '../../shared/outbox/local-key.ts'
import type { PersistOutcome } from '../../shared/outbox/storage-status.ts'
import type { LeaseClock, LeaseVerdict } from './edit-lease.ts'
import type { OutboxPreparation, OutboxSession, OutboxSessionOptions } from './outbox/outbox-session.ts'
import type { PersistentWorkingDraft } from './outbox/persistent-working-draft.ts'
import type { RecoveryBlockedReason, RecoveryInitialization, RecoveryInitializer } from './recovery/recovery-initializer.ts'
import type { DraftMemoryReason, PreparedDraft, WorkingDraft, WorkingDraftOptions } from './working-draft.ts'
import { createLocalKeyKeeper, fetchLocalKey } from '../../shared/outbox/local-key.ts'
import { createMemoryWorkingDraft } from './memory-working-draft.ts'
import { prepareOutboxSession } from './outbox/outbox-session.ts'
import { createPersistentWorkingDraft } from './outbox/persistent-working-draft.ts'

interface DraftLifecycle {
  readonly suspend: () => void
  /** 本轮恢复仍有效才为 true；合法内存退路也可继续。false 不授予上传/持久恢复资格。 */
  readonly resume: () => Promise<boolean>
  readonly observeVersion: (version: number | null) => void
  readonly discardKey: () => void
  readonly dispose: () => void
}

/** 仅含存储事实；不传宿主、正文、身份、密钥或准备失败的原始对象。 */
export interface DraftStorageView {
  readonly kind: 'persistent' | 'memory' | 'preparing' | 'inactive'
  readonly reason: DraftMemoryReason | undefined
  readonly hostKind: 'worker' | 'in-process' | undefined
  readonly mirror: MirrorStatus | undefined
  readonly persistence: PersistOutcome | undefined
}

export interface EditingDraft extends WorkingDraft, DraftLifecycle {
  readonly storage: () => DraftStorageView
}

export type EditingDraftReady
  = | { readonly kind: 'ready', readonly draft: EditingDraft, readonly restored?: true }
    | { readonly kind: 'blocked', readonly reason: RecoveryBlockedReason }
    | Extract<OutboxPreparation, { readonly kind: 'lost' | 'disposed' }>

export interface EditingDraftPreparation extends DraftLifecycle {
  readonly ready: () => Promise<EditingDraftReady>
}

export interface EditingDraftOptions extends Omit<WorkingDraftOptions, 'initialDraftSeq'>, Omit<OutboxSessionOptions, 'keeper'> {
  readonly clock: LeaseClock
  readonly keeper?: LocalKeyKeeper
  readonly onSessionProblem: (error: unknown) => void
  readonly onLost: (verdict: Extract<LeaseVerdict, { readonly kind: 'ended' | 'superseded' }>) => void
  readonly recover?: RecoveryInitializer
}

/** 独立作用域只保留上传身份与回调，不让初始化快照随包装器长驻。 */
function withRecoveryConfirmation(working: WorkingDraft, options: {
  readonly onConfirmed: (() => Promise<void>) | undefined
  readonly onSaved: (() => void) | undefined
  readonly generation: () => number
  readonly active: (run: number) => boolean
  readonly cleanupActive: () => boolean
  readonly report: (error: unknown) => void
}): WorkingDraft {
  let pin: { readonly prepared: PreparedDraft, readonly generation: number } | undefined
  return {
    ...working,
    prepare: async (ref) => {
      const generation = options.generation()
      const result = await working.prepare(ref)
      if (result.kind === 'prepared')
        pin = { prepared: result, generation }
      return result
    },
    release: (prepared) => {
      if (pin?.prepared === prepared)
        pin = undefined
      working.release(prepared)
    },
    confirm: async (prepared, revision) => {
      const upload = pin
      const accepted = upload?.prepared === prepared && Number.isSafeInteger(revision) && revision > 0
      const result = await working.confirm(prepared, revision)
      if (accepted && options.active(upload.generation) && pin === upload) {
        try {
          options.onSaved?.()
          if (options.cleanupActive())
            await options.onConfirmed?.()
        }
        catch (error) {
          options.report(error)
        }
      }
      return result
    },
    dispose: () => {
      pin = undefined
      working.dispose()
    },
  }
}

export function prepareEditingDraft(configuration: EditingDraftOptions): EditingDraftPreparation {
  const { initialCapture, recover, ...options } = configuration
  let disposed = false
  let paused = false
  let generation = 0
  const hostChanges = new Map<number, number>()
  let source: WorkingDraft | undefined
  let persistent: PersistentWorkingDraft | undefined
  let initialMemory: DraftMemoryReason | undefined
  let recoveryInMemory = false
  let storageSnapshot: DraftStorageView | undefined
  let lastHostKind: DraftStorageView['hostKind']
  let lastMirror: MirrorStatus | undefined
  let observedHost: Extract<OutboxPreparation, { readonly kind: 'ready' }> | undefined
  let unsubscribe: () => void = () => {}
  let discarding: Promise<unknown> | undefined
  let resuming: { readonly generation: number, readonly promise: Promise<boolean> } | undefined
  let releaseRecovery: (() => void) | undefined
  const keeper = options.keeper ?? createLocalKeyKeeper({ fetch: fetchLocalKey, clock: options.clock, retry: { initialMs: 2_000, maxMs: 30_000 }, requestTimeoutMs: 10_000 })

  function report(error: unknown): void {
    try {
      if (!disposed)
        options.reportError(error)
    }
    catch {
      // 错误上报不能打断资源收尾。
    }
  }

  function closeRecovery(): void {
    const release = releaseRecovery
    releaseRecovery = undefined
    try {
      release?.()
    }
    catch (error) {
      report(error)
    }
  }

  /** 包住所有主动取用，包含来源重试；会话类问题仍由页面既有会话确认处理。 */
  async function ensure(): Promise<LocalKeyHandle | LocalKeyProblem> {
    const result = await keeper.ensure()
    if (live() && 'kind' in result && result.kind === 'session') {
      try {
        options.onSessionProblem(result.error)
      }
      catch (error) {
        report(error)
      }
    }
    return result
  }

  const outbox = prepareOutboxSession({
    ...options,
    recoverExisting: recover !== undefined || options.recoverExisting === true,
    keeper: { ...keeper, ensure },
    still: () => !disposed && options.still(),
  })
  async function changingHost<T>(work: () => Promise<T>): Promise<T> {
    const run = generation
    hostChanges.set(run, (hostChanges.get(run) ?? 0) + 1)
    try {
      return await work()
    }
    finally {
      const remaining = (hostChanges.get(run) ?? 1) - 1
      if (remaining === 0)
        hostChanges.delete(run)
      else
        hostChanges.set(run, remaining)
    }
  }
  let deliveredLoss: OutboxPreparation | undefined
  const session: OutboxSession = {
    ...outbox,
    resume: async () => {
      const run = generation
      const result = await changingHost(outbox.resume)
      // 新捕获也会在来源内部恢复，不能只在显式 resume 中处理裁决。
      if (current(run) && result.kind === 'lost' && outbox.view() === result && deliveredLoss !== result) {
        deliveredLoss = result
        try {
          options.onLost(result.verdict)
        }
        catch (error) {
          report(error)
        }
      }
      return result
    },
    refreshKey: async () => changingHost(outbox.refreshKey),
  }

  function dispose(): void {
    if (disposed)
      return
    disposed = true
    generation += 1
    unsubscribe()
    closeRecovery()
    source?.dispose()
    session.dispose()
    keeper.discard()
  }

  function live(): boolean {
    if (!options.still())
      dispose()
    return !disposed
  }

  function current(run: number): boolean {
    return live() && generation === run
  }

  unsubscribe = keeper.subscribe((key) => {
    // 整段恢复/refresh 都由宿主自己安装密钥；包括 confirm 发布的停旧钥通知，不能排迟到清理去碰新宿主。
    if (!live() || paused || persistent === undefined || hostChanges.has(generation))
      return
    void persistent.setKey(key).then((result) => {
      if (live() && !paused && result.kind === 'failed' && result.error.name !== 'WorkingDraftInactive' && result.error.name !== 'OutboxSessionInactive')
        report(result.error)
    }, report)
  })

  const ready = buildReady()
  const lifecycle: DraftLifecycle = {
    suspend: () => {
      if (!live())
        return
      generation += 1
      paused = true
      closeRecovery()
      if (persistent === undefined)
        session.suspend()
      else
        persistent.suspend()
    },
    resume: async () => {
      if (!live())
        return false
      if (!paused)
        return true
      if (resuming?.generation === generation)
        return resuming.promise
      const run = ++generation
      paused = true
      const promise = (async () => {
        await ready
        await discarding
        if (!current(run))
          return false
        if (persistent === undefined || recoveryInMemory) {
          // 采用未提交后的正文已经固定在内存；恢复页面使用权不恢复原持久资格或已经作废的观察。
          paused = false
          return source !== undefined
        }
        const result = await persistent.resume()
        if (!current(run))
          return false
        paused = result.kind === 'lost' || result.kind === 'disposed' || (result.kind === 'memory' && (result.reason === 'paused' || result.reason === 'fenced'))
        return !paused
      })()
      resuming = { generation: run, promise }
      try {
        return await promise
      }
      finally {
        if (resuming?.generation === run)
          resuming = undefined
      }
    },
    observeVersion: (version) => {
      if (!live() || !options.enabled || (source !== undefined && persistent === undefined))
        return
      keeper.observeVersion(version, false)
      if (!paused && !hostChanges.has(generation) && persistent !== undefined && keeper.current() === undefined)
        void ensure().catch(report)
    },
    discardKey: () => {
      if (!live())
        return
      generation += 1
      paused = true
      closeRecovery()
      if (persistent === undefined) {
        session.beginKeyDiscard()()
      }
      else {
        // source 内部保留正文，Promise 只交元数据；无论失败与否都会关闭绑定的旧宿主。
        discarding = persistent.discardKey().catch(report)
      }
      keeper.discard()
    },
    dispose,
  }

  function storage(): DraftStorageView {
    const state = session.view()
    const content = source?.view()
    const local = content?.kind === 'working' ? content.local : undefined
    if (state.kind === 'ready' && state !== observedHost) {
      observedHost = state
      lastHostKind = state.hostKind
      lastMirror = state.mirror
    }
    if (local?.kind === 'persisted')
      lastMirror = local.mirror
    // 新写入尚未完成时保留上次降级原因，不能在重试一开始就宣称恢复。
    const reason = initialMemory ?? (state.kind === 'memory'
      ? state.reason
      : local?.kind === 'memory' ? local.reason : local?.kind === 'writing' ? storageSnapshot?.reason : undefined)
    const kind = disposed || (initialMemory === undefined && (state.kind === 'disposed' || state.kind === 'lost'))
      ? 'inactive'
      : reason !== undefined ? 'memory' : state.kind === 'preparing' ? 'preparing' : 'persistent'
    const next: DraftStorageView = { kind, reason, hostKind: lastHostKind, mirror: lastMirror, persistence: session.persistence() }
    if (storageSnapshot === undefined || (Object.keys(next) as (keyof DraftStorageView)[]).some(key => next[key] !== storageSnapshot?.[key]))
      storageSnapshot = next
    return storageSnapshot
  }

  async function buildReady(): Promise<EditingDraftReady> {
    const started = generation
    const prepared = await session.ready()
    if (!live())
      return { kind: 'disposed' }
    if (prepared.kind === 'lost' || prepared.kind === 'disposed') {
      dispose()
      return prepared
    }
    let initialDraftSeq = prepared.lastDraftSeq ?? 0
    let recovered: RecoveryInitialization = { kind: 'none' }
    if (recover !== undefined) {
      try {
        recovered = await recover(prepared.kind === 'ready'
          ? { kind: 'empty', highWater: initialDraftSeq }
          : prepared.reason === 'existing-draft'
            ? { kind: 'existing', highWater: initialDraftSeq, observe: session.observeRecovery, remove: session.removeRecovery, retire: session.dispose }
            : { kind: 'memory', highWater: initialDraftSeq, reason: prepared.reason, ...(prepared.recordKnown === true ? { recordKnown: true } : {}) })
      }
      catch (error) {
        report(error)
        recovered = { kind: 'blocked', reason: 'preserved' }
      }
      if (recovered.kind === 'restore')
        releaseRecovery = recovered.dispose
      if (!current(started) || paused) {
        dispose()
        // dispose 可能已在回调在途时执行；这时新交回的资源仍要单独释放。
        closeRecovery()
        return { kind: 'disposed' }
      }
      if (recovered.kind === 'blocked' || (prepared.kind === 'memory' && prepared.reason === 'existing-draft' && (recovered.kind !== 'restore' || recovered.recoveryObservation === undefined))) {
        dispose()
        return recovered.kind === 'blocked' ? recovered : { kind: 'blocked', reason: 'preserved' }
      }
    }
    const restored = recovered.kind === 'restore' ? recovered : undefined
    initialDraftSeq = Math.max(initialDraftSeq, restored?.highWater ?? 0)
    const sourceOptions = { ...options, initialDraftSeq, baseRevision: restored?.baseRevision ?? options.baseRevision, initialCapture: restored?.capture ?? initialCapture }
    if (recovered.kind === 'memory' || (restored !== undefined && restored.recoveryObservation === undefined) || (prepared.kind === 'memory' && (prepared.reason === 'disabled' || prepared.reason === 'unsupported' || (prepared.reason === 'existing-draft' && restored === undefined)))) {
      initialMemory = recovered.kind === 'memory' ? recovered.reason : prepared.kind === 'memory' ? prepared.reason : 'existing-draft'
      source = createMemoryWorkingDraft({ ...sourceOptions, reason: initialMemory })
      session.dispose()
      keeper.discard()
    }
    else {
      persistent = createPersistentWorkingDraft({ ...sourceOptions, session, recoveryObservation: restored?.recoveryObservation })
      source = persistent
      if (paused)
        persistent.suspend()
    }
    if (restored !== undefined) {
      const view = source.view()
      const initial = view.kind === 'working' ? await source.ready(view.ref) : undefined
      if (!current(started) || paused) {
        dispose()
        return { kind: 'disposed' }
      }
      if (initial?.kind !== 'ready' || (initial.local.kind === 'memory' && initial.local.reason === 'fenced')) {
        dispose()
        return { kind: 'blocked', reason: 'changed' }
      }
      if (initial.local.kind === 'memory') {
        recoveryInMemory = true
        initialMemory = initial.local.reason
      }
      if (restored.onSaved !== undefined || (initial.local.kind !== 'persisted' && restored.onConfirmed !== undefined))
        // 部署关闭时本机写入保持暂停，但新上传的云端确认仍有效；清理资格仍严格绑定原轮次且未暂停。
        source = withRecoveryConfirmation(source, { onConfirmed: initial.local.kind === 'persisted' ? undefined : restored.onConfirmed, onSaved: restored.onSaved, generation: () => generation, active: current, cleanupActive: () => current(started) && !paused, report })
    }
    const working = source
    return { kind: 'ready', ...(restored === undefined ? {} : { restored: true as const }), draft: {
      ...working,
      ...lifecycle,
      storage,
      subscribe: (listener) => {
        const stopContent = working.subscribe(listener)
        const stopStorage = session.subscribe(listener)
        return () => {
          stopContent()
          stopStorage()
        }
      },
    } }
  }

  return { ...lifecycle, ready: async () => ready }
}
