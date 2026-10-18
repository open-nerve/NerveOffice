import type { AssetInvalidRule } from '@nerve-office/contracts'
import type { ImageContainer } from './container-reader.ts'
import type { ImageProcessingInput, ProcessedImage } from './image-types.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { ImageRejected, requireImage } from './container-reader.ts'
import { restoreGifAnimation } from './gif-container.ts'
import { inspectContainer } from './image-container.ts'
import { IMAGE_LIMITS } from './image-types.ts'
import { assembleAnimatedWebp } from './webp-container.ts'

// 此模块只能由图片子进程入口或测试加载；API 主进程只导入 runner/协议。
sharp.cache(false)
sharp.concurrency(1)
sharp.block({ operation: ['VipsForeignLoad'] })
sharp.unblock({ operation: ['VipsForeignLoadPngBuffer', 'VipsForeignLoadJpegBuffer', 'VipsForeignLoadWebpBuffer', 'VipsForeignLoadNsgifBuffer'] })

const nativeOptions = { animated: true, failOn: 'warning', limitInputPixels: IMAGE_LIMITS.maxTotalPixels, sequentialRead: true } as const
interface Pixels { data: Buffer, width: number, height: number }

export class ImageCodecError extends Error {
  readonly stage: 'encode' | 'verify'
  constructor(stage: 'encode' | 'verify') {
    super('图片处理未完成')
    this.stage = stage
  }
}

async function decode(data: Buffer, container: ImageContainer, orient: boolean): Promise<Pixels> {
  const image = sharp(data, nativeOptions)
  const metadata = await image.metadata()
  requireImage(metadata.width === container.width && (metadata.pageHeight ?? metadata.height) === container.height && (metadata.pages ?? 1) === container.frames)
  const swapped = orient && metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8
  const width = swapped ? container.height : container.width
  const height = swapped ? container.width : container.height
  if (orient)
    image.autoOrient()
  // eslint-disable-next-line no-restricted-properties -- Sharp 的 raw 输出 RGBA 像素，不是 SQL 拼接。
  const raw = await image.toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  requireImage(raw.info.width === width && raw.info.height === height * container.frames && raw.info.channels === 4 && raw.data.length === width * height * container.frames * 4)
  return { data: raw.data, width, height }
}

async function encode(pixels: Pixels, container: ImageContainer): Promise<Buffer> {
  const { width, height, data } = pixels
  const image = sharp(data, { raw: { width, height: height * container.frames, channels: 4, pageHeight: height }, limitInputPixels: IMAGE_LIMITS.maxTotalPixels })
  switch (container.mimeType) {
    case 'image/png': return image.png({ compressionLevel: 6 }).toBuffer()
    case 'image/jpeg': return image.jpeg({ quality: 90 }).toBuffer()
    case 'image/gif': {
      // 用占位延迟避免库的默认最小时长、65535ms 参数上限和循环次数换算。
      const data = await image.gif({ effort: 7, interPaletteMaxError: 0, keepDuplicateFrames: true, loop: 0, delay: 0 }).toBuffer()
      requireImage(container.animation !== undefined)
      return restoreGifAnimation(data, container.animation)
    }
    case 'image/webp': {
      if (!container.animation)
        return image.webp({ lossless: true, exact: true, effort: 4 }).toBuffer()
      const frameBytes = width * height * 4
      const encoded: Buffer[] = []
      let total = 0
      for (let i = 0; i < container.frames; i++) {
        const frame = data.subarray(i * frameBytes, (i + 1) * frameBytes)
        const bytes = await sharp(frame, { raw: { width, height, channels: 4 } }).webp({ lossless: true, exact: true, effort: 4 }).toBuffer()
        total += bytes.length
        requireImage(total <= IMAGE_LIMITS.maxBytes, 'output')
        encoded.push(bytes)
      }
      return assembleAnimatedWebp(encoded, width, height, container.animation)
    }
  }
}

export async function processImage(input: ImageProcessingInput): Promise<ProcessedImage | { rule: AssetInvalidRule }> {
  // HTTP 层在读流时返回 413；这是内部有界接口的防御检查，不谎报成 422 图片损坏。
  if (input.data.byteLength > IMAGE_LIMITS.maxBytes)
    throw new RangeError('图片输入超过字节上限')
  const data = Buffer.from(input.data)
  let container: ImageContainer
  let pixels: Pixels
  try {
    container = inspectContainer(data, input.mimeType, input.extension)
    pixels = await decode(data, container, true)
  }
  catch (error) {
    // 通用 native 解码错误不能据字串推断 OOM；已知 OS/超时事实由父进程区分。
    return { rule: error instanceof ImageRejected ? error.rule : 'corrupt' }
  }

  let output: Buffer
  try {
    output = await encode(pixels, container)
  }
  catch (error) {
    if (error instanceof ImageRejected && error.rule === 'output')
      return { rule: 'output' }
    throw new ImageCodecError('encode')
  }
  if (!output.length || output.length > IMAGE_LIMITS.maxBytes)
    return { rule: 'output' }

  try {
    const verified = inspectContainer(output, input.mimeType, input.extension)
    requireImage(!verified.hasMetadata && verified.width === pixels.width && verified.height === pixels.height && verified.frames === container.frames)
    requireImage(JSON.stringify(verified.animation) === JSON.stringify(container.animation))
    const resultPixels = await decode(output, verified, false)
    // 真正全解码输出；无损格式还逐字节确认 RGBA（包括透明像素的颜色）。
    if (input.mimeType === 'image/png' || input.mimeType === 'image/webp')
      requireImage(resultPixels.data.equals(pixels.data))
    const metadata = await sharp(output, nativeOptions).metadata()
    requireImage(!metadata.exif && !metadata.icc && !metadata.xmp && !metadata.iptc && !metadata.comments && metadata.orientation === undefined)
  }
  catch {
    // 有效输入经本实现编码后不一致是内部失败，不能归罪用户，更不能返回部分成功。
    throw new ImageCodecError('verify')
  }
  return { data: output, sha256: createHash('sha256').update(output).digest('hex'), mimeType: input.mimeType, width: pixels.width, height: pixels.height, frames: container.frames, bytes: output.length }
}
