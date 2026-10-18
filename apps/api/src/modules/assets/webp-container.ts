import type { ImageAnimation, ImageContainer } from './container-reader.ts'
import { Buffer } from 'node:buffer'
import { checkImageBudget, requireBytes, requireImage } from './container-reader.ts'
import { IMAGE_LIMITS } from './image-types.ts'

interface Chunk { kind: string, payload: Buffer, bytes: Buffer }

function* chunks(data: Buffer, start: number, end: number): Generator<Chunk> {
  let offset = start
  while (offset < end) {
    requireImage(offset + 8 <= end)
    const length = data.readUInt32LE(offset + 4)
    const after = offset + 8 + length + (length & 1)
    requireImage(after <= end && (!(length & 1) || data[after - 1] === 0))
    yield { kind: data.toString('latin1', offset, offset + 4), payload: data.subarray(offset + 8, offset + 8 + length), bytes: data.subarray(offset, after) }
    offset = after
  }
}

function bitstream(chunk: Chunk): { width: number, height: number, alpha: boolean } {
  const data = chunk.payload
  if (chunk.kind === 'VP8L') {
    requireBytes(data, 0, 5)
    requireImage(data[0] === 0x2F)
    const packed = data.readUInt32LE(1)
    requireImage(packed >>> 29 === 0)
    return { width: (packed & 0x3FFF) + 1, height: ((packed >>> 14) & 0x3FFF) + 1, alpha: !!(packed & 0x10000000) }
  }
  requireBytes(data, 0, 10)
  requireImage(chunk.kind === 'VP8 ' && (data.readUInt8(0) & 1) === 0 && data.subarray(3, 6).toString('hex') === '9d012a')
  return { width: data.readUInt16LE(6) & 0x3FFF, height: data.readUInt16LE(8) & 0x3FFF, alpha: false }
}

function frameImage(items: Iterable<Chunk>): { width: number, height: number, alpha: boolean, hasMetadata: boolean } {
  let image: ReturnType<typeof bitstream> | undefined
  let alpha = false
  let hasMetadata = false
  for (const chunk of items) {
    if (chunk.kind === 'ALPH') {
      requireImage(!alpha && !image && chunk.payload.length > 1 && (chunk.payload.readUInt8(0) & 0xC0) === 0)
      alpha = true
    }
    else if (chunk.kind === 'VP8 ' || chunk.kind === 'VP8L') {
      requireImage(!image && !(alpha && chunk.kind === 'VP8L'))
      image = bitstream(chunk)
    }
    else {
      requireImage(!['VP8X', 'ANIM', 'ANMF'].includes(chunk.kind))
      hasMetadata = true
    }
  }
  requireImage(image !== undefined)
  return { ...image, alpha: image.alpha || alpha, hasMetadata }
}

export function inspectWebp(data: Buffer): ImageContainer {
  requireBytes(data, 0, 12)
  requireImage(data.readUInt32LE(4) + 8 === data.length)
  let width = 0
  let height = 0
  let flags: number | undefined
  let loop: number | undefined
  const delays: number[] = []
  const still: Chunk[] = []
  let hasMetadata = false
  let alpha = false
  let index = 0
  let metadataFlags = 0
  for (const chunk of chunks(data, 12, data.length)) {
    const p = chunk.payload
    if (chunk.kind === 'VP8X') {
      requireImage(index === 0 && p.length === 10 && (p.readUInt8(0) & 0xC1) === 0 && p.readUIntLE(1, 3) === 0)
      flags = p.readUInt8(0)
      width = p.readUIntLE(4, 3) + 1
      height = p.readUIntLE(7, 3) + 1
      checkImageBudget(width, height)
    }
    else if (chunk.kind === 'ANIM') {
      requireImage(flags !== undefined && (flags & 2) !== 0 && loop === undefined && delays.length === 0 && still.length === 0 && p.length === 6)
      loop = p.readUInt16LE(4)
    }
    else if (chunk.kind === 'ANMF') {
      requireImage(loop !== undefined && still.length === 0)
      requireBytes(p, 0, 16)
      const frameWidth = p.readUIntLE(6, 3) + 1
      const frameHeight = p.readUIntLE(9, 3) + 1
      requireImage(p.readUIntLE(0, 3) * 2 + frameWidth <= width && p.readUIntLE(3, 3) * 2 + frameHeight <= height && (p.readUInt8(15) & 0xFC) === 0)
      checkImageBudget(width, height, delays.length + 1)
      const frame = frameImage(chunks(p, 16, p.length))
      requireImage(frame.width === frameWidth && frame.height === frameHeight)
      alpha ||= frame.alpha
      hasMetadata ||= frame.hasMetadata
      delays.push(p.readUIntLE(12, 3))
    }
    else if (chunk.kind === 'ALPH' || chunk.kind === 'VP8 ' || chunk.kind === 'VP8L') {
      requireImage(loop === undefined && !(flags !== undefined && flags & 2))
      // 一个静态 bitstream 和一个可选 ALPH，不能把任意数量的块积进内存。
      requireImage(still.length < 2)
      still.push(chunk)
    }
    else {
      hasMetadata = true
      const flag = ({ 'ICCP': 0x20, 'EXIF': 0x08, 'XMP ': 0x04 } as Record<string, number>)[chunk.kind] ?? 0
      requireImage(!flag || (flags !== undefined && (flags & flag) !== 0 && !(metadataFlags & flag)))
      if (chunk.kind === 'ICCP')
        requireImage(still.length === 0 && delays.length === 0)
      metadataFlags |= flag
    }
    index++
  }
  requireImage(flags === undefined || (flags & 0x2C) === metadataFlags)
  if (loop !== undefined) {
    requireImage(delays.length > 0 && flags !== undefined && (!alpha || (flags & 0x10) !== 0))
    return { mimeType: 'image/webp', width, height, frames: delays.length, hasMetadata, animation: { delays, loop } }
  }
  requireImage(flags === undefined || (flags & 2) === 0)
  const frame = frameImage(still)
  if (flags !== undefined)
    requireImage(frame.width === width && frame.height === height && (!frame.alpha || (flags & 0x10) !== 0))
  else
    requireImage(still.length === 1)
  checkImageBudget(frame.width, frame.height)
  return { mimeType: 'image/webp', width: frame.width, height: frame.height, frames: 1, hasMetadata }
}

function chunkBytes(kind: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.write(kind, 0, 4, 'ascii')
  header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload, Buffer.alloc(payload.length & 1)])
}

/** 每帧是 fresh native lossless 编码；这里只封装公开 RIFF/ANMF，不实现 VP8 编码。 */
export function assembleAnimatedWebp(encodedFrames: readonly Buffer[], width: number, height: number, animation: ImageAnimation): Buffer {
  requireImage(encodedFrames.length === animation.delays.length && animation.loop !== null)
  const header = Buffer.alloc(10)
  header[0] = 2
  header.writeUIntLE(width - 1, 4, 3)
  header.writeUIntLE(height - 1, 7, 3)
  const control = Buffer.alloc(6)
  control.writeUInt16LE(animation.loop, 4)
  const frames: Buffer[] = []
  let length = 12 + 18 + 14
  for (const [i, encoded] of encodedFrames.entries()) {
    const image = inspectWebp(encoded)
    requireImage(image.width === width && image.height === height && image.frames === 1 && !image.animation && !image.hasMetadata)
    const bits = [...chunks(encoded, 12, encoded.length)].filter(c => c.kind === 'VP8L')
    const only = bits[0]
    requireImage(bits.length === 1 && only !== undefined)
    if (bitstream(only).alpha)
      header[0] = header.readUInt8(0) | 0x10
    const frameHeader = Buffer.alloc(16)
    frameHeader.writeUIntLE(width - 1, 6, 3)
    frameHeader.writeUIntLE(height - 1, 9, 3)
    const delay = animation.delays[i]
    requireImage(delay !== undefined)
    frameHeader.writeUIntLE(delay, 12, 3)
    frameHeader[15] = 2 // 完整画布覆盖，不混合；保留连续相同帧。
    const frame = chunkBytes('ANMF', Buffer.concat([frameHeader, only.bytes]))
    length += frame.length
    requireImage(length <= IMAGE_LIMITS.maxBytes, 'output')
    frames.push(frame)
  }
  const riff = Buffer.alloc(12)
  riff.write('RIFF')
  riff.writeUInt32LE(length - 8, 4)
  riff.write('WEBP', 8)
  return Buffer.concat([riff, chunkBytes('VP8X', header), chunkBytes('ANIM', control), ...frames], length)
}
