// 导入本机密钥（M4-P1 设计 §3.4.9，ADR-019）：base64 解成恰好 32 字节 → 不可导出的 AES-GCM 密钥、用途只有加密与解密 → 原始字节在
// finally 里清零（导入失败时同样）。atob 交回的中间文字与响应的 JSON 文字清不掉（JS 的字符串不可变），与 DEF-068 同一类，写进 ADR。
// 单独成一个文件，不引用 zod、带 zod 的契约与请求层：取用的请求（local-key.ts 的 fetchLocalKey）在主线程经请求层发出；测试构建的探针
// 只引用这里——探针引用请求层会让测试构建里平台页面与编辑器页的入口分块与生产的不同（请求层连同 zod 与契约的结构被拆进一个新的共享分块，
// 先于关掉 zod 的 JIT 求值，S6 实测）
import type { LocalKeyHandle } from './draft-codec.ts'
import { LOCAL_KEY_BYTES } from '@nerve-office/contracts'

/** 标准 base64 解成字节 */
function base64Bytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * 导入取到的本机密钥（版本与 32 字节的标准 base64）：不是恰好 32 字节时抛出 TypeError——契约的写法本来就只认 32 字节，这里再核对一次，
 * 写法改了也不会把别的长度悄悄导入成更短的密钥（AES-128）
 */
export async function importLocalKey(local: { readonly version: number, readonly key: string }): Promise<LocalKeyHandle> {
  const raw = base64Bytes(local.key)
  try {
    if (raw.byteLength !== LOCAL_KEY_BYTES)
      throw new TypeError(`本机密钥不是 ${LOCAL_KEY_BYTES} 字节`)
    return { version: local.version, key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) }
  }
  finally {
    raw.fill(0)
  }
}
