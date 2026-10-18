import type { ImageAnimation, ImageContainer } from './container-reader.ts'
import { Buffer } from 'node:buffer'
import { checkImageBudget, requireBytes, requireImage } from './container-reader.ts'

interface GifFrame {
  imageOffset: number
  controlOffset?: number
}
interface GifContainer extends ImageContainer {
  animation: ImageAnimation
  imageFrames: GifFrame[]
  headerEnd: number
  loopBlock?: { start: number, end: number, valueOffset: number }
}

function subBlocks(data: Buffer, start: number): { end: number, payload: Buffer } {
  const chunks: Buffer[] = []
  let offset = start
  for (;;) {
    requireBytes(data, offset, 1)
    const length = data.readUInt8(offset++)
    if (!length)
      return { end: offset, payload: Buffer.concat(chunks) }
    requireBytes(data, offset, length)
    chunks.push(data.subarray(offset, offset + length))
    offset += length
  }
}

/**
 * 只算每个 LZW 词的长度/首索引/最大索引，不另分配像素或重做 native 合成。
 * GIF89a 附录 F：字典满后保持 12 位直到 clear；结束码与精确像素数缺一不可。
 */
function validateRaster(data: Buffer, bits: number, pixels: number, colors: number): void {
  requireImage(bits >= 2 && bits <= 8)
  const clear = 1 << bits
  const end = clear + 1
  const lengths = new Uint16Array(4096)
  const first = new Uint16Array(4096)
  const largest = new Uint16Array(4096)
  for (let i = 0; i < clear; i++) {
    lengths[i] = 1
    first[i] = largest[i] = i
  }
  let next = clear + 2
  let codeBits = bits + 1
  let previous = -1
  let bitOffset = 0
  let count = 0
  while (bitOffset + codeBits <= data.length * 8) {
    const byteOffset = bitOffset >>> 3
    const word = data.readUInt8(byteOffset) | ((data[byteOffset + 1] ?? 0) << 8) | ((data[byteOffset + 2] ?? 0) << 16)
    const code = (word >>> (bitOffset & 7)) & ((1 << codeBits) - 1)
    bitOffset += codeBits
    if (code === clear) {
      next = clear + 2
      codeBits = bits + 1
      previous = -1
      continue
    }
    if (code === end) {
      requireImage(count === pixels && data.length * 8 - bitOffset < 8)
      return
    }
    requireImage(code < next || (code === next && previous >= 0))
    const currentFirst = (code === next ? first[previous] : first[code]) ?? 0
    const currentLength = code === next ? (lengths[previous] ?? 0) + 1 : (lengths[code] ?? 0)
    const currentLargest = (code === next ? largest[previous] : largest[code]) ?? 0
    requireImage(currentLength > 0 && currentLargest < colors)
    count += currentLength
    requireImage(count <= pixels)
    if (previous >= 0 && next < 4096) {
      lengths[next] = (lengths[previous] ?? 0) + 1
      first[next] = first[previous] ?? 0
      largest[next] = Math.max(largest[previous] ?? 0, currentFirst)
      next++
      if (next === 1 << codeBits && codeBits < 12)
        codeBits++
    }
    previous = code
  }
  requireImage(false)
}

export function inspectGif(data: Buffer): GifContainer {
  requireBytes(data, 0, 13)
  const width = data.readUInt16LE(6)
  const height = data.readUInt16LE(8)
  checkImageBudget(width, height)
  const globalColors = (data.readUInt8(10) & 0x80) ? 2 ** ((data.readUInt8(10) & 7) + 1) : 0
  requireBytes(data, 13, globalColors * 3)
  const headerEnd = 13 + globalColors * 3
  let offset = headerEnd
  let loop: number | null = null
  let loopBlock: GifContainer['loopBlock']
  let pending: { offset: number, delay: number, transparent?: number } | undefined
  let hasMetadata = false
  const delays: number[] = []
  const imageFrames: GifFrame[] = []
  while (offset < data.length) {
    const start = offset
    const marker = data[offset++]
    if (marker === 0x3B) {
      requireImage(offset === data.length && !pending && imageFrames.length > 0)
      return { mimeType: 'image/gif', width, height, frames: imageFrames.length, hasMetadata, animation: { delays, loop }, imageFrames, loopBlock, headerEnd }
    }
    if (marker === 0x21) {
      requireBytes(data, offset, 1)
      const label = data[offset++]
      if (label === 0xF9) {
        requireBytes(data, offset, 6)
        requireImage(!pending && data[offset] === 4 && data[offset + 5] === 0)
        const flags = data.readUInt8(offset + 1)
        requireImage((flags & 0xE0) === 0 && ((flags >>> 2) & 7) <= 3)
        requireImage((flags & 2) === 0, 'animation') // 等待用户输入的图不能静默转成定时动画。
        pending = { offset: start, delay: data.readUInt16LE(offset + 2) * 10, transparent: flags & 1 ? data[offset + 4] : undefined }
        offset += 6
      }
      else if (label === 0xFF) {
        requireBytes(data, offset, 12)
        requireImage(data[offset] === 11)
        const application = data.toString('latin1', offset + 1, offset + 12)
        const blocks = subBlocks(data, offset + 12)
        if (application === 'NETSCAPE2.0' || application === 'ANIMEXTS1.0') {
          requireImage(!loopBlock && imageFrames.length === 0 && blocks.payload.length === 3 && blocks.payload[0] === 1 && data[offset + 12] === 3)
          loop = blocks.payload.readUInt16LE(1)
          loopBlock = { start, end: blocks.end, valueOffset: offset + 14 }
        }
        else {
          hasMetadata = true
        }
        offset = blocks.end
      }
      else {
        // Plain Text 是需要字形渲染的 graphic block，不可当注释剥掉后宣称保留像素。
        requireImage(label !== 0x01, 'animation')
        offset = subBlocks(data, offset).end
        hasMetadata = true
      }
      continue
    }
    requireImage(marker === 0x2C)
    requireBytes(data, offset, 9)
    const left = data.readUInt16LE(offset)
    const top = data.readUInt16LE(offset + 2)
    const frameWidth = data.readUInt16LE(offset + 4)
    const frameHeight = data.readUInt16LE(offset + 6)
    const flags = data.readUInt8(offset + 8)
    requireImage(frameWidth > 0 && frameHeight > 0 && left + frameWidth <= width && top + frameHeight <= height && (flags & 0x18) === 0)
    checkImageBudget(width, height, imageFrames.length + 1)
    const localColors = flags & 0x80 ? 2 ** ((flags & 7) + 1) : 0
    const colors = localColors || globalColors
    requireImage(colors > 0 && (pending?.transparent === undefined || pending.transparent < colors))
    offset += 9
    requireBytes(data, offset, localColors * 3 + 1)
    offset += localColors * 3
    const bits = data.readUInt8(offset++)
    const blocks = subBlocks(data, offset)
    validateRaster(blocks.payload, bits, frameWidth * frameHeight, colors)
    imageFrames.push({ imageOffset: start, controlOffset: pending?.offset })
    delays.push(pending?.delay ?? 0)
    pending = undefined
    offset = blocks.end
  }
  requireImage(false)
}

/** 新编码字节中的 GCE/循环只写回输入已经核验的语义；不携带输入的其他扩展。 */
export function restoreGifAnimation(data: Buffer, animation: ImageAnimation): Buffer {
  const output = inspectGif(data)
  requireImage(output.frames === animation.delays.length)
  const edits: { start: number, end: number, bytes: Buffer }[] = []
  for (const [i, frame] of output.imageFrames.entries()) {
    const start = frame.controlOffset ?? frame.imageOffset
    const bytes = frame.controlOffset === undefined
      ? Buffer.from([0x21, 0xF9, 4, 0, 0, 0, 0, 0])
      : Buffer.from(data.subarray(start, start + 8))
    const delay = animation.delays[i]
    requireImage(delay !== undefined)
    bytes.writeUInt16LE(delay / 10, 4)
    edits.push({ start, end: frame.controlOffset === undefined ? start : start + 8, bytes })
  }
  const loopBytes = animation.loop === null
    ? Buffer.alloc(0)
    : Buffer.concat([Buffer.from([0x21, 0xFF, 11]), Buffer.from('NETSCAPE2.0'), Buffer.from([3, 1, animation.loop & 255, animation.loop >>> 8, 0])])
  edits.push({ start: output.loopBlock?.start ?? output.headerEnd, end: output.loopBlock?.end ?? output.headerEnd, bytes: loopBytes })
  edits.sort((a, b) => a.start - b.start || a.end - b.end)
  let previous = 0
  const parts: Buffer[] = []
  for (const edit of edits) {
    parts.push(data.subarray(previous, edit.start), edit.bytes)
    previous = edit.end
  }
  parts.push(data.subarray(previous))
  return Buffer.concat(parts)
}
