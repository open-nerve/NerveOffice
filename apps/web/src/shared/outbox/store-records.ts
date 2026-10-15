// 草稿与维护存储共用的记录读取、键和墓碑操作；由调用方的同一个 IDB 事务承载。
import type { DraftKey, ReadDraft, WriterRecord } from './draft-record.ts'
import type { StoreRetireOutcome } from './draft-store.ts'
import type { TransactionScope } from './store-transaction.ts'
import { draftKeyPath, DRAFTS_STORE, NOTICES_STORE, WRITERS_STORE } from './database.ts'
import { readStoredDraft, readWriterRecord } from './draft-record.ts'
import { retiredWriterOf } from './writer-fence.ts'

/** 草稿与写入者：登记、写入、重封、确认、读回的事务开在这两个仓库上 */
export const DRAFT_STORES: readonly string[] = [DRAFTS_STORE, WRITERS_STORE]

/** 连同提示（S9）：写回、丢失、按用户清理、保留期 */
export const ALL_STORES: readonly string[] = [DRAFTS_STORE, WRITERS_STORE, NOTICES_STORE]

/**
 * 同一个事务里读出这份文档的写入者与草稿：请求按发出的顺序完成，草稿的回调里两个都有了。形状不对的写入者当作没有（readWriterRecord）
 */
export function readCurrent<T>(scope: TransactionScope<T>, key: DraftKey, then: (writer: WriterRecord | undefined, existing: ReadDraft | undefined) => void, seen?: (draft: unknown) => void): void {
  readRawCurrent(scope, key, (draftValue, writerValue) => {
    then(writerValue === undefined ? undefined : readWriterRecord(writerValue), draftValue === undefined ? undefined : readStoredDraft(draftValue))
  }, seen)
}

/** 恢复凭证比较原始值，不能把两份不同的 malformed 折成同一种结果。 */
export function readRawCurrent<T>(scope: TransactionScope<T>, key: DraftKey, then: (draft: unknown, writer: unknown) => void, seen?: (draft: unknown) => void): void {
  const path = draftKeyPath(key)
  const writerRequest = scope.tx.objectStore(WRITERS_STORE).get(path)
  scope.then(scope.tx.objectStore(DRAFTS_STORE).get(path), (draftValue: unknown) => {
    seen?.(draftValue)
    const writerValue: unknown = writerRequest.result
    then(draftValue, writerValue)
  })
}

/** 库里的键 [userId, documentId]；不是两个字符串时为 undefined（不是本页写的，列表里不列它） */
export function draftKeyOf(key: IDBValidKey): DraftKey | undefined {
  if (!Array.isArray(key) || key.length !== 2)
    return undefined
  const [userId, documentId] = key as readonly unknown[]
  return typeof userId === 'string' && typeof documentId === 'string' ? { userId, documentId } : undefined
}

export function retireDocument(scope: TransactionScope<StoreRetireOutcome>, key: DraftKey, now: number): void {
  readCurrent(scope, key, (current, existing) => {
    scope.tx.objectStore(WRITERS_STORE).put(retiredWriterOf(key, current, existing, now))
    scope.finish({ kind: 'retired' })
  })
}
