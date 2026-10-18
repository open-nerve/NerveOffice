import type { AssetInvalidRule, AssetMimeType } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import { IMAGE_LIMITS } from './image-types.ts'

export interface ImageAnimation {
  readonly delays: readonly number[]
  /** GIF 为额外重复次数，null 表示没有循环扩展；WebP 为文件里的总次数。 */
  readonly loop: number | null
}

export interface ImageContainer {
  readonly mimeType: AssetMimeType
  readonly width: number
  readonly height: number
  readonly frames: number
  readonly hasMetadata: boolean
  readonly animation?: ImageAnimation
}

export class ImageRejected extends Error {
  readonly rule: AssetInvalidRule
  constructor(rule: AssetInvalidRule) {
    super('图片不符合处理要求')
    this.rule = rule
  }
}

export function requireImage(condition: boolean, rule: AssetInvalidRule = 'corrupt'): asserts condition {
  if (!condition)
    throw new ImageRejected(rule)
}

export function requireBytes(data: Buffer, offset: number, length: number): void {
  requireImage(offset >= 0 && length >= 0 && offset + length <= data.length)
}

export function checkImageBudget(width: number, height: number, frames = 1): void {
  requireImage(width > 0 && height > 0 && width <= IMAGE_LIMITS.maxSide && height <= IMAGE_LIMITS.maxSide, 'dimensions')
  requireImage(frames > 0 && frames <= IMAGE_LIMITS.maxFrames, 'frames')
  requireImage(width * height <= IMAGE_LIMITS.maxFramePixels && width * height * frames <= IMAGE_LIMITS.maxTotalPixels, 'pixels')
}
