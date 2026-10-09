// 写入栅栏与保留期的判定（M4-P1 设计 §3.4，M4 总设计 §2.2、§6.3，00 号计划书 §7.5）：纯函数，存储（draft-store.ts）在同一个
// strict 事务里读出写入者与草稿、按这里的判定写或不写——判定与写入之间没有别的异步，别的标签页插不进来。
// 写入者按服务端的代次排先后：只有代次更大的能登记，写入、重封、确认都核对代次与这次登记的 writerId；登记被拒时以服务端的核对为准
// （force，锁的争用以服务端的事实裁决，ADR-018）。别的写入者留下、还没接手的草稿一律不覆盖、不因本页的确认而删除——
// 把"拿不准的一律给副本"兜在最底层；接手要显式进行（adoptSeq：调用方确实看过那一份）。
// Worker 也引用这个文件：不引用 zod 与带 zod 的契约，不依赖 DOM
import type { DraftKey, DraftMeta, WriterRecord } from './draft-record.ts'
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

/**
 * 停用的写入者（墓碑，M4-P1 S9 审查 A1、A6）的 writerId：任何一次登记都不用它（登记的 writerId 是随机的 UUID，存储拒绝用它登记）。
 * 合一的清理删不掉镜像目录（编辑器页的发件箱 Worker 正拿着句柄）时，把这份文档的写入者换成墓碑：高水位留着，之后的写入、重封、
 * 确认一律 not-writer（那一页的 Worker 随之放开句柄），比对时库里有墓碑就不从镜像写回；保留期删写入者时同样换成墓碑。
 * 清理把镜像目录删掉之后连墓碑一起删（local-cleanup.ts）
 */
export const RETIRED_WRITER_ID = 'retired'

export function isRetired(writer: Pick<WriterIdentity, 'writerId'>): boolean {
  return writer.writerId === RETIRED_WRITER_ID
}

/** 这次写入、重封、确认的写入者是不是库里当前的写入者：库里没有、是墓碑、代次或 writerId 不同都不是 */
function isCurrentWriter(writer: WriterRecord | undefined, incoming: WriterIdentity): writer is WriterRecord {
  return writer !== undefined && !isRetired(writer) && isSameWriter(writer, incoming)
}

/**
 * 换成墓碑：代次照旧（之后新的登记照常按代次判定），高水位不低于现有草稿的序号（库里没有写入者时也立一块：挡住镜像里那一份被写回），
 * 时刻记为 now
 */
export function retiredWriterOf(key: DraftKey, current: WriterRecord | undefined, existing: ExistingDraft | undefined, now: number): WriterRecord {
  return {
    userId: key.userId,
    documentId: key.documentId,
    writeEpoch: current?.writeEpoch ?? 1,
    writerId: RETIRED_WRITER_ID,
    lastDraftSeq: Math.max(current?.lastDraftSeq ?? 0, existing?.kind === 'draft' ? existing.draft.draftSeq : 0),
    registeredAt: now,
  }
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
  if (!isCurrentWriter(writer, incoming))
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
  if (!isCurrentWriter(writer, incoming))
    return 'not-writer'
  return existing?.kind === 'draft' && isSameWriter(existing.draft, incoming) && existing.draft.draftSeq === incoming.expectedSeq ? 'ok' : 'changed'
}

/**
 * 确认的判定（服务端确认了 confirmedSeq，§3.4.5）：只删到已确认的序号——草稿的序号不大于它就删；更新的（保存中继续输入，A08）
 * 改基准、清掉在途；别的写入者留下的（或者认不出的）不动：本页的上传不包含它的内容，删了就丢了
 */
export function decideConfirm(writer: WriterRecord | undefined, existing: ExistingDraft | undefined, incoming: WriterIdentity & { readonly confirmedSeq: number }): 'delete' | 'rebase' | 'absent' | 'not-writer' | 'foreign-draft' {
  if (!isCurrentWriter(writer, incoming))
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

/** 比对镜像留下的提示超过保留期（按留下的时刻）：保留期清理时删掉（M4-P1 设计 §3.8） */
export function isNoticeExpired(notice: { readonly at: number }, now: number): boolean {
  return pastRetention(notice.at, now)
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
 * 保留期清理时这个写入者怎么处理（§3.4.7，审查 A6）：
 * - 还有草稿 → keep（高水位要接着用）；
 * - 墓碑 → keep（合一的清理在这份文档的镜像目录不在之后删它，local-cleanup.ts）；
 * - 库里那一条形状不对（判定本来就当作没有写入者）、又没有草稿 → delete；
 * - 登记超过保留期、没有草稿（早已不用了，连续开着的页面见 isWriterExpired）→ retire：换成墓碑而不是删掉——镜像里没截断成的那一份
 *   （确认、放弃时句柄被占着）不会因写入者没了而在比对时被写回来；
 * - 别的 keep
 */
export function writerRetention(writer: WriterRecord | undefined, hasDraft: boolean, now: number): 'keep' | 'retire' | 'delete' {
  if (hasDraft)
    return 'keep'
  if (writer === undefined)
    return 'delete'
  if (isRetired(writer))
    return 'keep'
  return isWriterExpired(writer, now) ? 'retire' : 'keep'
}

/**
 * 同一个写入者的两份记录谁新（大于 0：a 新；M4-P1 设计 §3.8）：先比代次，再比草稿序号；同一个序号的是同一份内容的重封（标记在途、改基准、
 * 换密钥），按更新时间（管道让同一份文档重写时的更新时间只增不减）。只用来比同一个写入者的（审查 A2：不同写入者之间不按代次分胜负——
 * 库里有当前的写入者时库是准的，见 decideRestore；镜像的两个槽位之间按代号认最新写的那一个）
 */
export function compareDrafts(a: Pick<DraftMeta, 'writeEpoch' | 'draftSeq' | 'updatedAt'>, b: Pick<DraftMeta, 'writeEpoch' | 'draftSeq' | 'updatedAt'>): number {
  return a.writeEpoch - b.writeEpoch || a.draftSeq - b.draftSeq || a.updatedAt - b.updatedAt
}

/**
 * 从 OPFS 镜像写回 IndexedDB 的判定（§3.8，审查 A2 与它的订正）。草稿序号是一份文档一条线，登记时高水位取 max 继承下来——
 * 候选的序号不大于库里写入者的高水位，就说明库里的写入者看过它。
 * - expired：超过保留期（镜像随之作废，保留期本来就要删它）；
 * - unrecognized：库里那一条认不出（更新的页面写的、形状不对）：不动它；
 * - 库里没有写入者：没有草稿（删库）→ 写回，写入者照它建（create）；有草稿 → foreign，不拿镜像换掉库里的；
 * - retired：库里是墓碑（清理删不掉镜像目录时立的）：镜像里的是该删的，不写回；
 * - 同一个写入者：库里是它的草稿 → 比先后，镜像的更新才写回、抬高水位（raise，库悄悄退回了已提交的写入），否则 not-newer；
 *   库里不是它的草稿 → 序号不大于高水位是 seen（被确认删掉、放弃过），否则写回、抬高水位；
 * - 不同的写入者：
 *   1. 序号不大于库里写入者的高水位 → seen（当前的写入者登记时已经看过它；含以 force 登记、代次倒退之后旧一代的镜像）；
 *   2. 候选的代次更大 → 写回，写入者换成候选的（replace：库悄悄丢了更新的那次登记与它的写入——UR-034 的变体）；
 *   3. 库里没有草稿 → 写回成别人留下的草稿，写入者与高水位不动（keep：库里的写入者同代或更新、还没写过草稿；活着的那一页按自己
 *      交回的高水位分配序号，抬高会让它的写入变成 stale-seq；不覆盖别人的草稿护住它，P3 给副本）；
 *   4. 否则 → foreign（库里的写入者同代或更新、已有自己的草稿，不拿镜像里的覆盖它）
 */
export type RestoreVerdict
  = | { readonly kind: 'restore', readonly writer: 'create' | 'replace' | 'raise' | 'keep' }
    | { readonly kind: 'skip', readonly reason: 'expired' | 'unrecognized' | 'retired' | 'foreign' | 'not-newer' | 'seen' }

export function decideRestore(writer: WriterRecord | undefined, existing: ExistingDraft | undefined, candidate: DraftMeta, now: number): RestoreVerdict {
  if (isExpired(candidate, now))
    return { kind: 'skip', reason: 'expired' }
  if (existing !== undefined && existing.kind !== 'draft')
    return { kind: 'skip', reason: 'unrecognized' }
  if (writer === undefined)
    return existing === undefined ? { kind: 'restore', writer: 'create' } : { kind: 'skip', reason: 'foreign' }
  if (isRetired(writer))
    return { kind: 'skip', reason: 'retired' }
  if (isSameWriter(writer, candidate) && existing !== undefined && isSameWriter(existing.draft, candidate))
    return compareDrafts(existing.draft, candidate) >= 0 ? { kind: 'skip', reason: 'not-newer' } : { kind: 'restore', writer: 'raise' }
  if (candidate.draftSeq <= writer.lastDraftSeq)
    return { kind: 'skip', reason: 'seen' }
  if (isSameWriter(writer, candidate))
    return { kind: 'restore', writer: 'raise' }
  if (candidate.writeEpoch > writer.writeEpoch)
    return { kind: 'restore', writer: 'replace' }
  return existing === undefined ? { kind: 'restore', writer: 'keep' } : { kind: 'skip', reason: 'foreign' }
}

/**
 * 写回时写入者的记录（decideRestore 的 writer）：create、replace 换成写回的那一份的写入者（登记时刻记为 now），高水位不低于它的序号；
 * raise 只抬高水位；keep 不动（交回 undefined，不写写入者）
 */
export function restoredWriterOf(current: WriterRecord | undefined, restored: DraftMeta, verdict: 'create' | 'replace' | 'raise' | 'keep', now: number): WriterRecord | undefined {
  const lastDraftSeq = Math.max(current?.lastDraftSeq ?? 0, restored.draftSeq)
  switch (verdict) {
    case 'create':
    case 'replace':
      return { userId: restored.userId, documentId: restored.documentId, writeEpoch: restored.writeEpoch, writerId: restored.writerId, lastDraftSeq, registeredAt: now }
    case 'raise':
      return current === undefined ? undefined : { ...current, lastDraftSeq }
    case 'keep':
      return undefined
  }
}
