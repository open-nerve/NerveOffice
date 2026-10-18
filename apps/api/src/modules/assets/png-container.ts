import type { Buffer } from 'node:buffer'
import type { ImageContainer } from './container-reader.ts'
import { crc32 } from 'node:zlib'
import { checkImageBudget, requireBytes, requireImage } from './container-reader.ts'

/** PNG 规范的块长度、CRC 与结构；像素流由后续 native 全解码核验。 */
export function inspectPng(data: Buffer): ImageContainer {
  let offset = 8
  let width = 0
  let height = 0
  let color = -1
  let depth = 0
  let palette = false
  let imageData = false
  let endedData = false
  let hasMetadata = false
  while (offset < data.length) {
    requireBytes(data, offset, 12)
    const length = data.readUInt32BE(offset)
    requireImage(length <= 0x7FFFFFFF)
    requireBytes(data, offset + 8, length + 4)
    const kind = data.toString('latin1', offset + 4, offset + 8)
    requireImage(/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(kind))
    const payload = data.subarray(offset + 8, offset + 8 + length)
    requireImage(crc32(data.subarray(offset + 4, offset + 8 + length)) === data.readUInt32BE(offset + 8 + length))
    requireImage(offset !== 8 || kind === 'IHDR')
    requireImage(!['acTL', 'fcTL', 'fdAT'].includes(kind), 'animation')
    if (kind === 'IHDR') {
      requireImage(offset === 8 && length === 13)
      width = payload.readUInt32BE(0)
      height = payload.readUInt32BE(4)
      depth = payload.readUInt8(8)
      color = payload.readUInt8(9)
      const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      requireImage(depths[color]?.includes(depth) === true && payload[10] === 0 && payload[11] === 0 && payload.readUInt8(12) <= 1)
      checkImageBudget(width, height)
    }
    else if (kind === 'PLTE') {
      requireImage(!palette && !imageData && length > 0 && length % 3 === 0 && length <= 768 && color !== 0 && color !== 4)
      requireImage(color !== 3 || length / 3 <= 2 ** depth)
      palette = true
    }
    else if (kind === 'IDAT') {
      requireImage(!endedData && (color !== 3 || palette))
      imageData = true
    }
    else if (kind === 'IEND') {
      requireImage(length === 0 && imageData && offset + 12 === data.length)
      return { mimeType: 'image/png', width, height, frames: 1, hasMetadata }
    }
    else {
      requireImage(kind.charAt(0) === kind.charAt(0).toLowerCase()) // 未知关键块不能静默忽略。
      if (imageData)
        endedData = true
      if (['eXIf', 'iCCP', 'tEXt', 'zTXt', 'iTXt'].includes(kind))
        hasMetadata = true
    }
    offset += length + 12
  }
  requireImage(false)
}
