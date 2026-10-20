import type { AssetExtension, AssetMimeType } from '@nerve-office/contracts'
import { createHash } from 'node:crypto'
import { ASSET_MAX_BYTES, ASSET_MAX_PIXELS, ASSET_MAX_SIDE, ASSET_MIME_TYPES } from '@nerve-office/contracts'
import { z } from 'zod'

/** ADR-021 的固定资源边界；不设可调大的运维开关。原生限制只用于图片子进程。 */
export const IMAGE_LIMITS = Object.freeze({
  maxBytes: ASSET_MAX_BYTES,
  // 拒绝后的正文只计数丢弃；包含此前已读前缀，覆盖代理的 6MB 外层限制。
  maxRejectedBodyBytes: 6 * 1024 * 1024,
  rejectedBodyMs: 10_000,
  maxSide: ASSET_MAX_SIDE,
  maxFramePixels: ASSET_MAX_PIXELS,
  maxTotalPixels: 32_000_000,
  maxFrames: 100,
  processes: 1,
  maxWaiting: 4,
  perAccount: 2,
  maxWaitMs: 10_000,
  executionMs: 5_000,
  heapMb: 128,
  semiSpaceMb: 16,
  addressSpaceBytes: 1536 * 1024 * 1024,
})

/** HTTP 层完成有界读取后交给子进程；没有原文件名、客户端路径或 URL。 */
export interface ImageProcessingInput {
  readonly data: Uint8Array
  readonly mimeType: AssetMimeType
  readonly extension: AssetExtension
}

export interface ProcessedImage {
  readonly data: Uint8Array
  readonly sha256: string
  readonly mimeType: AssetMimeType
  readonly width: number
  readonly height: number
  readonly frames: number
  readonly bytes: number
}

const processedImageSchema = z.strictObject({
  data: z.instanceof(Uint8Array),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mimeType: z.enum(ASSET_MIME_TYPES),
  width: z.number().int().min(1).max(IMAGE_LIMITS.maxSide),
  height: z.number().int().min(1).max(IMAGE_LIMITS.maxSide),
  frames: z.number().int().min(1).max(IMAGE_LIMITS.maxFrames),
  bytes: z.number().int().min(1).max(IMAGE_LIMITS.maxBytes),
})

/** IPC 返回值是不可信协议输入；结构、长度和摘要通过后才能进入私有存储。 */
export function validateProcessedImage(value: unknown): ProcessedImage {
  const parsed = processedImageSchema.safeParse(value)
  if (parsed.success) {
    const image = parsed.data
    const pixels = image.width * image.height
    const canAnimate = image.mimeType === 'image/webp' || image.mimeType === 'image/gif'
    if (image.data.byteLength === image.bytes
      && pixels <= IMAGE_LIMITS.maxFramePixels
      && pixels * image.frames <= IMAGE_LIMITS.maxTotalPixels
      && (canAnimate || image.frames === 1)
      && createHash('sha256').update(image.data).digest('hex') === image.sha256) {
      return image
    }
  }
  // 不附 zod issues 或原值：其中可能有字节或库错误；协议失败是服务端错误，不伪装成用户图片损坏。
  throw new Error('图片处理结果不符合协议')
}
