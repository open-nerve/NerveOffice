import type { Request, Response } from 'express'
import { Buffer } from 'node:buffer'
import express from 'express'
import { AppError } from '../../shared/errors/app-error.ts'
import { toBodyError } from './json-body.ts'

export interface GzipBodyLimits {
  /** 压缩后的上限（字节）：超过时返回 413。声明的长度超过上限时不缓存正文，分块传输时缓存到上限为止；剩下的正文读出后丢弃，内存有上限 */
  readonly maxCompressedBytes: number
  /** 解压后的上限（字节）：解压到上限就停下，压缩炸弹在这里截住 */
  readonly maxRawBytes: number
}

export interface GzipBody {
  /** 请求体原样的 gzip 字节 */
  readonly compressed: Buffer
  /** 解压后的字节 */
  readonly decompressed: Buffer
}

const NOT_GZIP = '请求体不是完整的 gzip 数据'

/** 解压的错误：不是 gzip、被截断、CRC 不对、成员结束之后还有数据（含第二个成员） */
function isMalformedGzip(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string')
    return false
  return error.code.startsWith('Z_') || error.code === 'ERR_TRAILING_JUNK_AFTER_STREAM_END'
}

/**
 * 解压 gzip 数据，解压后超过 maxRawBytes 就停下（413），压缩炸弹在上限处截住。
 * 只接受恰好一个完整的 gzip 成员、末尾没有别的数据：用标准的 DecompressionStream，与浏览器同一个规范（成员结束之后还有数据即出错）。
 * 存下的字节会原样以 Content-Encoding: gzip 下发，浏览器只解第一个成员：几个成员拼起来、或者末尾带着数据时，
 * 服务端与浏览器会解出不同的内容（审查 A1：空成员加合法的成员，浏览器解出空串）。
 */
export async function gunzipWithin(compressed: Buffer, maxRawBytes: number): Promise<Buffer> {
  const reader = new Blob([compressed]).stream().pipeThrough<Uint8Array>(new DecompressionStream('gzip')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const chunk = await reader.read().catch((error: unknown) => {
      throw isMalformedGzip(error) ? new AppError('REQUEST_INVALID', NOT_GZIP) : error
    })
    if (chunk.done)
      return Buffer.concat(chunks, total)
    total += chunk.value.byteLength
    if (total > maxRawBytes) {
      await reader.cancel()
      throw new AppError('PAYLOAD_TOO_LARGE', `请求体解压后超过上限（${maxRawBytes} 字节）`)
    }
    chunks.push(chunk.value)
  }
}

/** 客户端在正文传完之前断开：body-parser 这时不报错、也不给出正文 */
function interrupted(request: Request): boolean {
  return request.readableAborted || request.destroyed || !request.complete
}

/**
 * 读取一个路由自己的 gzip 请求体（例如表格快照的上传，P4 设计 §3.5.1）：不经全局的 JSON 解析器，
 * 压缩后与解压后分别限制大小。内容类型不是 contentType 时 415；请求体带了 Content-Encoding 时同样 415
 * （正文本身就是 gzip 数据，不再叠一层内容编码）。
 * 由路由的拦截器在认证与 CSRF 检查之后调用：没通过检查的请求不读取、不解压。
 */
export async function readGzipBody(request: Request, response: Response, contentType: string, limits: GzipBodyLimits): Promise<GzipBody> {
  const matched = request.is(contentType)
  if (matched === null)
    throw new AppError('REQUEST_INVALID', '缺少请求体')
  if (matched === false)
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', `请求体的内容类型必须是 ${contentType}`)
  // 内容类型上面已经核对过
  // eslint-disable-next-line no-restricted-properties -- express.raw 是 body-parser 的字节解析器，与 SQL 无关
  const parse = express.raw({ type: () => true, limit: limits.maxCompressedBytes, inflate: false })
  await new Promise<void>((resolve, reject) => {
    parse(request, response, (error?: unknown) => {
      if (error === undefined || error === null)
        resolve()
      else
        reject(toBodyError(error, limits.maxCompressedBytes))
    })
  })
  const compressed: unknown = request.body
  if (!Buffer.isBuffer(compressed)) {
    // 客户端中途断开：与 JSON 请求体的"请求在传输中被中断"相同，不是意外错误（审查 A3）
    if (interrupted(request))
      throw new AppError('REQUEST_INVALID', '请求在传输中被中断')
    throw new Error('请求体没有读成字节')
  }
  return { compressed, decompressed: await gunzipWithin(compressed, limits.maxRawBytes) }
}
