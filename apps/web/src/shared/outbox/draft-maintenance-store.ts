// 批量清理与保留期维护只在主线程运行，不进入草稿 Worker。复用同一份事务与墓碑规则。
import type { DraftKey } from './draft-record.ts'
import type { PurgedDraft, StoreClearOutcome, StoreDropOutcome, StorePurgeOutcome, StoreRetireOutcome, StoreTombstonesOutcome } from './draft-store.ts'
import type { UserCleanupPermit } from './session-fence.ts'
import type { StoreOptions as DraftStoreOptions, StoreProblem, TransactionScope } from './store-transaction.ts'
import type { ExistingDraft } from './writer-fence.ts'
import { draftKeyPath, DRAFTS_STORE, NOTICES_STORE, SESSION_SLOT, SESSIONS_STORE, userKeyRange, WRITERS_STORE } from './database.ts'
import { isWhole, readableUpdatedAt, readStoredDraft, readWriterRecord } from './draft-record.ts'
import { readRecoveryNotice } from './recovery-notice.ts'
import { canCleanUserSession, readUserCleanupPermit } from './session-fence.ts'
import { readStoredSession } from './session-record.ts'
import { ALL_STORES, DRAFT_STORES, draftKeyOf, retireDocument } from './store-records.ts'
import { createStoreTransactions } from './store-transaction.ts'
import { isNoticeExpired, isRetired, retiredWriterOf, shouldPurgeDraft, writerRetention } from './writer-fence.ts'

export interface DraftMaintenanceStore {

  /**
   * 按用户清理的第一步（退出登录、账户停用，复验 C5）：这个人每份文档的写入者在一个事务里换成墓碑（高水位不低于草稿的序号），草稿与
   * 提示不动。之后那一页的写入、重封、确认一律 not-writer——它的发件箱 Worker 随之放开句柄、不再写镜像，删镜像目录与清库之间不会把
   * 目录重建出来（local-cleanup.ts 先立墓碑、再删镜像目录、最后清库）
   */
  readonly retireUser: (permit: UserCleanupPermit, options: { readonly now: number }) => Promise<StoreRetireOutcome>

  /**
   * 按用户清理（退出登录、账户停用）：草稿、写入者（含墓碑）与提示在一个事务里一起删；之后才到的写入因写入者不在而 not-writer。
   * retire 里的文档（它的镜像目录这一次删不掉：编辑器页的发件箱 Worker 正拿着句柄，见 local-cleanup.ts）草稿与提示留着、写入者换成墓碑
   * （审查 A1：之后那一页的写入一律 not-writer；比对时不从镜像写回），之后再清时一起删
   */
  readonly removeUserData: (permit: UserCleanupPermit, options?: { readonly retire: readonly string[], readonly now: number }) => Promise<StoreClearOutcome>

  /**
   * 保留期（§3.4.7）：删掉已知格式、更新时间超过 14 天的草稿并在同事务留下 expired（不论属于谁；较新格式、时间读不出的留着）；写入者按 writerRetention——登记超过 14 天、
   * 又没有草稿的换成墓碑（审查 A6），形状不对、又没有草稿的删掉，墓碑留着（由合一的清理在镜像目录不在之后删）；以及留下超过 14 天、
   * 形状不对的提示（S9）
   */
  readonly purgeExpired: (now: number) => Promise<StorePurgeOutcome>

  /** 镜像独有的到期草稿已删除后留提示；事务内仍有主库原件时跳过，不覆盖重新写入的草稿。 */
  readonly recordExpiredMirror: (key: DraftKey, now: number) => Promise<{ readonly kind: 'recorded' | 'skipped' } | StoreProblem>

  /**
   * 把这份文档的写入者换成墓碑（审查 A1、A6：放弃时镜像目录删不掉）：高水位不低于现有草稿的序号；没有写入者时也立一块。草稿与提示不动
   */
  readonly retireWriter: (key: DraftKey, options: { readonly now: number }) => Promise<StoreRetireOutcome>

  /** 库里全部的墓碑（不论属于谁） */
  readonly listTombstones: () => Promise<StoreTombstonesOutcome>

  /** 删掉这几份文档的墓碑（它们的镜像目录已经不在了）；那一条已经换成活的写入者（又登记了）的不动 */
  readonly dropTombstones: (keys: readonly DraftKey[]) => Promise<StoreDropOutcome>

  /** 关掉连接（页面离开、Worker 结束）；之后的操作重新打开 */
  readonly close: () => void
}

export function createDraftMaintenanceStore(options: DraftStoreOptions): DraftMaintenanceStore {
  const transactions = createStoreTransactions(options)
  const run = async <T>(mode: IDBTransactionMode, body: (scope: TransactionScope<T>) => void, stores: readonly string[] = DRAFT_STORES): Promise<T | StoreProblem> => transactions.run(stores, mode, body)
  async function clean<T>(permit: UserCleanupPermit, body: (scope: TransactionScope<T | StoreProblem>, userId: string) => void): Promise<T | StoreProblem> {
    const fixed = readUserCleanupPermit(permit)
    if (fixed === undefined)
      return { kind: 'session-invalid' }
    return transactions.run<T | StoreProblem>([...ALL_STORES, SESSIONS_STORE], 'readwrite', (scope) => {
      scope.then(scope.tx.objectStore(SESSIONS_STORE).get(SESSION_SLOT) as IDBRequest<unknown>, (raw) => {
        if (!canCleanUserSession(readStoredSession(raw), fixed)) {
          scope.finish({ kind: 'session-invalid' })
          return
        }
        body(scope, fixed.userId)
      })
    })
  }
  return {
    retireUser: async (permit, { now }) => clean<StoreRetireOutcome>(permit, (scope, userId) => {
      // 三个仓库的文档取并集：只有草稿或提示的也立墓碑，防止清理途中镜像被另一个页面写回。
      const existing = new Map<string, ExistingDraft>()
      const documents = new Set<string>()
      scope.then(scope.tx.objectStore(DRAFTS_STORE).openCursor(userKeyRange(userId)), (cursor) => {
        if (cursor !== null) {
          const key = draftKeyOf(cursor.primaryKey)
          if (key !== undefined) {
            existing.set(key.documentId, readStoredDraft(cursor.value))
            documents.add(key.documentId)
          }
          cursor.continue()
          return
        }
        scope.then(scope.tx.objectStore(NOTICES_STORE).openKeyCursor(userKeyRange(userId)), (noticeCursor) => {
          if (noticeCursor !== null) {
            const key = draftKeyOf(noticeCursor.primaryKey)
            if (key !== undefined)
              documents.add(key.documentId)
            noticeCursor.continue()
            return
          }
          scope.then(scope.tx.objectStore(WRITERS_STORE).openCursor(userKeyRange(userId)), (writerCursor) => {
            if (writerCursor === null) {
              for (const documentId of documents) {
                const key = { userId, documentId }
                scope.tx.objectStore(WRITERS_STORE).put(retiredWriterOf(key, undefined, existing.get(documentId), now))
              }
              scope.finish({ kind: 'retired' })
              return
            }
            const key = draftKeyOf(writerCursor.primaryKey)
            if (key !== undefined) {
              writerCursor.update(retiredWriterOf(key, readWriterRecord(writerCursor.value), existing.get(key.documentId), now))
              documents.delete(key.documentId)
            }
            writerCursor.continue()
          })
        })
      })
    }),

    removeUserData: async (permit, removeOptions) => {
      const retire = new Set(removeOptions?.retire ?? [])
      const now = removeOptions?.now ?? 0
      return clean<StoreClearOutcome>(permit, (scope, userId) => {
        if (retire.size === 0) {
          for (const name of ALL_STORES)
            scope.tx.objectStore(name).delete(userKeyRange(userId))
          scope.finish({ kind: 'cleared' })
          return
        }
        // retire 里的几份：草稿与提示留着、写入者换成墓碑；别的删掉。草稿、提示、写入者依次各走一遍这个用户的键
        const existing = new Map<string, ExistingDraft>()
        const retiredWriters = new Set<string>()
        const walk = (name: string, onEntry: (cursor: IDBCursorWithValue, key: DraftKey | undefined) => void, done: () => void): void => {
          scope.then(scope.tx.objectStore(name).openCursor(userKeyRange(userId)), (cursor) => {
            if (cursor === null) {
              done()
              return
            }
            onEntry(cursor, draftKeyOf(cursor.primaryKey))
            cursor.continue()
          })
        }
        const kept = (key: DraftKey | undefined): key is DraftKey => key !== undefined && retire.has(key.documentId)
        walk(DRAFTS_STORE, (cursor, key) => {
          if (kept(key))
            existing.set(key.documentId, readStoredDraft(cursor.value))
          else
            cursor.delete()
        }, () => walk(NOTICES_STORE, (cursor, key) => {
          if (!kept(key))
            cursor.delete()
        }, () => walk(WRITERS_STORE, (cursor, key) => {
          if (!kept(key)) {
            cursor.delete()
            return
          }
          cursor.update(retiredWriterOf(key, readWriterRecord(cursor.value), existing.get(key.documentId), now))
          retiredWriters.add(key.documentId)
        }, () => {
          // 没有写入者的那几份同样立一块墓碑：挡住镜像里那一份被写回
          for (const documentId of retire) {
            if (!retiredWriters.has(documentId))
              scope.tx.objectStore(WRITERS_STORE).put(retiredWriterOf({ userId, documentId }, undefined, existing.get(documentId), now))
          }
          scope.finish({ kind: 'cleared' })
        })))
      })
    },

    purgeExpired: async now => run<StorePurgeOutcome>('readwrite', (scope) => {
      const purged: PurgedDraft[] = []
      const retained: DraftKey[] = []
      /** 留下来的草稿的键（JSON）：还有草稿的写入者不删，高水位要接着用 */
      const remaining = new Set<string>()
      scope.then(scope.tx.objectStore(DRAFTS_STORE).openCursor(), (cursor) => {
        if (cursor !== null) {
          const value: unknown = cursor.value
          const key = draftKeyOf(cursor.primaryKey)
          const record = readStoredDraft(value)
          if (record.kind !== 'newer-format' && shouldPurgeDraft(readableUpdatedAt(value), now)) {
            cursor.delete()
            if (key !== undefined) {
              purged.push({ key, record: record.kind })
              scope.tx.objectStore(NOTICES_STORE).put({ ...key, kind: 'expired', at: now })
            }
          }
          else {
            remaining.add(JSON.stringify(cursor.primaryKey))
            if (key !== undefined)
              retained.push(key)
          }
          cursor.continue()
          return
        }
        scope.then(scope.tx.objectStore(WRITERS_STORE).openCursor(), (writerCursor) => {
          if (writerCursor === null) {
            // 提示：留下超过 14 天的、形状不对的删掉
            scope.then(scope.tx.objectStore(NOTICES_STORE).openCursor(), (noticeCursor) => {
              if (noticeCursor === null) {
                scope.finish({ kind: 'purged', drafts: purged, retained })
                return
              }
              const notice = readRecoveryNotice(noticeCursor.value)
              if (notice === undefined || isNoticeExpired(notice, now))
                noticeCursor.delete()
              noticeCursor.continue()
            })
            return
          }
          const writer = readWriterRecord(writerCursor.value)
          const key = draftKeyOf(writerCursor.primaryKey)
          switch (writerRetention(writer, remaining.has(JSON.stringify(writerCursor.primaryKey)), now)) {
            case 'delete':
              writerCursor.delete()
              break
            case 'retire':
              if (key !== undefined)
                writerCursor.update(retiredWriterOf(key, writer, undefined, now))
              break
            case 'keep':
              break
          }
          writerCursor.continue()
        })
      })
    }, ALL_STORES),

    recordExpiredMirror: async (key, now) => run<{ readonly kind: 'recorded' | 'skipped' }>('readwrite', (scope) => {
      scope.then(scope.tx.objectStore(DRAFTS_STORE).get(draftKeyPath(key)) as IDBRequest<unknown>, (current) => {
        if (current !== undefined || !isWhole(now, 0)) {
          scope.finish({ kind: 'skipped' })
          return
        }
        scope.tx.objectStore(NOTICES_STORE).put({ ...key, kind: 'expired', at: now })
        scope.finish({ kind: 'recorded' })
      })
    }, [DRAFTS_STORE, NOTICES_STORE]),

    retireWriter: async (key, { now }) => run<StoreRetireOutcome>('readwrite', scope => retireDocument(scope, key, now)),

    listTombstones: async () => run<StoreTombstonesOutcome>('readonly', (scope) => {
      const keys: DraftKey[] = []
      scope.then(scope.tx.objectStore(WRITERS_STORE).openCursor(), (cursor) => {
        if (cursor === null) {
          scope.finish({ kind: 'tombstones', keys })
          return
        }
        const writer = readWriterRecord(cursor.value)
        const key = draftKeyOf(cursor.primaryKey)
        if (writer !== undefined && isRetired(writer) && key !== undefined)
          keys.push(key)
        cursor.continue()
      })
    }, [WRITERS_STORE]),

    dropTombstones: async keys => run<StoreDropOutcome>('readwrite', (scope) => {
      let waiting = keys.length
      if (waiting === 0) {
        scope.finish({ kind: 'dropped' })
        return
      }
      for (const key of keys) {
        scope.then(scope.tx.objectStore(WRITERS_STORE).get(draftKeyPath(key)), (value: unknown) => {
          const writer = readWriterRecord(value)
          if (writer !== undefined && isRetired(writer))
            scope.tx.objectStore(WRITERS_STORE).delete(draftKeyPath(key))
          waiting -= 1
          if (waiting === 0)
            scope.finish({ kind: 'dropped' })
        })
      }
    }, [WRITERS_STORE]),

    close: transactions.close,
  }
}
