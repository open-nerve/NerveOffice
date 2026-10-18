import type { Buffer } from 'node:buffer'
import type { ImageContainer } from './container-reader.ts'
import { checkImageBudget, requireBytes, requireImage } from './container-reader.ts'

const FRAME_MARKERS = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF])

/** 标记段边界包含多次扫描的渐进 JPEG；有 EOI 仍必须全解码扫描像素。 */
export function inspectJpeg(data: Buffer): ImageContainer {
  let offset = 2
  let width = 0
  let height = 0
  let scanned = false
  let hasMetadata = false
  while (offset < data.length) {
    requireImage(data[offset++] === 0xFF)
    while (data[offset] === 0xFF)
      offset++
    requireBytes(data, offset, 1)
    const marker = data.readUInt8(offset++)
    if (marker === 0xD9) {
      requireImage(scanned && width > 0 && offset === data.length)
      return { mimeType: 'image/jpeg', width, height, frames: 1, hasMetadata }
    }
    requireImage(marker !== 0 && marker !== 0xD8 && marker !== 1 && !(marker >= 0xD0 && marker <= 0xD7))
    requireBytes(data, offset, 2)
    const length = data.readUInt16BE(offset)
    requireImage(length >= 2)
    requireBytes(data, offset, length)
    if (FRAME_MARKERS.has(marker)) {
      requireImage(width === 0 && length >= 8 && length === 8 + 3 * data.readUInt8(offset + 7))
      height = data.readUInt16BE(offset + 3)
      width = data.readUInt16BE(offset + 5)
      checkImageBudget(width, height)
    }
    if ([0xE1, 0xE2, 0xED, 0xFE].includes(marker))
      hasMetadata = true
    offset += length
    if (marker === 0xDA) {
      requireImage(width > 0)
      scanned = true
      // 熵编码中的 FF00 为字节填充，FFD0..D7 为 restart；其余交回标记解析。
      while (offset < data.length) {
        if (data[offset] !== 0xFF) {
          offset++
          continue
        }
        let next = offset + 1
        while (data[next] === 0xFF)
          next++
        requireBytes(data, next, 1)
        if (data[next] === 0 || (data.readUInt8(next) >= 0xD0 && data.readUInt8(next) <= 0xD7))
          offset = next + 1
        else
          break
      }
    }
  }
  requireImage(false)
}
