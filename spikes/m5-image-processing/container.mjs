// Format-completeness experiment, alongside full native pixel decoding.
// PNG: W3C PNG Third Edition; GIF: GIF89a blocks and LZW appendix.
import { crc32 } from 'node:zlib'

const invalid = () => { throw new Error('REJECT:invalid') }
const reject = reason => { throw new Error(`REJECT:${reason}`) }

function png(bytes) {
  let offset = 8, first = true, pixels = false
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) invalid()
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid()
    if (first && (type !== 'IHDR' || length !== 13)) invalid()
    if (!first && type === 'IHDR') invalid()
    if (type === 'acTL') reject('animation')
    if (type === 'IDAT') pixels = true
    if (type === 'IEND') {
      if (!pixels || length || end !== bytes.length) invalid()
      return {}
    }
    first = false
    offset = end
  }
  invalid()
}

// Count every decoded index without storing a second full raster. This catches
// early LZW EOI (native libnsgif can fill missing pixels without a warning).
function requireCompleteLzw(data, minimum, pixelCount, colours) {
  if (minimum < 2 || minimum > 8) invalid()
  const clear = 1 << minimum, end = clear + 1
  const lengths = new Uint32Array(4096)
  lengths.fill(1, 0, clear)
  let size = minimum + 1, next = end + 1, previous = -1, count = 0
  let position = 0, buffered = 0, bits = 0
  while (true) {
    while (bits < size) {
      if (position >= data.length) invalid()
      buffered |= data[position++] << bits
      bits += 8
    }
    const code = buffered & ((1 << size) - 1)
    buffered >>>= size
    bits -= size
    if (code === clear) { size = minimum + 1; next = end + 1; previous = -1; continue }
    if (code === end) {
      if (count !== pixelCount) invalid()
      return
    }
    if (code > next || (code === next && previous < 0) || (code < clear && code >= colours)) invalid()
    const length = code === next ? lengths[previous] + 1 : lengths[code]
    if (!length || (previous < 0 && code >= clear)) invalid()
    count += length
    if (count > pixelCount) invalid()
    if (previous >= 0 && next < 4096) {
      lengths[next++] = lengths[previous] + 1
      if (next === 1 << size && size < 12) size++
    }
    previous = code
  }
}

function gif(bytes) {
  let offset = 6, frames = 0, loop, pendingDelay = 0, pendingDelayOffset
  const delay = [], delayOffsets = []
  function take(length) {
    if (offset + length > bytes.length) invalid()
    const value = bytes.subarray(offset, offset + length)
    offset += length
    return value
  }
  function blocks() {
    const parts = []
    while (true) {
      const size = take(1)[0]
      if (!size) return Buffer.concat(parts)
      parts.push(take(size))
    }
  }
  const screen = take(7)
  const width = screen.readUInt16LE(0), height = screen.readUInt16LE(2)
  if (!width || !height) invalid()
  if (width > 8192 || height > 8192) reject('dimensions')
  if (width * height > 16_000_000) reject('pixels')
  const globalColours = screen[4] & 128 ? 1 << ((screen[4] & 7) + 1) : 0
  if (globalColours) take(globalColours * 3)
  while (true) {
    const marker = take(1)[0]
    if (marker === 0x3B) {
      if (!frames || offset !== bytes.length) invalid()
      return { frames, width, height, loop, delay, delayOffsets }
    }
    if (marker === 0x21) {
      const label = take(1)[0]
      if (label === 0xF9) {
        if (take(1)[0] !== 4) invalid()
        pendingDelayOffset = offset + 1
        pendingDelay = take(4).readUInt16LE(1) * 10
        if (take(1)[0] !== 0) invalid()
      }
      else if (label === 0xFF) {
        const app = take(take(1)[0]).toString('ascii')
        const data = blocks()
        if (['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(app)) {
          if (data.length !== 3 || data[0] !== 1) invalid()
          loop = data.readUInt16LE(1)
        }
      }
      else blocks()
      continue
    }
    if (marker !== 0x2C) invalid()
    const descriptor = take(9)
    const left = descriptor.readUInt16LE(0), top = descriptor.readUInt16LE(2)
    const frameWidth = descriptor.readUInt16LE(4), frameHeight = descriptor.readUInt16LE(6)
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height) invalid()
    if (++frames > 100) reject('frames')
    if (frames * width * height > 32_000_000) reject('pixels')
    const localColours = descriptor[8] & 128 ? 1 << ((descriptor[8] & 7) + 1) : 0
    if (localColours) take(localColours * 3)
    const minimum = take(1)[0]
    requireCompleteLzw(blocks(), minimum, frameWidth * frameHeight, localColours || globalColours)
    delay.push(pendingDelay)
    delayOffsets.push(pendingDelayOffset)
    pendingDelay = 0
    pendingDelayOffset = undefined
  }
}

// Read original durations, rather than libvips' browser-style minimum delays.
export function webpChunks(bytes) {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid()
  const chunks = []
  let offset = 12
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) invalid()
    const length = bytes.readUInt32LE(offset + 4), end = offset + 8 + length
    if (end + (length & 1) > bytes.length || ((length & 1) && bytes[end] !== 0)) invalid()
    chunks.push({ type: bytes.toString('ascii', offset, offset + 4), data: bytes.subarray(offset + 8, end) })
    offset = end + (length & 1)
  }
  return chunks
}

function webp(bytes) {
  const chunks = webpChunks(bytes)
  const animation = chunks.filter(chunk => chunk.type === 'ANIM')
  const frames = chunks.filter(chunk => chunk.type === 'ANMF')
  if (!frames.length) return {}
  if (animation.length !== 1 || animation[0].data.length !== 6 || frames.some(frame => frame.data.length < 16)) invalid()
  return { frames: frames.length, loop: animation[0].data.readUInt16LE(4), delay: frames.map(frame => frame.data.readUIntLE(12, 3)) }
}

export function requireCompleteContainer(format, bytes) {
  if (format === 'png') return png(bytes)
  if (format === 'gif') return gif(bytes)
  if (format === 'webp') return webp(bytes)
  if (format === 'jpeg' && (bytes.at(-2) !== 255 || bytes.at(-1) !== 217)) invalid()
  return {}
}
