// 本机发件箱的存储（M4-P1 设计 §3.2、§3.4）：IndexedDB 的事务。判定（writer-fence.ts）与写入在同一个 strict 事务里，
// 事务里只有 IndexedDB 的请求回调，不 await 加密、压缩这类别的异步（否则事务自动提交，判定与写入之间就能插进别的标签页）。
// 跨边界不抛异常：每个操作的结果都是带 kind 的值，写满、库用不了、未知的错误各有一种。
// 发件箱 Worker 也引用这个文件：不引用 zod，不依赖 DOM
import type { DraftObservation, ObservedValues } from './draft-observation.ts'
import type { DraftKey, DraftMeta, ReadDraft, StoredDraft, WriterRecord } from './draft-record.ts'
import type { RecoveryNotice, RecoveryNoticeKind } from './recovery-notice.ts'
import type { DraftSessionPermit } from './session-fence.ts'
import type { StoreOptions as DraftStoreOptions, SessionInvalid, StoreProblem, TransactionScope } from './store-transaction.ts'
import type { RestoreVerdict, WriterIdentity } from './writer-fence.ts'
import { draftKeyPath, DRAFTS_STORE, NOTICES_STORE, SESSION_SLOT, SESSIONS_STORE, userKeyRange, WRITERS_STORE } from './database.ts'
import { createDraftObservations } from './draft-observation.ts'
import { draftMetaOf, readStoredDraft, readWriterRecord } from './draft-record.ts'
import { readRecoveryNotice } from './recovery-notice.ts'
import { canUseDraftSession, readDraftSessionPermit } from './session-fence.ts'
import { readStoredActiveSession } from './session-record.ts'
import { ALL_STORES, DRAFT_STORES, draftKeyOf, readCurrent, readRawCurrent, retireDocument } from './store-records.ts'
import { createStoreTransactions, isStoreProblem } from './store-transaction.ts'
import { decideConfirm, decideObservedAdoption, decideRegistration, decideRemove, decideReplace, decideRestore, decideWrite, isRetired, isSameWriter, restoredWriterOf, retiredWriterOf } from './writer-fence.ts'

export type { StoreOptions as DraftStoreOptions, StoreProblem } from './store-transaction.ts'

/** 恢复读取已经见到原件后，事务失败仍保留事实；不包含未提交的观察凭证。 */
export type StoreRecoveryProblem = StoreProblem & { readonly recordKnown?: true }

/** 栅栏拒绝的原因（writer-fence.ts 的判定）：not-writer、stale-seq、foreign-draft 来自写入，changed 来自重封 */
export type FenceReason = 'not-writer' | 'stale-seq' | 'foreign-draft' | 'changed'

export type StoreRegisterOutcome
  /** 登记了：lastDraftSeq 是高水位（主线程从它往上分配序号），existing 是现有的草稿（有就由恢复决定，P3） */
  = | { readonly kind: 'registered', readonly lastDraftSeq: number, readonly existing: ReadDraft | undefined, readonly recordKnown?: true }
  /** 现有的写入者代次更大，或者同一代的另一次登记：由调用方向服务端核对，确实是当前的一代就以 force 重新登记 */
    | { readonly kind: 'superseded', readonly currentEpoch: number, readonly sameEpoch: boolean, readonly recordKnown?: true }
    | StoreRecoveryProblem

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
export type StoreReadOutcome = ReadDraft | { readonly kind: 'absent' } | StoreRecoveryProblem

export type StoreObservedOutcome
  = | { readonly kind: 'observed', readonly observation: DraftObservation, readonly record: ReadDraft | { readonly kind: 'absent' }, readonly writer: WriterRecord | undefined }
    | StoreRecoveryProblem

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

/** 从 OPFS 镜像写回（§3.8）：写回了；没写回及原因（writer-fence.ts 的 decideRestore；unseen 时库里留下了 lost 提示） */
export type StoreRestoreOutcome
  = | { readonly kind: 'restored' }
    | { readonly kind: 'kept', readonly reason: Extract<RestoreVerdict, { readonly kind: 'skip' }>['reason'] }
    | StoreProblem

/** 把写入者换成墓碑（审查 A1、A6）：换了 */
export type StoreRetireOutcome = { readonly kind: 'retired' } | StoreProblem

/** 库里的墓碑（不论属于谁）：合一的清理据此删掉镜像目录已经不在的那几块 */
export type StoreTombstonesOutcome = { readonly kind: 'tombstones', readonly keys: readonly DraftKey[] } | StoreProblem

export type StoreDropOutcome = { readonly kind: 'dropped' } | StoreProblem

/** 镜像里没有合格的一份可写回时（§3.8）：库里草稿与写入者都没了（删库），留下了 lost；库里还有（草稿被删掉了、正写着）没留 */
export type StoreLostOutcome = { readonly kind: 'noted' } | { readonly kind: 'kept' } | StoreProblem

export type StoreNoticesOutcome = { readonly kind: 'notices', readonly notices: readonly RecoveryNotice[] } | StoreProblem

/** 清除一条提示：清了；读出之后又留下了新的一条（时刻不同），没清；没有 */
export type StoreNoticeClearOutcome = { readonly kind: 'cleared' | 'changed' | 'absent' } | StoreProblem

export interface DraftStore {
  /** 一个存储实例只绑定一个请求取得的会话许可，不能从当前状态借用新代次。 */
  readonly bindSession: (permit: DraftSessionPermit) => Promise<{ readonly kind: 'bound' } | StoreProblem>
  /** 完整主库/镜像操作持锁后先核对；具体用户事务仍再次核对，不能用这次读取替代。 */
  readonly checkSession: (userId: string) => Promise<{ readonly kind: 'bound' } | StoreProblem>
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

  /** 一次只读事务观察草稿、写入者及提示；每个文档只保留最新凭证，关闭后不能续用。 */
  readonly observeDraft: (key: DraftKey) => Promise<StoreObservedOutcome>

  /** 同一 strict 事务比较完整原件和写入者，只有当前写入者以新序号接手；凭证与记录的键必须一致。 */
  readonly adoptObserved: (observation: DraftObservation, draft: StoredDraft) => Promise<StoreWriteOutcome>

  /** 同一 strict 事务条件删除并立墓碑；未变化的原提示一并清理，新提示保留。 */
  readonly removeObserved: (observation: DraftObservation, now: number) => Promise<StoreRemoveOutcome>

  /** 某个用户在这台设备上的全部草稿（元数据，不交出密文） */
  readonly listDrafts: (userId: string) => Promise<StoreListOutcome>

  /**
   * 放弃（用户的决定，不核对写入者，§3.4.7）：带 expectedSeq 时只删那一份（decideRemove）；这份文档的提示一并删（S9）。
   * 写入者留着：它的高水位挡住镜像里没删掉的那一份被写回（decideRestore 的 seen）
   */
  readonly removeDraft: (key: DraftKey, expectedSeq?: number) => Promise<StoreRemoveOutcome>

  /**
   * 把这份文档的写入者换成墓碑（审查 A1、A6：放弃时镜像目录删不掉）：高水位不低于现有草稿的序号；没有写入者时也立一块。草稿与提示不动
   */
  readonly retireWriter: (key: DraftKey, options: { readonly now: number }) => Promise<StoreRetireOutcome>

  /**
   * 从 OPFS 镜像写回（§3.8，S9）：镜像里校验通过的最新一份。strict 事务里按 decideRestore 判定（审查 A2 与它的订正：按库里写入者的
   * 高水位与代次）：写回时连同写入者的记录（没有就照它建、库丢了更新的登记就换成它的、就是它就抬高水位、同代或更新的写入者还没写过草稿
   * 或者库里是它那个写入者更早的一份就不动），并在同一个事务里留下 restored 提示（时刻是 now）；不写回时交回原因。unseen（库里的写入者
   * 没看过它、库里却是别的写入者的草稿，复验 C1）在同一个事务里留下 lost 提示——库里已经是一条 lost 提示时不动它（比对一再遇到同一份，
   * 时刻不变，P3 按读出的时刻清除照样清得掉）。形状不对的记录不写（failed）
   */
  readonly restoreDraft: (draft: StoredDraft, options: { readonly now: number, readonly noteLost?: boolean }) => Promise<StoreRestoreOutcome>

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

function withRecordPresence<T extends { readonly kind: string }>(result: T, recordKnown: boolean): T & { readonly recordKnown?: true } {
  return recordKnown ? { ...result, recordKnown: true } : result
}

function noticeOf(key: DraftKey, kind: RecoveryNoticeKind, at: number): RecoveryNotice {
  return { userId: key.userId, documentId: key.documentId, kind, at }
}

/**
 * IndexedDB 的发件箱存储：连接按需打开、复用；versionchange 时连接自己关掉（别的标签页升级、删库），下一次操作重新打开。
 * 每个操作一个事务；事务因连接断开而中止时重开一次再试，写满归为 quota，别的错误归为 failed
 */
export function createDraftStore(options: DraftStoreOptions): DraftStore {
  const transactions = createStoreTransactions(options)
  const observations = createDraftObservations()
  let observationGeneration = 0
  let bound: DraftSessionPermit | undefined
  async function run<T>(userId: string, mode: IDBTransactionMode, body: (scope: TransactionScope<T>) => void, stores: readonly string[] = DRAFT_STORES): Promise<T | StoreProblem> {
    const permit = bound
    if (permit === undefined || permit.userId !== userId)
      return { kind: 'session-invalid' }
    return transactions.run<T | SessionInvalid>([...stores, SESSIONS_STORE], mode, (scope) => {
      scope.then(scope.tx.objectStore(SESSIONS_STORE).get(SESSION_SLOT) as IDBRequest<unknown>, (raw) => {
        if (!canUseDraftSession(readStoredActiveSession(raw), permit, userId)) {
          scope.finish({ kind: 'session-invalid' })
          return
        }
        body(scope)
      })
    })
  }

  return {
    checkSession: async userId => run<{ readonly kind: 'bound' }>(userId, 'readonly', scope => scope.finish({ kind: 'bound' }), []),
    bindSession: async (permit) => {
      const checked = readDraftSessionPermit(permit)
      if (checked === undefined || (bound !== undefined && (bound.userId !== checked.userId || bound.generation !== checked.generation)))
        return { kind: 'session-invalid' }
      // 在任何异步之前固定副本；即便绑定核对失败，该实例也不得换成后来会话的许可。
      bound ??= Object.freeze(checked)
      return run<{ readonly kind: 'bound' }>(checked.userId, 'readonly', scope => scope.finish({ kind: 'bound' }), [])
    },
    registerWriter: async (key, writer, { now, force }) => {
      const record: WriterRecord = { userId: key.userId, documentId: key.documentId, writeEpoch: writer.writeEpoch, writerId: writer.writerId, lastDraftSeq: 0, registeredAt: now }
      if (readWriterRecord(record) === undefined || isRetired(writer))
        return failed('写入者无效或已退役')
      let recordKnown = false
      const result = await run<StoreRegisterOutcome>(key.userId, 'readwrite', (scope) => {
        readCurrent(scope, key, (current, existing) => {
          const verdict = decideRegistration(current, existing, writer, force)
          if (verdict.kind === 'superseded') {
            scope.finish(verdict)
            return
          }
          scope.tx.objectStore(WRITERS_STORE).put({ ...record, lastDraftSeq: verdict.lastDraftSeq })
          scope.finish({ kind: 'registered', lastDraftSeq: verdict.lastDraftSeq, existing })
        }, (draft) => { recordKnown ||= draft !== undefined })
      })
      return result.kind === 'registered' && result.existing !== undefined ? result : withRecordPresence(result, recordKnown)
    },

    writeDraft: async (draft, writeOptions) => {
      const checked = readStoredDraft(draft)
      if (checked.kind !== 'draft')
        return failed('草稿格式无效')
      const record = checked.draft
      return run<StoreWriteOutcome>(record.userId, 'readwrite', (scope) => {
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
        return failed('草稿格式无效')
      const record = checked.draft
      return run<StoreWriteOutcome>(record.userId, 'readwrite', (scope) => {
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
          return failed('重封草稿格式或文档不符')
        prepared = checked.draft
      }
      return run<StoreConfirmOutcome>(key.userId, 'readwrite', (scope) => {
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

    readDraft: async (key) => {
      let recordKnown = false
      const result = await run<StoreReadOutcome>(key.userId, 'readonly', (scope) => {
        scope.then(scope.tx.objectStore(DRAFTS_STORE).get(draftKeyPath(key)), (value: unknown) => {
          recordKnown ||= value !== undefined
          scope.finish(value === undefined ? { kind: 'absent' } : readStoredDraft(value))
        })
      })
      return isStoreProblem(result) ? withRecordPresence(result, recordKnown) : result
    },

    observeDraft: async (key) => {
      const generation = observationGeneration
      let recordKnown = false
      const result = await run<ObservedValues & { readonly kind: 'snapshot' }>(key.userId, 'readonly', (scope) => {
        const notice = scope.tx.objectStore(NOTICES_STORE).get(draftKeyPath(key))
        readRawCurrent(scope, key, (draft, writer) => scope.finish({ kind: 'snapshot', draft, writer, notice: notice.result as unknown }), (draft) => {
          recordKnown ||= draft !== undefined
        })
      }, ALL_STORES)
      if (result.kind !== 'snapshot')
        return withRecordPresence(result, recordKnown)
      if (generation !== observationGeneration)
        return withRecordPresence(failed('观察期间存储已关闭：凭证失效'), recordKnown)
      try {
        return {
          kind: 'observed',
          observation: observations.remember(key, result),
          record: result.draft === undefined ? { kind: 'absent' } : readStoredDraft(result.draft),
          writer: readWriterRecord(result.writer),
        }
      }
      catch (error) {
        return withRecordPresence({ kind: 'failed' as const, error }, recordKnown)
      }
    },

    adoptObserved: async (observation, draft) => {
      const checked = readStoredDraft(draft)
      if (checked.kind !== 'draft')
        return failed('接手草稿格式无效')
      const record = checked.draft
      if (record.userId !== observation.key.userId || record.documentId !== observation.key.documentId)
        return { kind: 'fenced', reason: 'changed' }
      const result = await run<StoreWriteOutcome>(record.userId, 'readwrite', (scope) => {
        readRawCurrent(scope, observation.key, (rawDraft, rawWriter) => {
          if (!observations.matches(observation, rawDraft, rawWriter)) {
            scope.finish({ kind: 'fenced', reason: 'changed' })
            return
          }
          const writer = readWriterRecord(rawWriter)
          const existing = rawDraft === undefined ? undefined : readStoredDraft(rawDraft)
          const verdict = decideObservedAdoption(writer, existing, record)
          if (verdict !== 'ok' || writer === undefined) {
            scope.finish({ kind: 'fenced', reason: verdict === 'ok' ? 'not-writer' : verdict })
            return
          }
          scope.tx.objectStore(DRAFTS_STORE).put(record)
          scope.tx.objectStore(WRITERS_STORE).put({ ...writer, lastDraftSeq: record.draftSeq })
          scope.finish({ kind: 'written' })
        })
      })
      // 只有事务成功提交才消费；配额/连接中止可使用原观察重新尝试。
      if (result.kind === 'written')
        observations.forget(observation)
      return result
    },

    removeObserved: async (observation, now) => {
      const result = await run<StoreRemoveOutcome>(observation.key.userId, 'readwrite', (scope) => {
        const path = draftKeyPath(observation.key)
        const notice = scope.tx.objectStore(NOTICES_STORE).get(path)
        readRawCurrent(scope, observation.key, (rawDraft, rawWriter) => {
          if (!observations.matches(observation, rawDraft, rawWriter)) {
            scope.finish({ kind: 'changed' })
            return
          }
          if (rawDraft === undefined) {
            scope.finish({ kind: 'absent' })
            return
          }
          // 墓碑与删除同时落盘，镜像清理失败或此后崩溃也不会复活旧记录。
          scope.tx.objectStore(WRITERS_STORE).put(retiredWriterOf(observation.key, readWriterRecord(rawWriter), readStoredDraft(rawDraft), now))
          scope.tx.objectStore(DRAFTS_STORE).delete(path)
          if (observations.sameNotice(observation, notice.result))
            scope.tx.objectStore(NOTICES_STORE).delete(path)
          scope.finish({ kind: 'removed' })
        })
      }, ALL_STORES)
      if (result.kind === 'removed' || result.kind === 'absent')
        observations.forget(observation)
      return result
    },

    listDrafts: async userId => run<StoreListOutcome>(userId, 'readonly', (scope) => {
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

    removeDraft: async (key, expectedSeq) => run<StoreRemoveOutcome>(key.userId, 'readwrite', (scope) => {
      scope.then(scope.tx.objectStore(DRAFTS_STORE).get(draftKeyPath(key)), (value: unknown) => {
        const verdict = decideRemove(value === undefined ? undefined : readStoredDraft(value), expectedSeq)
        if (verdict === 'remove') {
          scope.tx.objectStore(DRAFTS_STORE).delete(draftKeyPath(key))
          scope.tx.objectStore(NOTICES_STORE).delete(draftKeyPath(key))
        }
        scope.finish({ kind: verdict === 'remove' ? 'removed' : verdict })
      })
    }, [DRAFTS_STORE, NOTICES_STORE]),

    restoreDraft: async (draft, { now, noteLost = true }) => {
      const checked = readStoredDraft(draft)
      if (checked.kind !== 'draft')
        return failed('镜像草稿格式无效')
      const record = checked.draft
      return run<StoreRestoreOutcome>(record.userId, 'readwrite', (scope) => {
        readCurrent(scope, record, (current, existing) => {
          const verdict = decideRestore(current, existing, record, now)
          if (verdict.kind === 'skip') {
            // 库里的写入者没看过它、又不能写回：留下 lost 提示（已经是一条 lost 提示就不动它，时刻不变）
            if (verdict.reason === 'unseen' && noteLost) {
              scope.then(scope.tx.objectStore(NOTICES_STORE).get(draftKeyPath(record)), (value: unknown) => {
                if (readRecoveryNotice(value)?.kind !== 'lost')
                  scope.tx.objectStore(NOTICES_STORE).put(noticeOf(record, 'lost', now))
              })
            }
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

    retireWriter: async (key, { now }) => run<StoreRetireOutcome>(key.userId, 'readwrite', scope => retireDocument(scope, key, now)),

    recordLost: async (key, { now }) => run<StoreLostOutcome>(key.userId, 'readwrite', (scope) => {
      readCurrent(scope, key, (current, existing) => {
        if (current !== undefined || existing !== undefined) {
          scope.finish({ kind: 'kept' })
          return
        }
        scope.tx.objectStore(NOTICES_STORE).put(noticeOf(key, 'lost', now))
        scope.finish({ kind: 'noted' })
      })
    }, ALL_STORES),

    listNotices: async userId => run<StoreNoticesOutcome>(userId, 'readonly', (scope) => {
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

    clearNotice: async (key, expectedAt) => run<StoreNoticeClearOutcome>(key.userId, 'readwrite', (scope) => {
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
      observationGeneration += 1
      observations.clear()
      transactions.close()
    },
  }
}
