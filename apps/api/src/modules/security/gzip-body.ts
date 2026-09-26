import type { Request, Response } from 'express'
import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'
import express from 'express'
import { AppError } from '../../shared/errors/app-error.ts'
import { toBodyError } from './json-body.ts'

export interface GzipBodyLimits {
  /** 压缩后的上限（字节）：超过时不再读取 */
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

/** gzip 成员末尾的 8 个字节：解压结果的 CRC32 与长度（对 2^32 取模），小端（RFC 1952 §2.3.1）。 */
const TRAILER_BYTES = 8

function isZlibError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('Z_')
}

function isOutputTooLarge(error: unknown): boolean {
  return error instanceof RangeError && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE'
}

async function gunzip(compressed: Buffer, maxOutputLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.gunzip(compressed, { maxOutputLength }, (error, result) => {
      if (error === null)
        resolve(result)
      else
        reject(error)
    })
  })
}

/**
 * 解压 gzip 数据，解压后超过 maxRawBytes 就停下（413）。只接受恰好一个完整的 gzip 成员：
 * 末尾不能有别的数据（zlib 自己拒绝），也不能是几个成员拼起来的（末尾的 CRC32 与长度要对应全部的解压结果）。
 * 存下的字节会原样以 Content-Encoding: gzip 下发，不是所有浏览器都能解开多个成员拼接的数据。
 */
export async function gunzipWithin(compressed: Buffer, maxRawBytes: number): Promise<Buffer> {
  let raw: Buffer
  try {
    raw = await gunzip(compressed, maxRawBytes)
  }
  catch (error) {
    if (isOutputTooLarge(error))
      throw new AppError('PAYLOAD_TOO_LARGE', `请求体解压后超过上限（${maxRawBytes} 字节）`)
    if (isZlibError(error))
      throw new AppError('REQUEST_INVALID', NOT_GZIP)
    throw error
  }
  const trailer = compressed.subarray(compressed.length - TRAILER_BYTES)
  if (trailer.readUInt32LE(0) !== zlib.crc32(raw) || trailer.readUInt32LE(4) !== raw.length % 2 ** 32)
    throw new AppError('REQUEST_INVALID', NOT_GZIP)
  return raw
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
  if (!Buffer.isBuffer(compressed))
    throw new Error('请求体没有读成字节')
  return { compressed, decompressed: await gunzipWithin(compressed, limits.maxRawBytes) }
}
