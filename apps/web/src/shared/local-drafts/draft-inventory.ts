import type { DraftStore } from '../outbox/draft-store.ts'
import type { MirrorDirectory } from '../outbox/mirror-directory.ts'
import type { DraftSessionPermit } from '../outbox/session-fence.ts'
import { pageReconciliation, reconcileAll } from '../outbox/draft-recovery.ts'
import { createDraftStore } from '../outbox/draft-store.ts'
import { opfsMirrorDirectory } from '../outbox/mirror-directory.ts'
import { withOutboxLock } from '../outbox/outbox-lock.ts'
import { readDraftSessionPermit } from '../outbox/session-fence.ts'

export interface DraftInventoryEntry {
  readonly documentId: string
  readonly updatedAt: number | undefined
  readonly mirrorOnly: boolean
}

export type DraftInventory = { readonly kind: 'listed', readonly entries: readonly DraftInventoryEntry[], readonly incomplete: boolean }
  | { readonly kind: 'unavailable', readonly reason: 'session' | 'storage' }

export interface DraftInventoryOptions {
  readonly permit: DraftSessionPermit | undefined
  readonly still: () => boolean
  readonly store?: DraftStore
  readonly directory?: MirrorDirectory
  readonly now?: () => number
}

const INACTIVE = { kind: 'unavailable', reason: 'session' } as const

/** 主库只交元数据；镜像比对逐份借用密文，结束后不留下字节。 */
export function createDraftInventory(options: DraftInventoryOptions) {
  const permit = readDraftSessionPermit(options.permit)
  const store = options.store ?? createDraftStore({ blockedTimeoutMs: 3_000 })
  const directory = options.directory ?? opfsMirrorDirectory()
  const source = pageReconciliation({ store, directory, now: options.now ?? Date.now })
  let disposed = false
  const live = () => !disposed && options.still() && permit !== undefined

  /** 元数据请求也须确认原许可；不能在请求期间换人后展示新人的标题。 */
  async function check(): Promise<'active' | 'session' | 'storage'> {
    if (!live() || permit === undefined)
      return 'session'
    try {
      const binding = await store.bindSession(permit)
      if (!live() || binding.kind === 'session-invalid')
        return 'session'
      if (binding.kind !== 'bound')
        return 'storage'
      return await withOutboxLock(async () => {
        if (!live())
          return 'session'
        const result = await store.checkSession(permit.userId)
        if (!live() || result.kind === 'session-invalid')
          return 'session'
        return result.kind === 'bound' ? 'active' : 'storage'
      })
    }
    catch {
      return live() ? 'storage' : 'session'
    }
  }

  async function load(): Promise<DraftInventory> {
    if (!live() || permit === undefined)
      return INACTIVE
    try {
      const binding = await store.bindSession(permit)
      if (!live() || binding.kind === 'session-invalid')
        return INACTIVE
      if (binding.kind !== 'bound')
        return { kind: 'unavailable', reason: 'storage' }
      // 记住这轮确实列出的镜像文档，失败不能用主库空结果掩盖。
      let mirrored: readonly string[] = []
      const reconciled = await reconcileAll({
        mirroredDocuments: async (userId) => {
          const result = await source.mirroredDocuments(userId)
          if (result.kind === 'listed')
            mirrored = result.documentIds
          return result
        },
        reconcile: async key => live() ? source.reconcile(key) : { kind: 'session-invalid' },
      }, permit.userId)
      if (!live() || reconciled.kind === 'session-invalid')
        return INACTIVE
      return await withOutboxLock(async (): Promise<DraftInventory> => {
        if (!live())
          return INACTIVE
        const checked = await store.checkSession(permit.userId)
        if (!live() || checked.kind === 'session-invalid')
          return INACTIVE
        if (checked.kind !== 'bound')
          return { kind: 'unavailable', reason: 'storage' }
        let incomplete = reconciled.kind !== 'reconciled' || reconciled.failed.length > 0
        const entries = new Map<string, DraftInventoryEntry>()
        const listed = await store.listDrafts(permit.userId)
        if (!live() || listed.kind === 'session-invalid')
          return INACTIVE
        if (listed.kind === 'listed') {
          for (const draft of listed.drafts) {
            const key = draft.kind === 'draft' ? draft.meta : draft.key
            if (key.userId !== permit.userId) {
              incomplete = true
              continue
            }
            entries.set(key.documentId, { documentId: key.documentId, updatedAt: draft.kind === 'draft' ? draft.meta.updatedAt : undefined, mirrorOnly: false })
          }
        }
        else {
          incomplete = true
        }
        for (const documentId of mirrored) {
          if (!live())
            return INACTIVE
          if (entries.has(documentId))
            continue
          const files = await directory.slotFiles({ userId: permit.userId, documentId })
          if (!live())
            return INACTIVE
          if (files.kind === 'absent' || files.kind === 'unsupported' || (files.kind === 'files' && files.files.every(file => file === undefined || file.size === 0)))
            continue
          incomplete ||= files.kind !== 'files'
          entries.set(documentId, { documentId, updatedAt: undefined, mirrorOnly: true })
        }
        const notices = await store.listNotices(permit.userId)
        if (!live() || notices.kind === 'session-invalid')
          return INACTIVE
        if (notices.kind === 'notices') {
          for (const notice of notices.notices) {
            if (notice.userId === permit.userId && !entries.has(notice.documentId))
              entries.set(notice.documentId, { documentId: notice.documentId, updatedAt: undefined, mirrorOnly: false })
          }
        }
        else {
          incomplete = true
        }
        return { kind: 'listed', entries: [...entries.values()], incomplete }
      })
    }
    catch {
      return live() ? { kind: 'unavailable', reason: 'storage' } : INACTIVE
    }
  }

  return {
    check,
    load,
    dispose: () => {
      if (disposed)
        return
      disposed = true
      store.close()
    },
  }
}
