// 本机发件箱的存储（M4-P1 设计 §3.2、§3.4）：IndexedDB 的事务。判定（writer-fence.ts）与写入在同一个 strict 事务里，
// 事务里只有 IndexedDB 的请求回调，不 await 加密、压缩这类别的异步（否则事务自动提交，判定与写入之间就能插进别的标签页）。
// 跨边界不抛异常：每个操作的结果都是带 kind 的值，写满、库用不了、未知的错误各有一种。
// 发件箱 Worker 也引用这个文件：不引用 zod，不依赖 DOM
import type { OutboxConnection, OutboxUnavailable } from './database.ts'
import type { DraftKey, DraftMeta, ReadDraft, StoredDraft, WriterRecord } from './draft-record.ts'
import type { RecoveryNotice, RecoveryNoticeKind } from './recovery-notice.ts'
import type { WriterIdentity } from './writer-fence.ts'
import { browserIndexedDb, draftKeyPath, DRAFTS_STORE, NOTICES_STORE, openOutboxDatabase, userKeyRange, WRITERS_STORE } from './database.ts'
import { draftMetaOf, readableUpdatedAt, readStoredDraft, readWriterRecord } from './draft-record.ts'
import { readRecoveryNotice } from './recovery-notice.ts'
import { decideConfirm, decideRegistration, decideRemove, decideReplace, decideRestore, decideWrite, isNoticeExpired, isSameWriter, restoredWriterOf, shouldPurgeDraft, shouldPurgeWriter } from './writer-fence.ts'

/**
 * 存储这一侧的问题：
 * - quota：写满（QuotaExceededError，put 上或提交时），整个事务回滚，原记录与高水位都不变（US-M4-11）；
 * - unavailable：库用不了（database.ts 的四种原因），调用方退化为内存实现；
 * - failed：别的错误，带上原样的错误（跨 Worker 时由协议折成名字与消息）
 */
export type StoreProblem
  = | { readonly kind: 'quota' }
    | OutboxUnavailable
    | { readonly kind: 'failed', readonly error: unknown }

/** 栅栏拒绝的原因（writer-fence.ts 的判定）：not-writer、stale-seq、foreign-draft 来自写入，changed 来自重封 */
export type FenceReason = 'not-writer' | 'stale-seq' | 'foreign-draft' | 'changed'

export type StoreRegisterOutcome
  /** 登记了：lastDraftSeq 是高水位（主线程从它往上分配序号），existing 是现有的草稿（有就由恢复决定，P3） */
  = | { readonly kind: 'registered', readonly lastDraftSeq: number, readonly existing: ReadDraft | undefined }
  /** 现有的写入者代次更大，或者同一代的另一次登记：由调用方向服务端核对，确实是当前的一代就以 force 重新登记 */
    | { readonly kind: 'superseded', readonly currentEpoch: number, readonly sameEpoch: boolean }
    | StoreProblem

export type StoreWriteOutcome
  = | { readonly kind: 'written' }
    | { readonly kind: 'fenced', readonly reason: FenceReason }
    | StoreProblem

export type StoreConfirmOutcome
  /** 草稿的序号不大于确认的：删了 */
  = | { readonly kind: 'deleted' }
  /** 草稿更新：换成了交进来的重封那一份（基准换成新的修订号、清掉在途） */
    | { readonly kind: 'rebased' }
  /** 已经没有草稿 */
    | { readonly kind: 'absent' }
  /** 要改基准，但交进来的重封那一份不是库里现在这一份（或者没给）：没有改动，由管道按库里现在的重新准备再来 */
    | { readonly kind: 'needs-rebase' }
  /** 写入者不是它，或者库里是别的写入者留下的（认不出的）草稿：不动 */
    | { readonly kind: 'fenced', readonly reason: 'not-writer' | 'foreign-draft' }
    | StoreProblem

/** 读回：认得出的草稿、更新的页面写的、形状不对的、没有 */
export type StoreReadOutcome = ReadDraft | { readonly kind: 'absent' } | StoreProblem

/** 列表里的一条：元数据，不交出密文；认不出的也列出来（本机草稿页要说明它们，P4） */
export type ListedDraft
  = | { readonly kind: 'draft', readonly meta: DraftMeta }
    | { readonly kind: 'newer-format', readonly key: DraftKey, readonly recordVersion: number }
    | { readonly kind: 'malformed', readonly key: DraftKey }

export type StoreListOutcome = { readonly kind: 'listed', readonly drafts: readonly ListedDraft[] } | StoreProblem

export type StoreRemoveOutcome = { readonly kind: 'removed' | 'changed' | 'absent' } | StoreProblem

export type StoreClearOutcome = { readonly kind: 'cleared' } | StoreProblem

/** 保留期清理删掉的一条：键，与它是认得出的草稿、更新的页面写的还是形状不对的（属于当前用户的由 P4 说明删了哪几份） */
export interface PurgedDraft {
  readonly key: DraftKey
  readonly record: ReadDraft['kind']
}

export type StorePurgeOutcome = { readonly kind: 'purged', readonly drafts: readonly PurgedDraft[] } | StoreProblem

/** 从 OPFS 镜像写回（§3.8）：写回了；没写回及原因（writer-fence.ts 的 decideRestore） */
export type StoreRestoreOutcome
  = | { readonly kind: 'restored' }
    | { readonly kind: 'kept', readonly reason: 'expired' | 'unrecognized' | 'not-newer' | 'seen' }
    | StoreProblem

/** 镜像里没有合格的一份可写回时（§3.8）：库里草稿与写入者都没了（删库），留下了 lost；库里还有（草稿被删掉了、正写着）没留 */
export type StoreLostOutcome = { readonly kind: 'noted' } | { readonly kind: 'kept' } | StoreProblem

export type StoreNoticesOutcome = { readonly kind: 'notices', readonly notices: readonly RecoveryNotice[] } | StoreProblem

/** 清除一条提示：清了；读出之后又留下了新的一条（时刻不同），没清；没有 */
export type StoreNoticeClearOutcome = { readonly kind: 'cleared' | 'changed' | 'absent' } | StoreProblem

export interface DraftStore {
  /**
   * 登记写入者（§3.4.2，取得编辑权并拿到本机锁之后）：[drafts, writers] 的 strict 事务里按 decideRegistration 判定；
   * 登记时 registeredAt 记为 now。force 的含义见 decideRegistration
   */
  readonly registerWriter: (key: DraftKey, writer: WriterIdentity, options: { readonly now: number, readonly force: boolean }) => Promise<StoreRegisterOutcome>
  /**
   * 写入（§3.4.3）：写入者取自记录本身（writeEpoch、writerId），序号是记录的 draftSeq；strict 事务里按 decideWrite 判定，
   * ok 就写草稿、把高水位抬到这个序号；duplicate 按已写入。adoptSeq：接手别的写入者留下的那一份（调用方确实看过它，P3）。
   * 形状不对的记录不写（failed）：存进去的一律读得回来
   */
  readonly writeDraft: (draft: StoredDraft, options?: { readonly adoptSeq?: number }) => Promise<StoreWriteOutcome>
  /**
   * 重封（标记在途、换密钥、确认之后改基准，§3.4.4）：比较并交换——写入者仍是记录上的那一个、库里仍是它写下的、
   * 序号与 draft.draftSeq 相同的那一份才写（decideReplace），否则 fenced（not-writer 或 changed）
   */
  readonly replaceDraft: (draft: StoredDraft) => Promise<StoreWriteOutcome>
  /**
   * 确认（§3.4.5）：服务端确认了 confirmedSeq。strict 事务里按 decideConfirm 判定：不大于它的删掉；更新的换成 rebased
   * （管道事先按"草稿是不是更新"准备好的重封那一份：基准是新的修订号、不在途）——rebased 不是库里现在这一份（同一个写入者、
   * 同一个序号）时交回 needs-rebase、不改动；形状不对、不是这份文档的交回 failed
   */
  readonly confirmDraft: (key: DraftKey, writer: WriterIdentity, confirmedSeq: number, rebased: StoredDraft | undefined) => Promise<StoreConfirmOutcome>
  readonly readDraft: (key: DraftKey) => Promise<StoreReadOutcome>
  /** 某个用户在这台设备上的全部草稿（元数据，不交出密文） */
  readonly listDrafts: (userId: string) => Promise<StoreListOutcome>
  /**
   * 放弃（用户的决定，不核对写入者，§3.4.7）：带 expectedSeq 时只删那一份（decideRemove）；这份文档的提示一并删（S9）。
   * 写入者留着：它的高水位挡住镜像里没删掉的那一份被写回（decideRestore 的 seen）
   */
  readonly removeDraft: (key: DraftKey, expectedSeq?: number) => Promise<StoreRemoveOutcome>
  /**
   * 按用户清理（退出登录、账户停用）：草稿、写入者与提示在一个事务里一起删；之后才到的写入因写入者不在而 not-writer。
   * keepDocumentIds 里的文档留着（S9：它的镜像目录这一次删不掉，库里的也留着，免得下一次比对时把镜像里的写回来；见 local-cleanup.ts）
   */
  readonly removeUserData: (userId: string, options?: { readonly keepDocumentIds?: readonly string[] }) => Promise<StoreClearOutcome>
  /**
   * 保留期（§3.4.7）：删掉读得出的更新时间超过 14 天的草稿（不论属于谁、不论格式；读不出的留着），登记超过 14 天、又没有草稿的写入者，
   * 以及留下超过 14 天、形状不对的提示（S9）
   */
  readonly purgeExpired: (now: number) => Promise<StorePurgeOutcome>
  /**
   * 从 OPFS 镜像写回（§3.8，S9）：镜像里校验通过、比库里新的那一份。strict 事务里按 decideRestore 判定：写回时连同写入者的记录
   * （没有就建、更早的一代就换、就是它就抬高水位，更新的一代不动），并在同一个事务里留下 restored 提示（时刻是 now）；
   * 不写回时交回原因。形状不对的记录不写（failed）
   */
  readonly restoreDraft: (draft: StoredDraft, options: { readonly now: number }) => Promise<StoreRestoreOutcome>
  /**
   * 镜像的槽位都不合格（写一半、对不上）、没有可写回的（§3.8）：strict 事务里核对库里这份文档的草稿与写入者都没了（删库）才留下 lost
   * 提示（时刻是 now）；还有任何一样（草稿被确认删掉、放弃过，或者正写着）不留
   */
  readonly recordLost: (key: DraftKey, options: { readonly now: number }) => Promise<StoreLostOutcome>
  /** 这个用户的提示（P3 打开文档时、P4 本机草稿页读出说明）；形状不对的不列 */
  readonly listNotices: (userId: string) => Promise<StoreNoticesOutcome>
  /** 说明过之后清除这份文档的提示：带 expectedAt 时只清那一条（读出之后又留下的新提示留着，changed） */
  readonly clearNotice: (key: DraftKey, expectedAt?: number) => Promise<StoreNoticeClearOutcome>
  /** 关掉连接（页面离开、Worker 结束）；之后的操作重新打开 */
  readonly close: () => void
}

export interface DraftStoreOptions {
  /** 取 IndexedDB 的工厂（database.ts 的 browserIndexedDb，页面与 Worker 里都是 globalThis.indexedDB） */
  readonly factory?: () => IDBFactory | undefined
  /** 升级被别的标签页挡住时等多久（毫秒） */
  readonly blockedTimeoutMs: number
}

/** 一次事务的结局：提交了（带判定的结果），或者中止了（带错误：写满、连接断开……，提交时写满同样在这里） */
type Settled<T>
  = | { readonly kind: 'committed', readonly value: T }
    | { readonly kind: 'aborted', readonly error: unknown }

/** 事务里的写法：结果经 finish 记下，提交之后才交回；请求的回调经 then 挂上——回调里抛出的错误中止事务、交回这个错误 */
interface TransactionScope<T> {
  readonly tx: IDBTransaction
  readonly finish: (value: T) => void
  readonly then: <R>(request: IDBRequest<R>, callback: (value: R) => void) => void
}

function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : undefined
}

/** 写满：put 上或提交时的 QuotaExceededError，整个事务回滚 */
function isQuota(error: unknown): boolean {
  return errorName(error) === 'QuotaExceededError'
}

/**
 * 连接断了：连接正在关闭时开事务（InvalidStateError）、Safari 的"Connection to Indexed Database server lost"（UnknownError）。
 * 中止了的事务什么也没写，重开一次再试；写入的重试是幂等的（同一写入者同一序号按 duplicate）
 */
function isConnectionLost(error: unknown): boolean {
  const name = errorName(error)
  return name === 'InvalidStateError' || name === 'UnknownError'
}

/** 非安全上下文里没有 crypto.subtle：草稿加密不了，发件箱整个用不了 */
function hasSubtleCrypto(): boolean {
  return (globalThis.crypto as { readonly subtle?: SubtleCrypto } | undefined)?.subtle !== undefined
}

/** 草稿与写入者：登记、写入、重封、确认、读回的事务开在这两个仓库上 */
const DRAFT_STORES: readonly string[] = [DRAFTS_STORE, WRITERS_STORE]

/** 连同提示（S9）：写回、丢失、按用户清理、保留期 */
const ALL_STORES: readonly string[] = [DRAFTS_STORE, WRITERS_STORE, NOTICES_STORE]

/**
 * 在 stores 上开一个事务：读写的一律 strict（报告写完之前要求落盘，00 号计划书 §7.5）。body 里只用请求的回调，
 * 不 await 别的异步（否则事务自动提交，判定与写入之间就能插进别的标签页）。开事务本身抛出（连接正在关闭）由调用方接住
 */
async function transact<T>(db: IDBDatabase, mode: IDBTransactionMode, stores: readonly string[], body: (scope: TransactionScope<T>) => void): Promise<Settled<T>> {
  const tx = mode === 'readwrite' ? db.transaction([...stores], mode, { durability: 'strict' }) : db.transaction([...stores], mode)
  return new Promise((resolve) => {
    let result: { readonly value: T } | undefined
    let failure: { readonly error: unknown } | undefined
    const fail = (error: unknown): void => {
      failure ??= { error }
      try {
        tx.abort()
      }
      catch {
        // 事务已经结束（提交或中止过了）：结局由 complete 或 abort 交回
      }
    }
    tx.oncomplete = () => resolve(result === undefined ? { kind: 'aborted', error: new Error('事务提交了，却没有给出结果') } : { kind: 'committed', value: result.value })
    tx.onabort = () => resolve({ kind: 'aborted', error: failure?.error ?? tx.error ?? new DOMException('事务被中止', 'AbortError') })
    const scope: TransactionScope<T> = {
      tx,
      finish: (value) => {
        result = { value }
      },
      then: (request, callback) => {
        request.onsuccess = () => {
          try {
            callback(request.result)
          }
          catch (error) {
            fail(error)
          }
        }
      },
    }
    try {
      body(scope)
    }
    catch (error) {
      fail(error)
    }
  })
}

/**
 * 同一个事务里读出这份文档的写入者与草稿：请求按发出的顺序完成，草稿的回调里两个都有了。形状不对的写入者当作没有（readWriterRecord）
 */
function readCurrent<T>(scope: TransactionScope<T>, key: DraftKey, then: (writer: WriterRecord | undefined, existing: ReadDraft | undefined) => void): void {
  const path = draftKeyPath(key)
  const writerRequest = scope.tx.objectStore(WRITERS_STORE).get(path)
  scope.then(scope.tx.objectStore(DRAFTS_STORE).get(path), (draftValue: unknown) => {
    const writerValue: unknown = writerRequest.result
    then(writerValue === undefined ? undefined : readWriterRecord(writerValue), draftValue === undefined ? undefined : readStoredDraft(draftValue))
  })
}

/** 库里的键 [userId, documentId]；不是两个字符串时为 undefined（不是本页写的，列表里不列它） */
function draftKeyOf(key: IDBValidKey): DraftKey | undefined {
  if (!Array.isArray(key) || key.length !== 2)
    return undefined
  const [userId, documentId] = key as readonly unknown[]
  return typeof userId === 'string' && typeof documentId === 'string' ? { userId, documentId } : undefined
}

function listed(key: DraftKey, read: ReadDraft): ListedDraft {
  switch (read.kind) {
    case 'draft':
      return { kind: 'draft', meta: draftMetaOf(read.draft) }
    case 'newer-format':
      return { kind: 'newer-format', key, recordVersion: read.recordVersion }
    case 'malformed':
      return { kind: 'malformed', key }
  }
}

function failed(message: string): { readonly kind: 'failed', readonly error: unknown } {
  return { kind: 'failed', error: new TypeError(message) }
}

function noticeOf(key: DraftKey, kind: RecoveryNoticeKind, at: number): RecoveryNotice {
  return { userId: key.userId, documentId: key.documentId, kind, at }
}

/**
 * IndexedDB 的发件箱存储：连接按需打开、复用；versionchange 时连接自己关掉（别的标签页升级、删库），下一次操作重新打开。
 * 每个操作一个事务；事务因连接断开而中止时重开一次再试，写满归为 quota，别的错误归为 failed
 */
export function createDraftStore(options: DraftStoreOptions): DraftStore {
  const factory = options.factory ?? browserIndexedDb
  let connection: OutboxConnection | undefined
  let opening: Promise<OutboxConnection | OutboxUnavailable> | undefined

  async function connect(): Promise<OutboxConnection | OutboxUnavailable> {
    if (connection !== undefined && !connection.isClosed())
      return connection
    if (!hasSubtleCrypto())
      return { kind: 'unavailable', reason: 'unsupported' }
    opening ??= openOutboxDatabase({ factory, blockedTimeoutMs: options.blockedTimeoutMs }).then((result) => {
      opening = undefined
      if (result.kind === 'connected')
        connection = result
      return result
    })
    return opening
  }

  async function run<T>(mode: IDBTransactionMode, body: (scope: TransactionScope<T>) => void, stores: readonly string[] = DRAFT_STORES): Promise<T | StoreProblem> {
    for (let attempt = 1; ; attempt += 1) {
      const current = await connect()
      if (current.kind === 'unavailable')
        return current
      let settled: Settled<T>
      try {
        settled = await transact(current.db, mode, stores, body)
      }
      catch (error) {
        settled = { kind: 'aborted', error }
      }
      if (settled.kind === 'committed')
        return settled.value
      if (isQuota(settled.error))
        return { kind: 'quota' }
      if (attempt === 1 && isConnectionLost(settled.error)) {
        current.close()
        continue
      }
      return { kind: 'failed', error: settled.error }
    }
  }

  return {
    registerWriter: async (key, writer, { now, force }) => {
      const record: WriterRecord = { userId: key.userId, documentId: key.documentId, writeEpoch: writer.writeEpoch, writerId: writer.writerId, lastDraftSeq: 0, registeredAt: now }
      if (readWriterRecord(record) === undefined)
        return failed('写入者的形状不对：不登记')
      return run<StoreRegisterOutcome>('readwrite', (scope) => {
        readCurrent(scope, key, (current, existing) => {
          const verdict = decideRegistration(current, existing, writer, force)
          if (verdict.kind === 'superseded') {
            scope.finish(verdict)
            return
          }
          scope.tx.objectStore(WRITERS_STORE).put({ ...record, lastDraftSeq: verdict.lastDraftSeq })
          scope.finish({ kind: 'registered', lastDraftSeq: verdict.lastDraftSeq, existing })
        })
      })
    },

    writeDraft: async (draft, writeOptions) => {
      const checked = readStoredDraft(draft)
      if (checked.kind !== 'draft')
        return failed('草稿的形状不对：不写（存进去的一律要读得回来）')
      const record = checked.draft
      return run<StoreWriteOutcome>('readwrite', (scope) => {
        readCurrent(scope, record, (current, existing) => {
          const verdict = decideWrite(current, existing, { writeEpoch: record.writeEpoch, writerId: record.writerId, draftSeq: record.draftSeq, adoptSeq: writeOptions?.adoptSeq })
          switch (verdict) {
            case 'ok':
              scope.tx.objectStore(DRAFTS_STORE).put(record)
              if (current !== undefined)
                scope.tx.objectStore(WRITERS_STORE).put({ ...current, lastDraftSeq: record.draftSeq })
              scope.finish({ kind: 'written' })
              return
            case 'duplicate':
              scope.finish({ kind: 'written' })
              return
            case 'not-writer':
            case 'stale-seq':
            case 'foreign-draft':
              scope.finish({ kind: 'fenced', reason: verdict })
          }
        })
      })
    },

    replaceDraft: async (draft) => {
      const checked = readStoredDraft(draft)
      if (checked.kind !== 'draft')
        return failed('草稿的形状不对：不写（存进去的一律要读得回来）')
      const record = checked.draft
      return run<StoreWriteOutcome>('readwrite', (scope) => {
        readCurrent(scope, record, (current, existing) => {
          const verdict = decideReplace(current, existing, { writeEpoch: record.writeEpoch, writerId: record.writerId, expectedSeq: record.draftSeq })
          if (verdict !== 'ok') {
            scope.finish({ kind: 'fenced', reason: verdict })
            return
          }
          scope.tx.objectStore(DRAFTS_STORE).put(record)
          scope.finish({ kind: 'written' })
        })
      })
    },

    confirmDraft: async (key, writer, confirmedSeq, rebased) => {
      let prepared: StoredDraft | undefined
      if (rebased !== undefined) {
        // 形状不对、不是这份文档的：调用方的错（写进去会落到别的键上），不写
        const checked = readStoredDraft(rebased)
        if (checked.kind !== 'draft' || checked.draft.userId !== key.userId || checked.draft.documentId !== key.documentId)
          return failed('重封的那一份形状不对，或者不是这份文档的')
        prepared = checked.draft
      }
      return run<StoreConfirmOutcome>('readwrite', (scope) => {
        readCurrent(scope, key, (current, existing) => {
          const verdict = decideConfirm(current, existing, { ...writer, confirmedSeq })
          switch (verdict) {
            case 'delete':
              scope.tx.objectStore(DRAFTS_STORE).delete(draftKeyPath(key))
              scope.finish({ kind: 'deleted' })
              return
            case 'rebase':
              // 交来的重封那一份就是库里现在这一份：同一个写入者（代次与 writerId）、同一个序号（与写入管道的假存储同一个口径）；不是就由管道重做
              if (prepared !== undefined && existing?.kind === 'draft' && isSameWriter(prepared, existing.draft) && prepared.draftSeq === existing.draft.draftSeq) {
                scope.tx.objectStore(DRAFTS_STORE).put(prepared)
                scope.finish({ kind: 'rebased' })
                return
              }
              scope.finish({ kind: 'needs-rebase' })
              return
            case 'absent':
              scope.finish({ kind: 'absent' })
              return
            case 'not-writer':
            case 'foreign-draft':
              scope.finish({ kind: 'fenced', reason: verdict })
          }
        })
      })
    },

    readDraft: async key => run<StoreReadOutcome>('readonly', (scope) => {
      scope.then(scope.tx.objectStore(DRAFTS_STORE).get(draftKeyPath(key)), (value: unknown) => {
        scope.finish(value === undefined ? { kind: 'absent' } : readStoredDraft(value))
      })
    }),

    listDrafts: async userId => run<StoreListOutcome>('readonly', (scope) => {
      const drafts: ListedDraft[] = []
      scope.then(scope.tx.objectStore(DRAFTS_STORE).openCursor(userKeyRange(userId)), (cursor) => {
        if (cursor === null) {
          scope.finish({ kind: 'listed', drafts })
          return
        }
        const key = draftKeyOf(cursor.primaryKey)
        if (key !== undefined)
          drafts.push(listed(key, readStoredDraft(cursor.value)))
        cursor.continue()
      })
    }),

    removeDraft: async (key, expectedSeq) => run<StoreRemoveOutcome>('readwrite', (scope) => {
      scope.then(scope.tx.objectStore(DRAFTS_STORE).get(draftKeyPath(key)), (value: unknown) => {
        const verdict = decideRemove(value === undefined ? undefined : readStoredDraft(value), expectedSeq)
        if (verdict === 'remove') {
          scope.tx.objectStore(DRAFTS_STORE).delete(draftKeyPath(key))
          scope.tx.objectStore(NOTICES_STORE).delete(draftKeyPath(key))
        }
        scope.finish({ kind: verdict === 'remove' ? 'removed' : verdict })
      })
    }, [DRAFTS_STORE, NOTICES_STORE]),

    removeUserData: async (userId, removeOptions) => {
      const keep = new Set(removeOptions?.keepDocumentIds ?? [])
      return run<StoreClearOutcome>('readwrite', (scope) => {
        if (keep.size === 0) {
          for (const name of ALL_STORES)
            scope.tx.objectStore(name).delete(userKeyRange(userId))
          scope.finish({ kind: 'cleared' })
          return
        }
        // 留下几份：三个仓库各走一遍这个用户的键，不在 keep 里的删掉；三遍都走完才算清完
        let walking = ALL_STORES.length
        for (const name of ALL_STORES) {
          scope.then(scope.tx.objectStore(name).openCursor(userKeyRange(userId)), (cursor) => {
            if (cursor === null) {
              walking -= 1
              if (walking === 0)
                scope.finish({ kind: 'cleared' })
              return
            }
            const key = draftKeyOf(cursor.primaryKey)
            if (key === undefined || !keep.has(key.documentId))
              cursor.delete()
            cursor.continue()
          })
        }
      }, ALL_STORES)
    },

    purgeExpired: async now => run<StorePurgeOutcome>('readwrite', (scope) => {
      const purged: PurgedDraft[] = []
      /** 留下来的草稿的键（JSON）：还有草稿的写入者不删，高水位要接着用 */
      const remaining = new Set<string>()
      scope.then(scope.tx.objectStore(DRAFTS_STORE).openCursor(), (cursor) => {
        if (cursor !== null) {
          const value: unknown = cursor.value
          const key = draftKeyOf(cursor.primaryKey)
          if (shouldPurgeDraft(readableUpdatedAt(value), now)) {
            cursor.delete()
            if (key !== undefined)
              purged.push({ key, record: readStoredDraft(value).kind })
          }
          else {
            remaining.add(JSON.stringify(cursor.primaryKey))
          }
          cursor.continue()
          return
        }
        scope.then(scope.tx.objectStore(WRITERS_STORE).openCursor(), (writerCursor) => {
          if (writerCursor === null) {
            // 提示：留下超过 14 天的、形状不对的删掉
            scope.then(scope.tx.objectStore(NOTICES_STORE).openCursor(), (noticeCursor) => {
              if (noticeCursor === null) {
                scope.finish({ kind: 'purged', drafts: purged })
                return
              }
              const notice = readRecoveryNotice(noticeCursor.value)
              if (notice === undefined || isNoticeExpired(notice, now))
                noticeCursor.delete()
              noticeCursor.continue()
            })
            return
          }
          const writerValue: unknown = writerCursor.value
          if (shouldPurgeWriter(readWriterRecord(writerValue), remaining.has(JSON.stringify(writerCursor.primaryKey)), now))
            writerCursor.delete()
          writerCursor.continue()
        })
      })
    }, ALL_STORES),

    restoreDraft: async (draft, { now }) => {
      const checked = readStoredDraft(draft)
      if (checked.kind !== 'draft')
        return failed('镜像的那一份形状不对：不写回')
      const record = checked.draft
      return run<StoreRestoreOutcome>('readwrite', (scope) => {
        readCurrent(scope, record, (current, existing) => {
          const verdict = decideRestore(current, existing, record, now)
          if (verdict.kind === 'skip') {
            scope.finish({ kind: 'kept', reason: verdict.reason })
            return
          }
          scope.tx.objectStore(DRAFTS_STORE).put(record)
          const restoredWriter = restoredWriterOf(current, record, verdict.writer, now)
          if (restoredWriter !== undefined)
            scope.tx.objectStore(WRITERS_STORE).put(restoredWriter)
          scope.tx.objectStore(NOTICES_STORE).put(noticeOf(record, 'restored', now))
          scope.finish({ kind: 'restored' })
        })
      }, ALL_STORES)
    },

    recordLost: async (key, { now }) => run<StoreLostOutcome>('readwrite', (scope) => {
      readCurrent(scope, key, (current, existing) => {
        if (current !== undefined || existing !== undefined) {
          scope.finish({ kind: 'kept' })
          return
        }
        scope.tx.objectStore(NOTICES_STORE).put(noticeOf(key, 'lost', now))
        scope.finish({ kind: 'noted' })
      })
    }, ALL_STORES),

    listNotices: async userId => run<StoreNoticesOutcome>('readonly', (scope) => {
      const notices: RecoveryNotice[] = []
      scope.then(scope.tx.objectStore(NOTICES_STORE).openCursor(userKeyRange(userId)), (cursor) => {
        if (cursor === null) {
          scope.finish({ kind: 'notices', notices })
          return
        }
        const notice = readRecoveryNotice(cursor.value)
        if (notice !== undefined)
          notices.push(notice)
        cursor.continue()
      })
    }, [NOTICES_STORE]),

    clearNotice: async (key, expectedAt) => run<StoreNoticeClearOutcome>('readwrite', (scope) => {
      scope.then(scope.tx.objectStore(NOTICES_STORE).get(draftKeyPath(key)), (value: unknown) => {
        if (value === undefined) {
          scope.finish({ kind: 'absent' })
          return
        }
        const notice = readRecoveryNotice(value)
        if (expectedAt !== undefined && notice !== undefined && notice.at !== expectedAt) {
          scope.finish({ kind: 'changed' })
          return
        }
        scope.tx.objectStore(NOTICES_STORE).delete(draftKeyPath(key))
        scope.finish({ kind: 'cleared' })
      })
    }, [NOTICES_STORE]),

    close: () => {
      connection?.close()
      connection = undefined
    },
  }
}
