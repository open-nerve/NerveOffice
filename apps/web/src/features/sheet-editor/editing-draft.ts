// 一次编辑的来源与密钥所有权。准备句柄立即返回；宿主准备/换钥中也能停写、清钥和销毁。
import type { LocalKeyHandle } from '../../shared/outbox/draft-codec.ts'
import type { LocalKeyKeeper, LocalKeyProblem } from '../../shared/outbox/local-key.ts'
import type { LeaseClock, LeaseVerdict } from './edit-lease.ts'
import type { OutboxPreparation, OutboxSession, OutboxSessionOptions } from './outbox/outbox-session.ts'
import type { PersistentWorkingDraft } from './outbox/persistent-working-draft.ts'
import type { WorkingDraft, WorkingDraftOptions } from './working-draft.ts'
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

export interface EditingDraft extends WorkingDraft, DraftLifecycle {}

export type EditingDraftReady
  = | { readonly kind: 'ready', readonly draft: EditingDraft }
    | Extract<OutboxPreparation, { readonly kind: 'lost' | 'disposed' }>

export interface EditingDraftPreparation extends DraftLifecycle {
  readonly ready: () => Promise<EditingDraftReady>
}

export interface EditingDraftOptions extends Omit<WorkingDraftOptions, 'initialDraftSeq'>, Omit<OutboxSessionOptions, 'keeper'> {
  readonly clock: LeaseClock
  readonly keeper?: LocalKeyKeeper
  readonly onSessionProblem: (error: unknown) => void
  readonly onLost: (verdict: Extract<LeaseVerdict, { readonly kind: 'ended' | 'superseded' }>) => void
}

export function prepareEditingDraft(options: EditingDraftOptions): EditingDraftPreparation {
  let disposed = false
  let paused = false
  let generation = 0
  const hostChanges = new Map<number, number>()
  let source: WorkingDraft | undefined
  let persistent: PersistentWorkingDraft | undefined
  let unsubscribe: () => void = () => {}
  let discarding: Promise<unknown> | undefined
  let resuming: { readonly generation: number, readonly promise: Promise<boolean> } | undefined
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
        if (persistent === undefined) {
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

  async function buildReady(): Promise<EditingDraftReady> {
    const prepared = await session.ready()
    if (!live())
      return { kind: 'disposed' }
    if (prepared.kind === 'lost' || prepared.kind === 'disposed') {
      dispose()
      return prepared
    }
    const initialDraftSeq = prepared.lastDraftSeq ?? 0
    if (prepared.kind === 'memory' && (prepared.reason === 'disabled' || prepared.reason === 'unsupported' || prepared.reason === 'existing-draft')) {
      source = createMemoryWorkingDraft({ ...options, initialDraftSeq, reason: prepared.reason })
      session.dispose()
      keeper.discard()
    }
    else {
      persistent = createPersistentWorkingDraft({ ...options, initialDraftSeq, session })
      source = persistent
      if (paused)
        persistent.suspend()
    }
    return { kind: 'ready', draft: { ...source, ...lifecycle } }
  }

  return { ...lifecycle, ready: async () => ready }
}
