import type { DocumentDetail, DocumentDraftFact } from '@nerve-office/contracts'
import type { DocumentRecovery, RecoveryAccessFacts, RecoveryDiscard, RecoveryView } from './document-recovery.ts'
import type { DraftInventory, DraftInventoryEntry } from './draft-inventory.ts'
import { isAuthenticationError, isCsrfTokenError } from '../api/index.ts'

export interface DraftCatalogRow extends DraftInventoryEntry {
  readonly title: string | undefined
  readonly access: 'accessible' | 'unavailable' | 'unknown'
  readonly copyUncertain?: true
  readonly recovery: RecoveryView | undefined
}

export interface CatalogDiscard {
  readonly documentId: string
  readonly title: string | undefined
  readonly updatedAt: number | undefined
}

export interface DraftCatalogView {
  readonly checked: boolean
  readonly completedCopies: readonly DocumentDetail[]
  readonly uncertainCopies: readonly string[]
  readonly rows: readonly DraftCatalogRow[]
  readonly busy: { readonly kind: 'refresh' | 'copy' | 'prepare-discard' | 'discard' | 'cleanup', readonly documentId?: string } | undefined
  readonly problem: 'facts' | 'storage' | 'session' | undefined
  readonly incomplete: boolean
  readonly stale: boolean
  readonly held: string | undefined
  readonly copyPending: string | undefined
}

export type DraftRecoveryFactory = (options: { readonly documentId: string, readonly facts: () => Promise<RecoveryAccessFacts>, readonly title: () => string }) => DocumentRecovery

export interface DraftCatalogOptions {
  readonly inventory: { readonly load: () => Promise<DraftInventory>, readonly dispose: () => void }
  readonly readFacts: (ids: readonly string[]) => Promise<ReadonlyMap<string, DocumentDraftFact>>
  readonly makeRecovery: DraftRecoveryFactory
  readonly still: () => boolean
  readonly onSessionProblem?: (error: unknown) => void
}

const EMPTY: DraftCatalogView = { checked: false, completedCopies: [], uncertainCopies: [], rows: [], busy: undefined, problem: undefined, incomplete: false, stale: false, held: undefined, copyPending: undefined }

interface OwnedRecovery {
  readonly documentId: string
  readonly recovery: DocumentRecovery
  readonly unsubscribe: () => void
}

function accessOf(fact: DocumentDraftFact | undefined): RecoveryAccessFacts {
  if (fact === undefined)
    return { access: 'unknown', online: false, current: undefined }
  if (fact.status === 'unavailable')
    return { access: 'unreadable', online: true, current: undefined }
  return { access: fact.canEdit ? 'editable' : 'read-only', online: true, current: { revision: fact.revision, source: fact.revisionSource, occupied: fact.occupied } }
}

function cleanupRetryable(view: RecoveryView): boolean {
  return view.cleanup !== undefined && view.cleanup.kind !== 'removed' && view.cleanup.kind !== 'absent' && view.cleanup.kind !== 'changed' && view.cleanup.kind !== 'session-invalid'
}

/** 一份活的操作拥有者；未知副本不被目录刷新或下一行操作替换。 */
export function createDraftCatalog(options: DraftCatalogOptions) {
  let state = EMPTY
  let disposed = false
  let scanning: DocumentRecovery | undefined
  let owner: OwnedRecovery | undefined
  let confirming: { readonly intent: CatalogDiscard, readonly original: RecoveryDiscard, readonly owner: OwnedRecovery } | undefined
  const listeners = new Set<() => void>()

  function publish(patch: Partial<DraftCatalogView>): void {
    if (disposed)
      return
    state = { ...state, ...patch }
    for (const listener of [...listeners])
      listener()
  }

  function row(documentId: string): DraftCatalogRow | undefined {
    return state.rows.find(item => item.documentId === documentId)
  }

  function update(documentId: string, patch: Partial<DraftCatalogRow>): void {
    publish({ rows: state.rows.map(item => item.documentId === documentId ? { ...item, ...patch } : item) })
  }

  function release(): void {
    const previous = owner
    owner = undefined
    previous?.unsubscribe()
    previous?.recovery.dispose()
    publish({ held: undefined, copyPending: undefined })
  }

  function dispose(): void {
    if (disposed)
      return
    disposed = true
    release()
    scanning?.dispose()
    scanning = undefined
    confirming = undefined
    options.inventory.dispose()
    state = { ...EMPTY, problem: 'session' }
    for (const listener of [...listeners])
      listener()
    listeners.clear()
  }

  function live(): boolean {
    if (!disposed && !options.still())
      dispose()
    return !disposed
  }

  async function request(ids: readonly string[]): Promise<ReadonlyMap<string, DocumentDraftFact>> {
    try {
      return await options.readFacts(ids)
    }
    catch (error) {
      if (live()) {
        publish({ problem: 'facts' })
        if (isAuthenticationError(error) || isCsrfTokenError(error))
          options.onSessionProblem?.(error)
      }
      return new Map()
    }
  }

  function showFact(documentId: string, fact: DocumentDraftFact | undefined): RecoveryAccessFacts {
    if (!live())
      return accessOf(undefined)
    update(documentId, { title: fact?.status === 'accessible' ? fact.title : undefined, access: fact?.status ?? 'unknown' })
    return accessOf(fact)
  }

  async function fresh(documentId: string): Promise<RecoveryAccessFacts> {
    if (!live())
      return accessOf(undefined)
    const facts = await request([documentId])
    return showFact(documentId, facts.get(documentId))
  }

  function make(documentId: string, facts = async () => fresh(documentId)): DocumentRecovery {
    return options.makeRecovery({ documentId, facts, title: () => row(documentId)?.title ?? '' })
  }

  function reflect(owned: OwnedRecovery): void {
    if (!live() || owner !== owned)
      return
    const view = owned.recovery.view()
    update(owned.documentId, { recovery: view, updatedAt: view.updatedAt ?? row(owned.documentId)?.updatedAt })
    const completed = new Map(state.completedCopies.map(document => [document.id, document]))
    for (const document of view.completedCopies ?? [])
      completed.set(document.id, document)
    publish({ completedCopies: [...completed.values()], copyPending: view.copy.kind === 'failed' ? owned.documentId : undefined })
  }

  function acquire(documentId: string): OwnedRecovery {
    if (owner?.documentId === documentId)
      return owner
    const recovery = make(documentId)
    const owned: OwnedRecovery = { documentId, recovery, unsubscribe: recovery.subscribe(() => reflect(owned)) }
    owner = owned
    publish({ held: documentId })
    return owned
  }

  function allowed(documentId: string): boolean {
    return live() && state.busy === undefined && confirming === undefined && row(documentId) !== undefined && (owner === undefined || owner.documentId === documentId)
  }

  function finish(owned: OwnedRecovery): void {
    if (!live() || owner !== owned)
      return
    reflect(owned)
    const view = owned.recovery.view()
    if (confirming === undefined && view.copy.kind !== 'failed' && !cleanupRetryable(view))
      release()
    publish({ busy: undefined })
  }

  async function refresh(): Promise<void> {
    if (!live())
      return
    if (state.busy !== undefined || confirming !== undefined || state.copyPending !== undefined) {
      publish({ stale: true })
      return
    }
    // 手动重查结束旧的清理重试资格；新的放弃仍须重新确认。已创建副本的事实独立保留。
    release()
    publish({ busy: { kind: 'refresh' }, problem: undefined, stale: false })
    try {
      const inventory = await options.inventory.load()
      if (!live())
        return
      if (inventory.kind !== 'listed') {
        if (inventory.reason === 'session') {
          dispose()
          options.onSessionProblem?.(new Error('本机草稿的登录资格已变化'))
          return
        }
        publish({ problem: inventory.reason, incomplete: true, rows: state.rows.map(item => ({ ...item, title: undefined, access: 'unknown', recovery: undefined })) })
        return
      }
      publish({ rows: inventory.entries.map(item => ({ ...item, title: undefined, access: 'unknown', recovery: undefined, ...(state.uncertainCopies.includes(item.documentId) ? { copyUncertain: true as const } : {}) })), incomplete: inventory.incomplete })
      const facts = await request(inventory.entries.map(item => item.documentId))
      if (!live())
        return
      for (const item of inventory.entries) {
        if (!live())
          return
        const fact = facts.get(item.documentId)
        // 排队中的无权事实不能直接清理；再向服务端确认一次。可读项只用于这次发现。
        const recovery = make(item.documentId, async () => fact?.status === 'unavailable' ? fresh(item.documentId) : showFact(item.documentId, fact))
        scanning = recovery
        try {
          await recovery.discover()
          if (!live())
            return
          update(item.documentId, { recovery: recovery.view(), updatedAt: recovery.view().updatedAt ?? item.updatedAt })
        }
        finally {
          recovery.dispose()
          scanning = undefined
        }
      }
    }
    catch {
      if (live())
        publish({ problem: 'storage', incomplete: true })
    }
    finally {
      if (live())
        publish({ busy: undefined, checked: true })
    }
  }

  return {
    view: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    copy: async (documentId: string) => {
      if (!allowed(documentId))
        return
      const previous = row(documentId)?.recovery
      if (previous?.copy.kind === 'done' || previous?.copy.kind === 'refused' || previous?.cleanup?.kind === 'changed' || previous?.stage === 'finished')
        return
      if (previous?.copy.kind !== 'failed' && previous?.decision?.kind !== 'restore' && previous?.decision?.kind !== 'held' && previous?.decision?.kind !== 'copy')
        return
      publish({ busy: { kind: 'copy', documentId } })
      let owned = acquire(documentId)
      try {
        await owned.recovery.copy()
        if (live() && row(documentId)?.access === 'unavailable') {
          // 不可读是确定的新事实：停止旧副本的内容借用，交回共享发现执行条件清理。
          // 不把旧请求当成失败或成功，也不借新观察重发那个副本。
          if (owned.recovery.view().copy.kind === 'failed') {
            update(documentId, { copyUncertain: true })
            publish({ uncertainCopies: [...new Set([...state.uncertainCopies, documentId])] })
          }
          release()
          owned = acquire(documentId)
          await owned.recovery.discover()
        }
      }
      finally {
        finish(owned)
      }
    },
    prepareDiscard: async (documentId: string): Promise<CatalogDiscard | undefined> => {
      if (!allowed(documentId))
        return undefined
      publish({ busy: { kind: 'prepare-discard', documentId } })
      const owned = acquire(documentId)
      try {
        // 未知副本仍绑原件，确认放弃同一原件；新发现会覆盖它的候选，不能在这里做。
        if (owned.recovery.view().copy.kind !== 'failed')
          await owned.recovery.discover()
        if (!live())
          return undefined
        const view = owned.recovery.view()
        if (view.decision?.kind === 'preserve' && (view.decision.reason === 'newer-format' || view.decision.reason === 'session' || view.decision.reason === 'identity'))
          return undefined
        const original = owned.recovery.beginDiscard()
        if (original === undefined)
          return undefined
        const intent = Object.freeze({ documentId, title: row(documentId)?.title, updatedAt: original.updatedAt })
        confirming = { intent, original, owner: owned }
        return intent
      }
      finally {
        finish(owned)
      }
    },
    discard: async (intent: CatalogDiscard) => {
      const pending = confirming
      if (!live() || pending?.intent !== intent || state.busy !== undefined)
        return
      publish({ busy: { kind: 'discard', documentId: intent.documentId } })
      try {
        await pending.owner.recovery.discard(pending.original)
      }
      finally {
        confirming = undefined
        finish(pending.owner)
      }
    },
    cancelDiscard: (intent: CatalogDiscard) => {
      if (confirming?.intent !== intent || state.busy !== undefined)
        return
      const owned = confirming.owner
      confirming = undefined
      finish(owned)
    },
    retryCleanup: async (documentId: string) => {
      if (!allowed(documentId) || owner === undefined || !cleanupRetryable(owner.recovery.view()))
        return
      const owned = owner
      publish({ busy: { kind: 'cleanup', documentId } })
      try {
        if ((await fresh(documentId)).access !== 'unknown')
          await owned.recovery.retryCleanup()
      }
      finally {
        finish(owned)
      }
    },
    dispose,
  }
}

export type DraftCatalog = ReturnType<typeof createDraftCatalog>
