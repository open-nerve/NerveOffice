import type { AssetExtension, AssetMimeType, AssetUploadResponse, SessionResponse } from '@nerve-office/contracts'
import { ASSET_EXTENSION_HEADER, ASSET_MAX_BYTES, ASSET_MIME_TYPES, ASSET_STATUS_HEADER, assetUploadResponseSchema, isPlatformAssetAddress } from '@nerve-office/contracts'
import { apiFetch, NetworkError, readJson, ResponseFormatError, retryAfterOf } from '../api/client.ts'

// 此处不持有 SDK、页面实例或解码缓存。读取所得字节是否能解码由调用方验证。
const EXTENSION_MIME: Readonly<Record<AssetExtension, AssetMimeType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}
const MIME_TYPES: ReadonlySet<string> = new Set(ASSET_MIME_TYPES)

function isAssetMime(value: string): value is AssetMimeType {
  return MIME_TYPES.has(value)
}

export interface AssetUploadInput {
  readonly data: Uint8Array<ArrayBuffer>
  readonly mimeType: AssetMimeType
  readonly extension: AssetExtension
}

export interface AssetRequestOptions {
  readonly signal?: AbortSignal
  readonly session?: SessionResponse
}

export interface AssetBytes {
  readonly data: Uint8Array<ArrayBuffer>
  readonly mimeType: AssetMimeType
}

export class AssetInputError extends Error {
  override readonly name = 'AssetInputError'
  readonly reason: 'address' | 'size' | 'type'

  constructor(reason: 'address' | 'size' | 'type') {
    super('图片输入不符合要求')
    this.reason = reason
  }
}

export class AssetReadError extends Error {
  override readonly name = 'AssetReadError'
  readonly status: 404 | 500 | 503
  readonly retryAfterSeconds: number | undefined

  constructor(status: 404 | 500 | 503, retryAfterSeconds: number | undefined) {
    super('图片暂时无法读取')
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** 字节已由上层受控文件读取；不接受原文件名、任意 URL 或路径，也不自动重试上传。 */
export async function uploadAsset(input: AssetUploadInput, options: AssetRequestOptions = {}): Promise<AssetUploadResponse> {
  options.signal?.throwIfAborted()
  if (input.data.byteLength < 1 || input.data.byteLength > ASSET_MAX_BYTES)
    throw new AssetInputError('size')
  if (!isAssetMime(input.mimeType) || EXTENSION_MIME[input.extension] !== input.mimeType)
    throw new AssetInputError('type')
  return apiFetch('/api/assets', {
    method: 'POST',
    session: options.session,
    signal: options.signal,
    redirect: 'error',
    body: { contentType: input.mimeType, data: input.data },
    headers: { [ASSET_EXTENSION_HEADER]: input.extension },
  }, async response => readJson(response, assetUploadResponseSchema, 'POST /api/assets'))
}

/** 按实际流限额，不能相信 Content-Length；全部读取仍在 apiFetch 的同一时限内。 */
async function readBytes(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  if (response.body === null)
    throw new ResponseFormatError('图片响应没有正文')
  const reader = response.body.getReader()
  // 不保留任意数量的流分块：小块/空块不会放大数组开销，复用的分块也不能篡改已收字节。
  let data = new Uint8Array(0)
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done)
        break
      const nextSize = size + chunk.value.byteLength
      if (nextSize > ASSET_MAX_BYTES)
        throw new ResponseFormatError('图片响应超过大小限制')
      if (nextSize > data.byteLength) {
        const grown = new Uint8Array(Math.min(ASSET_MAX_BYTES, Math.max(65_536, data.byteLength * 2, nextSize)))
        grown.set(data)
        data = grown
      }
      data.set(chunk.value, size)
      size = nextSize
    }
    if (size === 0)
      throw new ResponseFormatError('图片响应没有正文')
    return size === data.byteLength ? data : data.slice(0, size)
  }
  catch (error) {
    // 流已坏、超额或不可用；取消不能遮蔽原错误，也不等待不响应的取消回调。
    void reader.cancel().catch(() => {})
    if (error instanceof ResponseFormatError)
      throw error
    throw new NetworkError('图片响应读取中断', { cause: error })
  }
  finally {
    reader.releaseLock()
  }
}

function imageTypeOf(response: Response): AssetMimeType {
  if (response.status !== 200)
    throw new ResponseFormatError('图片响应不是完整的成功响应')
  const status = response.headers.get(ASSET_STATUS_HEADER)
  if (status === '404' || status === '500' || status === '503')
    throw new AssetReadError(Number(status) as 404 | 500 | 503, retryAfterOf(response))
  if (status !== '200')
    throw new ResponseFormatError('图片响应缺少有效的资源状态')
  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!isAssetMime(mimeType))
    throw new ResponseFormatError('图片响应的媒体类型不符合要求')
  return mimeType
}

/** 只接规范相对地址；上层必须先完成本站绝对地址的规范化。 */
export async function readAsset(source: string, options: AssetRequestOptions = {}): Promise<AssetBytes> {
  options.signal?.throwIfAborted()
  if (!isPlatformAssetAddress(source, ''))
    throw new AssetInputError('address')
  return apiFetch(source, {
    session: options.session,
    signal: options.signal,
    accept: ASSET_MIME_TYPES.join(', '),
    cache: 'no-store',
    redirect: 'error',
  }, async (response) => {
    let mimeType: AssetMimeType
    try {
      mimeType = imageTypeOf(response)
    }
    catch (error) {
      // HTTP 200 也可能是错误占位；不读出/下载占位，不遗留未消费的流。
      void response.body?.cancel().catch(() => {})
      throw error
    }
    return { data: await readBytes(response), mimeType }
  })
}
