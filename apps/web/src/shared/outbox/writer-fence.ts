// 写入栅栏与保留期的判定（M4-P1 设计 §3.4，M4 总设计 §2.2、§6.3，00 号计划书 §7.5）：纯函数，存储（draft-store.ts）在同一个
// strict 事务里读出写入者与草稿、按这里的判定写或不写——判定与写入之间没有别的异步，别的标签页插不进来。
// 写入者按服务端的代次排先后：只有代次更大的能登记，写入、重封、确认都核对代次与这次登记的 writerId；登记被拒时以服务端的核对为准
// （force，锁的争用以服务端的事实裁决，ADR-018）。别的写入者留下、还没接手的草稿一律不覆盖、不因本页的确认而删除——
// 把"拿不准的一律给副本"兜在最底层；接手要显式进行（adoptSeq：调用方确实看过那一份）。
// Worker 也引用这个文件：不引用 zod 与带 zod 的契约，不依赖 DOM
import type { DraftMeta, WriterRecord } from './draft-record.ts'
import { LOCAL_DRAFT_RETENTION_DAYS } from '@nerve-office/contracts'

/** 写入者的身份：服务端的代次与这次登记随机生成的 writerId（不是租约令牌） */
export interface WriterIdentity {
  readonly writeEpoch: number
  readonly writerId: string
}

/**
 * 库里这份文档现有的草稿，按判定要用的程度：认得出的给元数据；认不出的（更新的页面写的、形状不对）只知道有一份。
 * 存储把 readStoredDraft 的结果直接交进来（ReadDraft 可以赋给它）
 */
export type ExistingDraft
  = | { readonly kind: 'draft', readonly draft: DraftMeta }
    | { readonly kind: 'newer-format' | 'malformed' }

/** 保留期（毫秒）：契约的天数（服务端修订记录保留期的下限由同一个常量推出） */
export const LOCAL_DRAFT_RETENTION_MS = LOCAL_DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000

export function isSameWriter(a: WriterIdentity, b: WriterIdentity): boolean {
  return a.writeEpoch === b.writeEpoch && a.writerId === b.writerId
}

export type RegistrationVerdict
  /** 登记；lastDraftSeq 是交回主线程的高水位，序号从它往上分配 */
  = | { readonly kind: 'register', readonly lastDraftSeq: number }
  /** 现有的写入者代次更大，或者同一代的另一次登记：交回调用方，由它向服务端核对 */
    | { readonly kind: 'superseded', readonly currentEpoch: number, readonly sameEpoch: boolean }

/**
 * 登记写入者（§3.4.2）：没有写入者、现有的代次更小、或者就是同一次登记（幂等）→ 登记；代次更大、或者同一代而 writerId 不同 → superseded。
 * force：本页刚经服务端核对确认这一代是当前的，任何现存的写入者都已陈旧（服务端从备份恢复之后代次倒退、同一个页面重建了 Worker）。
 * 高水位 = max(旧写入者的高水位, 现有草稿的序号)：草稿删掉之后高水位还在，序号不回头；认不出的草稿看不出序号，按写入者的
 */
export function decideRegistration(writer: WriterRecord | undefined, existing: ExistingDraft | undefined, incoming: WriterIdentity, force: boolean): RegistrationVerdict {
  const lastDraftSeq = Math.max(writer?.lastDraftSeq ?? 0, existing?.kind === 'draft' ? existing.draft.draftSeq : 0)
  if (force || writer === undefined || writer.writeEpoch < incoming.writeEpoch || isSameWriter(writer, incoming))
    return { kind: 'register', lastDraftSeq }
  return { kind: 'superseded', currentEpoch: writer.writeEpoch, sameEpoch: writer.writeEpoch === incoming.writeEpoch }
}

/**
 * 写入的判定：
 * - not-writer：写入者不是它（被取代、被清理删掉了，或者没登记就写）；
 * - duplicate：同一写入者、同一序号，库里就是它——提交了而回应丢了的重试（连接被断开之后重开），按已写入；
 * - stale-seq：序号不大于高水位；
 * - foreign-draft：库里是别的写入者留下的草稿（或者认不出的一条），这次又没带上接手的那一份的序号（adoptSeq）。
 *   认不出的一条带了 adoptSeq 也不行：看不出它的序号，要先显式删掉（本机草稿页、恢复的决定）
 */
export function decideWrite(writer: WriterRecord | undefined, existing: ExistingDraft | undefined, incoming: WriterIdentity & { readonly draftSeq: number, readonly adoptSeq?: number }): 'ok' | 'duplicate' | 'not-writer' | 'stale-seq' | 'foreign-draft' {
  if (writer === undefined || !isSameWriter(writer, incoming))
    return 'not-writer'
  if (existing?.kind === 'draft' && isSameWriter(existing.draft, incoming) && existing.draft.draftSeq === incoming.draftSeq)
    return 'duplicate'
  if (incoming.draftSeq <= writer.lastDraftSeq)
    return 'stale-seq'
  if (existing === undefined)
    return 'ok'
  if (existing.kind !== 'draft')
    return 'foreign-draft'
  return isSameWriter(existing.draft, incoming) || incoming.adoptSeq === existing.draft.draftSeq ? 'ok' : 'foreign-draft'
}

/**
 * 重封的判定（标记在途、换密钥、确认之后改基准，§3.4.4）：比较并交换——写入者仍是它、库里仍是它写下的 expectedSeq 那一份才写；
 * 期间又写了新的、草稿不在了、或者是别的写入者写的，都是 changed
 */
export function decideReplace(writer: WriterRecord | undefined, existing: ExistingDraft | undefined, incoming: WriterIdentity & { readonly expectedSeq: number }): 'ok' | 'not-writer' | 'changed' {
  if (writer === undefined || !isSameWriter(writer, incoming))
    return 'not-writer'
  return existing?.kind === 'draft' && isSameWriter(existing.draft, incoming) && existing.draft.draftSeq === incoming.expectedSeq ? 'ok' : 'changed'
}

/**
 * 确认的判定（服务端确认了 confirmedSeq，§3.4.5）：只删到已确认的序号——草稿的序号不大于它就删；更新的（保存中继续输入，A08）
 * 改基准、清掉在途；别的写入者留下的（或者认不出的）不动：本页的上传不包含它的内容，删了就丢了
 */
export function decideConfirm(writer: WriterRecord | undefined, existing: ExistingDraft | undefined, incoming: WriterIdentity & { readonly confirmedSeq: number }): 'delete' | 'rebase' | 'absent' | 'not-writer' | 'foreign-draft' {
  if (writer === undefined || !isSameWriter(writer, incoming))
    return 'not-writer'
  if (existing === undefined)
    return 'absent'
  if (existing.kind !== 'draft' || !isSameWriter(existing.draft, incoming))
    return 'foreign-draft'
  return existing.draft.draftSeq <= incoming.confirmedSeq ? 'delete' : 'rebase'
}

/**
 * 放弃的判定（用户的决定，不核对写入者，§3.4.7）：带 expectedSeq 时只删那一份——别的标签页刚写了新的一份就不删（changed）；
 * 认不出的记录看不出序号，只能不带 expectedSeq 删
 */
export function decideRemove(existing: ExistingDraft | undefined, expectedSeq?: number): 'remove' | 'changed' | 'absent' {
  if (existing === undefined)
    return 'absent'
  if (expectedSeq === undefined)
    return 'remove'
  return existing.kind === 'draft' && existing.draft.draftSeq === expectedSeq ? 'remove' : 'changed'
}

/** 超过保留期：恰好 14 天不算；时刻在将来（时钟往回拨过）不算 */
function pastRetention(at: number, now: number): boolean {
  return now - at > LOCAL_DRAFT_RETENTION_MS
}

/** 草稿超过保留期（按更新时间） */
export function isExpired(meta: Pick<DraftMeta, 'updatedAt'>, now: number): boolean {
  return pastRetention(meta.updatedAt, now)
}

/**
 * 写入者超过保留期（按登记的时刻）。不另记"最后写入的时刻"：一个连续开着、编辑超过 14 天的页面，草稿刚被确认删掉的那一刻，
 * 它的写入者可能被别的页面的保留期清理删掉——下一次写入得到 not-writer，页面（P2）经服务端核对仍是当前的一代之后以 force 重新登记，
 * 多一次核对、不丢数据
 */
export function isWriterExpired(writer: Pick<WriterRecord, 'registeredAt'>, now: number): boolean {
  return pastRetention(writer.registeredAt, now)
}

/**
 * 能不能原样重放（§3.4.6）：在途的就是这一份（序号相同），并且发出不满 14 天——服务端修订记录与回执至少留 15 天，
 * 重放还找得到原来的结果。否则按服务端这一版的来源认"自己追自己"（P3）
 */
export function canReplayAsSent(meta: Pick<DraftMeta, 'draftSeq' | 'inFlight'>, now: number): boolean {
  const inFlight = meta.inFlight
  return inFlight !== null && inFlight.localSeq === meta.draftSeq && now - inFlight.sentAt < LOCAL_DRAFT_RETENTION_MS
}

/**
 * 保留期清理时这条草稿要不要删（§3.4.7）：按记录里读得出的更新时间（draft-record.ts 的 readableUpdatedAt），不论格式、不论属于谁
 * （别人的本来就解不开）——形状不对的、更新的页面写的，读得出更新时间并且超过 14 天同样删（部署回滚之后旧页面永远认不出新格式的记录，
 * 计划书 §7.6：单条记录最长保留 14 天）；读不出才留着，由 P3 打开文档时、P4 本机草稿页发现之后说明并删
 */
export function shouldPurgeDraft(updatedAt: number | undefined, now: number): boolean {
  return updatedAt !== undefined && pastRetention(updatedAt, now)
}

/**
 * 保留期清理时这个写入者要不要删：没有草稿、并且登记超过保留期（早已不用了，连续开着的页面见 isWriterExpired）；还有草稿时留着
 * （高水位要接着用）。writer 为 undefined 表示库里那一条形状不对（判定本来就当作没有写入者），没有草稿时一并删
 */
export function shouldPurgeWriter(writer: Pick<WriterRecord, 'registeredAt'> | undefined, hasDraft: boolean, now: number): boolean {
  return !hasDraft && (writer === undefined || isWriterExpired(writer, now))
}
