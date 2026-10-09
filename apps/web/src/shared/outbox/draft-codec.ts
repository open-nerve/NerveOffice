// 草稿的编解码（M4-P1 设计 §3.3、§3.4.3、§3.4.6，00 号计划书 §7.6）：gzip 与 gunzip、SHA-256、AES-GCM-256 的封与开、解不开的归类。
// 压缩全程在内存的字节上做，不经 Blob：WebKit 读 Blob 要经它的网络进程，离线时读不出来（M1-P4）；M0 原型经 Blob 的写法不能照搬。
// 发件箱 Worker 与主线程（WebKit 改在主线程放置时，DEF-011）都用这里：不引用 zod，不依赖 DOM
import type { DraftMeta, StoredDraft } from './draft-record.ts'
import { draftAad } from './draft-aad.ts'
import { DRAFT_IV_BYTES, DRAFT_TAG_BYTES } from './draft-record.ts'

/**
 * 本机密钥（ADR-019）：版本与导入好的 CryptoKey——不可导出，用途只有加密与解密；原始字节在导入之后就清零了（local-key.ts）。
 * 放在这里而不在 local-key.ts：Worker 要用这个类型，local-key.ts 引用带 zod 的契约
 */
export interface LocalKeyHandle {
  readonly version: number
  readonly key: CryptoKey
}

/**
 * 这里能不能封草稿：WebCrypto 的 crypto.subtle 只在安全上下文里有（https 与本机；经 http 打开的部署没有它），没有就封不了、开不了草稿，
 * 也导入不了本机密钥，发件箱整个用不了——存储按 unsupported 交回，不打开库（draft-store.ts）。scope 是全局对象（页面与 Worker 里都是
 * globalThis），单元测试换成假的
 */
export function canSealDrafts(scope: { readonly crypto?: { readonly subtle?: unknown } }): boolean {
  return scope.crypto?.subtle !== undefined
}

/** 一份内容按一个变换流（压缩或解压）走一遍：来源是只入队一次的流，结果逐块读出、拼成一份紧凑的字节 */
async function transformed(bytes: Uint8Array<ArrayBuffer>, transform: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const reader = source.pipeThrough(transform).getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    chunks.push(chunk.value)
    length += chunk.value.byteLength
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

/** gzip（CompressionStream） */
export async function gzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return transformed(bytes, new CompressionStream('gzip'))
}

/** gunzip（DecompressionStream）：数据不是完整的 gzip 时抛出 */
export async function gunzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return transformed(bytes, new DecompressionStream('gzip'))
}

/**
 * SHA-256（十六进制小写）：会话内去重的键（00 号计划书 §7.2）。不用弱哈希——碰撞会让改过的内容不写、不传，就是丢数据。
 * 去重的哈希只在管道的内存里，不进记录：明文的内容哈希能用来确认"内容是不是某个猜测"
 */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** 每条记录一个随机 IV（12 字节）：同一把密钥不重用 IV，重封也换新的 */
export function newDraftIv(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(DRAFT_IV_BYTES))
}

/**
 * 封：按这次的元数据生成 AAD，用这把密钥加密 gzip 之后的内容，交回要存进库的记录。密钥版本取自密钥本身，调用方给不错。
 * iv 只有已知答案测试传入；生产一律随机
 */
export async function sealDraft(key: LocalKeyHandle, meta: Omit<DraftMeta, 'keyVersion'>, gzip: Uint8Array<ArrayBuffer>, iv: Uint8Array<ArrayBuffer> = newDraftIv()): Promise<StoredDraft> {
  const full: DraftMeta = { ...meta, keyVersion: key.version }
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: draftAad(full), tagLength: DRAFT_TAG_BYTES * 8 }, key.key, gzip)
  return { ...full, iv, ciphertext: new Uint8Array(ciphertext) }
}

/**
 * 解不开的原因（M4 总设计 §6.4；审查 A3）：
 * - revoked：记录的密钥版本比当前的小——那一版已吊销；
 * - stale-key：记录的密钥版本比当前的大——本页手里的密钥过时了（版本连续、只增，ADR-019），去取新密钥再试，绝不删除；
 * - corrupted：版本相同却解不开——记录已损坏（包括被改过：改了任何一项明文，AAD 就对不上）。
 * revoked 与 corrupted 都删除，只是说法不同
 */
export type UnsealFailure = 'revoked' | 'stale-key' | 'corrupted'

/** 解开的结果：gzip 之后的内容，或者解不开及原因 */
export type OpenedDraft
  = | { readonly kind: 'opened', readonly gzip: Uint8Array<ArrayBuffer> }
    | { readonly kind: 'unreadable', readonly reason: UnsealFailure }

/** 解不开时按记录与当前的密钥版本归类（见 UnsealFailure） */
export function unsealFailureOf(recordKeyVersion: number, currentKeyVersion: number): UnsealFailure {
  if (recordKeyVersion < currentKeyVersion)
    return 'revoked'
  return recordKeyVersion > currentKeyVersion ? 'stale-key' : 'corrupted'
}

/**
 * 开：按库里记录的元数据生成 AAD，用当前的密钥解密。认证失败（OperationError：密钥不对、密文或任何一项明文被改过）交回解不开；
 * 别的错误（例如密钥没有解密的用途）是调用方的错，照常抛出。按名字认，不用 instanceof（别的 realm 的 DOMException）
 */
export async function openDraft(key: LocalKeyHandle, draft: StoredDraft): Promise<OpenedDraft> {
  try {
    const gzip = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: draft.iv, additionalData: draftAad(draft), tagLength: DRAFT_TAG_BYTES * 8 }, key.key, draft.ciphertext)
    return { kind: 'opened', gzip: new Uint8Array(gzip) }
  }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'OperationError')
      return { kind: 'unreadable', reason: unsealFailureOf(draft.keyVersion, key.version) }
    throw error
  }
}
