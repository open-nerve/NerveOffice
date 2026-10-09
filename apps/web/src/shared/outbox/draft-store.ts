// 本机发件箱的存储（M4-P1 设计 §3.2、§3.4）：IndexedDB 的事务。判定（writer-fence.ts）与写入在同一个 strict 事务里，
// 事务里只有 IndexedDB 的请求回调，不 await 加密、压缩这类别的异步（否则事务自动提交，判定与写入之间就能插进别的标签页）。
// 跨边界不抛异常：每个操作的结果都是带 kind 的值，写满、库用不了、未知的错误各有一种。
// 发件箱 Worker 也引用这个文件：不引用 zod，不依赖 DOM
import type { OutboxUnavailable } from './database.ts'
import type { DraftKey, DraftMeta, ReadDraft, StoredDraft } from './draft-record.ts'
import type { WriterIdentity } from './writer-fence.ts'

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

/** 保留期清理：删掉的草稿的键（属于当前用户的由 P4 说明） */
export type StorePurgeOutcome = { readonly kind: 'purged', readonly drafts: readonly DraftKey[] } | StoreProblem

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
   * （管道事先按"草稿是不是更新"准备好的重封那一份：同一个写入者、同一个序号，基准是新的修订号、不在途）——
   * rebased 不是库里现在这一份时交回 needs-rebase、不改动
   */
  readonly confirmDraft: (key: DraftKey, writer: WriterIdentity, confirmedSeq: number, rebased: StoredDraft | undefined) => Promise<StoreConfirmOutcome>
  readonly readDraft: (key: DraftKey) => Promise<StoreReadOutcome>
  /** 某个用户在这台设备上的全部草稿（元数据，不交出密文） */
  readonly listDrafts: (userId: string) => Promise<StoreListOutcome>
  /** 放弃（用户的决定，不核对写入者，§3.4.7）：带 expectedSeq 时只删那一份（decideRemove） */
  readonly removeDraft: (key: DraftKey, expectedSeq?: number) => Promise<StoreRemoveOutcome>
  /** 按用户清理（退出登录、账户停用）：草稿与写入者在一个事务里一起删；之后才到的写入因写入者不在而 not-writer */
  readonly removeUserData: (userId: string) => Promise<StoreClearOutcome>
  /** 保留期（§3.4.7）：删掉超过 14 天的草稿（不论属于谁），以及登记超过 14 天、又没有草稿的写入者 */
  readonly purgeExpired: (now: number) => Promise<StorePurgeOutcome>
  /** 关掉连接（页面离开、Worker 结束）；之后的操作重新打开 */
  readonly close: () => void
}
