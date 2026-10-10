// 本机发件箱的记录（M4-P1 设计 §3.2、§3.3，00 号计划书 §7.5、§7.6）：IndexedDB 里每个用户的每份文档一条草稿、一个写入者，
// 键都是 [userId, documentId]（平台的文档 id，不用 unitId）。
// - 草稿：明文的元数据全部进 AAD（draft-aad.ts），密文是 gzip 之后的快照（draft-codec.ts）。存的是字节，不是 Blob：
//   WebKit 读 Blob 要经它的网络进程，离线时读不出来（M1-P4）。
// - 写入者：只存这一代的代次与每次登记随机生成的 writerId（就是总设计说的"这一代的令牌"），不存编辑租约的令牌——
//   令牌只在标签页的内存里（ADR-018）。草稿序号的高水位放在这里：草稿删掉之后它还在，序号不回头。
// 库里读出来的东西一律先过这里的形状核对（手写守卫）：发件箱 Worker 也引用这个文件，不引用 zod 与带 zod 的契约。
// 字节不用 instanceof 认：Worker、IndexedDB 与 jsdom 交回的 Uint8Array 可能属于别的 realm，instanceof 会认错

/** 记录的格式版本：结构有变时加一（只做加法的库升级之外，记录本身的写法变了）。比本页认识的新的记录不动它 */
export const DRAFT_RECORD_VERSION = 1

/** 每条记录的 IV：12 字节、随机（AES-GCM 的标准长度；同一把密钥不重用 IV） */
export const DRAFT_IV_BYTES = 12

/** AES-GCM 的认证标签：128 位，附在密文的末尾，所以密文至少这么长 */
export const DRAFT_TAG_BYTES = 16

/** 记录的键：用户与平台的文档 id */
export interface DraftKey {
  readonly userId: string
  readonly documentId: string
}

/** 写下内容的页面的构建与数据格式（00 号计划书 §8.7，M3-P3 设计 §3.5）：恢复时判断"本页读不读得了它" */
export interface ContentFormat {
  readonly clientBuild: string
  readonly univerVersion: string
  readonly profile: string
  readonly formatVersion: number
}

/**
 * 在途的保存（M4 总设计 §2.2"自己追自己"）：上传发出之前先落盘。恢复时认两件事——记录就是在途的那一份（localSeq 等于草稿序号）
 * 就原样重放；否则看服务端当前修订的来源是不是这一次（客户端实例与序号）。原样重放时公式标记、构建与数据格式就是记录本身的，不另存
 */
export interface InFlightSave {
  readonly requestId: string
  readonly clientInstanceId: string
  /** 那次上传带的序号，就是那一份的草稿序号 */
  readonly localSeq: number
  /** 发出的墙上时间（毫秒）：原样重放只在保留期之内做（服务端修订记录与回执至少多留 1 天） */
  readonly sentAt: number
}

/** 草稿的明文元数据：每一项都进 AAD，改动任何一项都解不开 */
export interface DraftMeta extends DraftKey {
  /** = DRAFT_RECORD_VERSION */
  readonly recordVersion: number
  /** 草稿序号：每份文档一条持久、单调的线，上传的 localSeq 也用它 */
  readonly draftSeq: number
  /** 这份内容基于的服务端修订号 */
  readonly baseRevision: number
  /** 写下它的那一代（服务端的代次） */
  readonly writeEpoch: number
  /** 写下它的那次登记 */
  readonly writerId: string
  /** 写下它的客户端实例：同一标签页意外重新载入时认"是不是上一个实例写的"（P3） */
  readonly writtenBy: string
  readonly format: ContentFormat
  readonly formulasPending: boolean
  /** 加密用的本机密钥的版本：解不开时据此区分"已吊销"与"已损坏" */
  readonly keyVersion: number
  readonly inFlight: InFlightSave | null
  /** 解压后的字节数 */
  readonly rawBytes: number
  /** 墙上时间（毫秒）：保留期按它算 */
  readonly updatedAt: number
}

/** 存进去的草稿：元数据加 IV 与密文（字节，紧凑：视图恰好是整个缓冲） */
export interface StoredDraft extends DraftMeta {
  readonly iv: Uint8Array<ArrayBuffer>
  readonly ciphertext: Uint8Array<ArrayBuffer>
}

/** 这份文档当前的写入者（不存租约令牌） */
export interface WriterRecord extends DraftKey {
  readonly writeEpoch: number
  /** 每次登记 crypto.randomUUID() */
  readonly writerId: string
  /** 草稿序号的高水位：写入的事务里要求新序号比它大，并在同一个事务里抬高 */
  readonly lastDraftSeq: number
  /** 登记的墙上时间（毫秒）：保留期清理按它删掉早已不用、又没有草稿的写入者 */
  readonly registeredAt: number
}

/** 读出来的草稿：认得出的交回记录；更新的页面写的不动它；形状不对的是损坏的记录 */
export type ReadDraft
  = | { readonly kind: 'draft', readonly draft: StoredDraft }
    | { readonly kind: 'newer-format', readonly recordVersion: number }
    | { readonly kind: 'malformed' }

// 下面几个守卫也给发件箱 Worker 的协议用（features/sheet-editor/outbox/outbox-protocol.ts）：同一组形状，跨 Worker 的消息照样逐项核对

export type Fields = Readonly<Record<string, unknown>>

/** 普通的对象（不是 null、不是数组） */
export function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空的字符串 */
export function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** 不小于 min 的安全整数（序号、代次、版本、字节数、毫秒时刻） */
export function isWhole(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min
}

/**
 * Uint8Array，并且紧凑：视图从缓冲的开头起、恰好占满整个缓冲。结构化克隆存的是整个缓冲——视图只占一段时，缓冲里别的字节
 * （可能是明文）也会进库。按内部的类型标签认，不用 instanceof（别的 realm）；共享的缓冲（SharedArrayBuffer）不认
 */
function isCompactBytes(value: unknown): value is Uint8Array<ArrayBuffer> {
  if (Object.prototype.toString.call(value) !== '[object Uint8Array]')
    return false
  const bytes = value as Uint8Array
  return Object.prototype.toString.call(bytes.buffer) === '[object ArrayBuffer]' && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
}

export function readContentFormat(value: unknown): ContentFormat | undefined {
  if (!isFields(value))
    return undefined
  const { clientBuild, univerVersion, profile, formatVersion } = value
  if (!isText(clientBuild) || !isText(univerVersion) || !isText(profile) || !isWhole(formatVersion, 1))
    return undefined
  return { clientBuild, univerVersion, profile, formatVersion }
}

/** 在途的保存：null（不在途）照样交回 null；形状不对时为 undefined */
export function readInFlight(value: unknown): InFlightSave | null | undefined {
  if (value === null)
    return null
  if (!isFields(value))
    return undefined
  const { requestId, clientInstanceId, localSeq, sentAt } = value
  if (!isText(requestId) || !isText(clientInstanceId) || !isWhole(localSeq, 1) || !isWhole(sentAt, 0))
    return undefined
  return { requestId, clientInstanceId, localSeq, sentAt }
}

/**
 * 本页这个格式版本的草稿元数据：逐项核对，交回只带已知字段的一份；格式版本不是本页的、形状不对时为 undefined。
 * 库里读出的草稿（readStoredDraft）与发件箱 Worker 交回的元数据都经过这里。
 * 另有一条不变量：在途的保存的序号不大于草稿的序号（在途的是这一份，或者这一份之前的一次上传）。反过来的记录在恢复时会把旧内容
 * 当"自己追自己"接到服务端更新的那一版上，静默退回别人已存的修改——写入管道写入与标记在途时都已拦下，存储与读出这里再兜一层
 */
export function readDraftMeta(value: unknown): DraftMeta | undefined {
  if (!isFields(value))
    return undefined
  const { recordVersion, userId, documentId, draftSeq, baseRevision, writeEpoch, writerId, writtenBy, formulasPending, keyVersion, rawBytes, updatedAt } = value
  if (recordVersion !== DRAFT_RECORD_VERSION)
    return undefined
  const format = readContentFormat(value.format)
  const inFlight = readInFlight(value.inFlight)
  if (!isText(userId) || !isText(documentId) || !isWhole(draftSeq, 1) || !isWhole(baseRevision, 1) || !isWhole(writeEpoch, 1) || !isText(writerId) || !isText(writtenBy))
    return undefined
  if (format === undefined || typeof formulasPending !== 'boolean' || !isWhole(keyVersion, 1) || inFlight === undefined || !isWhole(rawBytes, 0) || !isWhole(updatedAt, 0))
    return undefined
  if (inFlight !== null && inFlight.localSeq > draftSeq)
    return undefined
  return { userId, documentId, recordVersion, draftSeq, baseRevision, writeEpoch, writerId, writtenBy, format, formulasPending, keyVersion, inFlight, rawBytes, updatedAt }
}

/**
 * 库里读出的一条草稿：先看记录的格式版本——比本页认识的新就不往下看（更新的页面可能改了别的字段）；是本页的版本才逐项核对，
 * 交回只带已知字段的一份（多出来的字段不带出去，也就不会被当成元数据用）
 */
export function readStoredDraft(value: unknown): ReadDraft {
  if (!isFields(value))
    return { kind: 'malformed' }
  const { recordVersion, iv, ciphertext } = value
  if (isWhole(recordVersion, DRAFT_RECORD_VERSION + 1))
    return { kind: 'newer-format', recordVersion }
  const meta = readDraftMeta(value)
  if (meta === undefined)
    return { kind: 'malformed' }
  if (!isCompactBytes(iv) || iv.byteLength !== DRAFT_IV_BYTES || !isCompactBytes(ciphertext) || ciphertext.byteLength < DRAFT_TAG_BYTES)
    return { kind: 'malformed' }
  return { kind: 'draft', draft: { ...meta, iv, ciphertext } }
}

/**
 * 库里读出的写入者；形状不对时为 undefined，当作没有写入者：登记随之照常进行（高水位按现有的草稿算），
 * 现有的草稿由"不覆盖别的写入者留下的草稿"护住（writer-fence.ts 的 foreign-draft）
 */
export function readWriterRecord(value: unknown): WriterRecord | undefined {
  if (!isFields(value))
    return undefined
  const { userId, documentId, writeEpoch, writerId, lastDraftSeq, registeredAt } = value
  if (!isText(userId) || !isText(documentId) || !isWhole(writeEpoch, 1) || !isText(writerId) || !isWhole(lastDraftSeq, 0) || !isWhole(registeredAt, 0))
    return undefined
  return { userId, documentId, writeEpoch, writerId, lastDraftSeq, registeredAt }
}

/**
 * 记录里读得出的更新时间（毫秒）：不论格式——形状不对的、更新的页面写的，只要 updatedAt 是个有限的数就交回它；读不出时为 undefined。
 * 保留期清理按它判断（单条记录最长保留 14 天，00 号计划书 §7.6）：部署回滚之后旧页面永远认不出新格式的记录，不按它判断就会一直留着
 */
export function readableUpdatedAt(value: unknown): number | undefined {
  if (!isFields(value))
    return undefined
  const { updatedAt } = value
  return typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : undefined
}

/** 草稿的元数据（去掉 IV 与密文）：本机草稿页的列表只要这些，不交出密文 */
export function draftMetaOf(draft: StoredDraft): DraftMeta {
  const { iv: _iv, ciphertext: _ciphertext, ...meta } = draft
  return meta
}
