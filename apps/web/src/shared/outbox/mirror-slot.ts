// OPFS 镜像的槽位格式（M4-P1 设计 §3.8）：每份文档两个槽位文件，轮流原地改写（截断 → 写内容 → 写头 → flush）。纯逻辑：编码、读出与校验、谁新。
// - 文件 = 固定 256 字节的头（偏移 0）+ 内容（偏移 256）。头最后写：被结束在写内容途中时头的位置还是 0（截断留下的空洞），
//   写头途中被结束时头自己的校验不过——写一半的槽位都落选，另一个槽位上的上一份还在。
// - 头：魔数与格式版本、写入者（代次、writerId）、草稿序号、代号（这个槽位对之间的写入次数，越大越新：同一份内容的重封
//   ——标记在途、改基准、换密钥——序号不变，靠它分先后）、内容的长度与 SHA-256、头自己的 SHA-256。
// - 内容就是存进 IndexedDB 的那一份记录（明文元数据、IV、密文），元数据仍由 AAD 认证；读出时照样过记录的形状核对。
// 布局：
//   [0, 8)     魔数 "NRVOMIRR"（ASCII）
//   [8, 10)    格式版本（u16，小端）
//   [10, 12)   writerId 的 UTF-8 字节数（u16，1–64）
//   [12, 20)   writeEpoch（u64）      [20, 28) draftSeq（u64）      [28, 36) 代号（u64）      [36, 44) 内容的字节数（u64）
//   [44, 76)   内容的 SHA-256
//   [76, 140)  writerId 的 UTF-8，不足补 0
//   [140, 224) 保留（0）
//   [224, 256) [0, 224) 的 SHA-256
// 发件箱 Worker 也引用这个文件：不引用 zod，不依赖 DOM
import type { StoredDraft } from './draft-record.ts'
import { DRAFT_IV_BYTES, readDraftMeta, readStoredDraft } from './draft-record.ts'

/** 头的字节数：固定 */
export const SLOT_HEADER_BYTES = 256

/** 槽位格式的版本：布局有变时加一；比本页认识的新的不往下看 */
export const SLOT_FORMAT_VERSION = 1

/** writerId 的 UTF-8 最多多少字节（每次登记的 crypto.randomUUID() 是 36 字节） */
export const SLOT_WRITER_ID_MAX_BYTES = 64

/** 魔数："NRVOMIRR" */
export const SLOT_MAGIC: readonly number[] = [0x4E, 0x52, 0x56, 0x4F, 0x4D, 0x49, 0x52, 0x52]

const VERSION_AT = 8
const WRITER_ID_LENGTH_AT = 10
const EPOCH_AT = 12
const SEQ_AT = 20
const GENERATION_AT = 28
const CONTENT_LENGTH_AT = 36
const CONTENT_SHA_AT = 44
const WRITER_ID_AT = 76
const CHECKSUM_AT = 224
const SHA256_BYTES = 32

/** 内容里元数据的长度前缀（u32） */
const META_LENGTH_BYTES = 4

/** 头里写入者与序号这几项：编码时由调用方给出（与内容里的记录一致） */
export interface SlotHeaderFields {
  readonly writeEpoch: number
  readonly writerId: string
  readonly draftSeq: number
  readonly generation: number
}

/** 读出的头 */
export interface SlotHeader extends SlotHeaderFields {
  readonly formatVersion: number
  readonly contentLength: number
  /** 内容的 SHA-256（十六进制小写） */
  readonly contentSha256: string
}

/** 读出的一个槽位：空的（截断为 0）；校验都过的；不合格的（写一半、内容对不上头、更新的格式） */
export type SlotRead
  = | { readonly kind: 'empty' }
    | { readonly kind: 'valid', readonly header: SlotHeader, readonly record: StoredDraft }
    | { readonly kind: 'invalid', readonly reason: 'torn' | 'mismatch' | 'newer-format' }

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
}

function isPositiveSafe(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1
}

/** u64 读成数：超出安全整数时为 undefined */
function readSafe(view: DataView, at: number): number | undefined {
  const value = view.getBigUint64(at, true)
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined
}

/** 一份记录序列化成槽位的内容：元数据的 JSON 的字节数（u32）、元数据的 JSON（UTF-8）、IV（12 字节）、密文 */
export function encodeRecord(draft: StoredDraft): Uint8Array<ArrayBuffer> {
  const { iv, ciphertext, ...meta } = draft
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta))
  const content = new Uint8Array(META_LENGTH_BYTES + metaBytes.byteLength + iv.byteLength + ciphertext.byteLength)
  new DataView(content.buffer).setUint32(0, metaBytes.byteLength, true)
  content.set(metaBytes, META_LENGTH_BYTES)
  content.set(iv, META_LENGTH_BYTES + metaBytes.byteLength)
  content.set(ciphertext, META_LENGTH_BYTES + metaBytes.byteLength + iv.byteLength)
  return content
}

/** 槽位的内容读回记录：长度、JSON、记录的形状任何一处不对都是 undefined（交回的字节是紧凑的拷贝） */
export function decodeRecord(content: Uint8Array): StoredDraft | undefined {
  if (content.byteLength < META_LENGTH_BYTES)
    return undefined
  const metaLength = new DataView(content.buffer, content.byteOffset, content.byteLength).getUint32(0, true)
  const ivAt = META_LENGTH_BYTES + metaLength
  if (ivAt + DRAFT_IV_BYTES > content.byteLength)
    return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(META_LENGTH_BYTES, ivAt)))
  }
  catch {
    return undefined
  }
  const meta = readDraftMeta(parsed)
  if (meta === undefined)
    return undefined
  const read = readStoredDraft({ ...meta, iv: content.slice(ivAt, ivAt + DRAFT_IV_BYTES), ciphertext: content.slice(ivAt + DRAFT_IV_BYTES) })
  return read.kind === 'draft' ? read.draft : undefined
}

/** 头：各项写进固定的偏移，最后 32 字节是前 224 字节的 SHA-256。写不下的（writerId 太长、数不是正的安全整数）抛出 TypeError */
export async function encodeSlotHeader(fields: SlotHeaderFields, content: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const writerId = new TextEncoder().encode(fields.writerId)
  if (writerId.byteLength < 1 || writerId.byteLength > SLOT_WRITER_ID_MAX_BYTES)
    throw new TypeError(`writerId 的 UTF-8 要在 1 到 ${SLOT_WRITER_ID_MAX_BYTES} 字节之间，镜像的头放不下 ${writerId.byteLength} 字节`)
  for (const [name, value] of [['writeEpoch', fields.writeEpoch], ['draftSeq', fields.draftSeq], ['generation', fields.generation]] as const) {
    if (!isPositiveSafe(value))
      throw new TypeError(`镜像的头里 ${name} 要是正的安全整数：${value}`)
  }
  const header = new Uint8Array(SLOT_HEADER_BYTES)
  const view = new DataView(header.buffer)
  header.set(SLOT_MAGIC, 0)
  view.setUint16(VERSION_AT, SLOT_FORMAT_VERSION, true)
  view.setUint16(WRITER_ID_LENGTH_AT, writerId.byteLength, true)
  view.setBigUint64(EPOCH_AT, BigInt(fields.writeEpoch), true)
  view.setBigUint64(SEQ_AT, BigInt(fields.draftSeq), true)
  view.setBigUint64(GENERATION_AT, BigInt(fields.generation), true)
  view.setBigUint64(CONTENT_LENGTH_AT, BigInt(content.byteLength), true)
  header.set(await sha256(content), CONTENT_SHA_AT)
  header.set(writerId, WRITER_ID_AT)
  header.set(await sha256(header.subarray(0, CHECKSUM_AT)), CHECKSUM_AT)
  return header
}

/** 一份记录写进槽位的两段：内容（写在头之后，先写）与头（最后写）。generation 是这次的代号 */
export async function encodeSlot(draft: StoredDraft, generation: number): Promise<{ readonly header: Uint8Array<ArrayBuffer>, readonly content: Uint8Array<ArrayBuffer> }> {
  const content = encodeRecord(draft)
  const header = await encodeSlotHeader({ writeEpoch: draft.writeEpoch, writerId: draft.writerId, draftSeq: draft.draftSeq, generation }, content)
  return { header, content }
}

/**
 * 读头（256 字节）：魔数不对、头自己的校验不过、取值不对时为 undefined；格式版本比本页认识的新时为 newer-format（不往下看：
 * 更新的格式可能连头的布局都改了）
 */
export async function parseSlotHeader(bytes: Uint8Array): Promise<SlotHeader | 'newer-format' | undefined> {
  if (bytes.byteLength < SLOT_HEADER_BYTES || SLOT_MAGIC.some((byte, index) => bytes[index] !== byte))
    return undefined
  const header = bytes.subarray(0, SLOT_HEADER_BYTES)
  const view = new DataView(header.buffer, header.byteOffset, SLOT_HEADER_BYTES)
  const formatVersion = view.getUint16(VERSION_AT, true)
  if (formatVersion > SLOT_FORMAT_VERSION)
    return 'newer-format'
  if (formatVersion !== SLOT_FORMAT_VERSION || hex(await sha256(header.subarray(0, CHECKSUM_AT))) !== hex(header.subarray(CHECKSUM_AT)))
    return undefined
  const writerIdLength = view.getUint16(WRITER_ID_LENGTH_AT, true)
  if (writerIdLength < 1 || writerIdLength > SLOT_WRITER_ID_MAX_BYTES)
    return undefined
  let writerId: string
  try {
    writerId = new TextDecoder('utf-8', { fatal: true }).decode(header.subarray(WRITER_ID_AT, WRITER_ID_AT + writerIdLength))
  }
  catch {
    return undefined
  }
  const writeEpoch = readSafe(view, EPOCH_AT)
  const draftSeq = readSafe(view, SEQ_AT)
  const generation = readSafe(view, GENERATION_AT)
  const contentLength = readSafe(view, CONTENT_LENGTH_AT)
  if (writeEpoch === undefined || draftSeq === undefined || generation === undefined || contentLength === undefined)
    return undefined
  if (!isPositiveSafe(writeEpoch) || !isPositiveSafe(draftSeq) || !isPositiveSafe(generation))
    return undefined
  return { formatVersion, writeEpoch, writerId, draftSeq, generation, contentLength, contentSha256: hex(header.subarray(CONTENT_SHA_AT, CONTENT_SHA_AT + SHA256_BYTES)) }
}

/**
 * 读整个槽位文件：长度为 0 的是空的；头不合格、内容的长度或 SHA-256 对不上的是写一半（torn）；校验都过、内容却读不出记录或者
 * 与头说的写入者、序号对不上的是 mismatch；更新的格式写的不往下看
 */
export async function parseSlot(file: Uint8Array): Promise<SlotRead> {
  if (file.byteLength === 0)
    return { kind: 'empty' }
  const header = await parseSlotHeader(file)
  if (header === 'newer-format')
    return { kind: 'invalid', reason: 'newer-format' }
  if (header === undefined || header.contentLength !== file.byteLength - SLOT_HEADER_BYTES)
    return { kind: 'invalid', reason: 'torn' }
  const content = file.subarray(SLOT_HEADER_BYTES)
  if (hex(await sha256(content)) !== header.contentSha256)
    return { kind: 'invalid', reason: 'torn' }
  const record = decodeRecord(content)
  if (record === undefined || record.writeEpoch !== header.writeEpoch || record.writerId !== header.writerId || record.draftSeq !== header.draftSeq)
    return { kind: 'invalid', reason: 'mismatch' }
  return { kind: 'valid', header, record }
}

/** 两个槽位里最新写的那一个（代号大的）；都不合格时为 undefined */
export function newestSlot(headers: readonly (Pick<SlotHeader, 'generation'> | undefined)[]): number | undefined {
  let newest: number | undefined
  headers.forEach((header, index) => {
    const current = newest === undefined ? undefined : headers[newest]
    if (header !== undefined && (current === undefined || header.generation > current.generation))
      newest = index
  })
  return newest
}
