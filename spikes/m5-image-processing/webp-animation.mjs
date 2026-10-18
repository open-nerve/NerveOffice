// Diagnostic container assembly only. Each frame is encoded by libwebp;
// RIFF/ANMF framing preserves duplicates and raw millisecond durations that
// libwebp's animation optimizer otherwise combines or normalizes.
// https://developers.google.com/speed/webp/docs/riff_container
import { webpChunks } from './container.mjs'

function chunk(type, data) {
  const header = Buffer.alloc(8)
  header.write(type, 0, 'ascii')
  header.writeUInt32LE(data.length, 4)
  return Buffer.concat([header, data, ...(data.length & 1 ? [Buffer.alloc(1)] : [])])
}

export async function encodeWebpAnimation(sharp, pixels, width, height, frames, delay, loop) {
  const extended = Buffer.alloc(10), animation = Buffer.alloc(6)
  extended[0] = 0x12 // animation + alpha; all raw frames have RGBA channels
  extended.writeUIntLE(width - 1, 4, 3)
  extended.writeUIntLE(height - 1, 7, 3)
  animation.writeUInt16LE(loop, 4)
  const chunks = [chunk('VP8X', extended), chunk('ANIM', animation)]
  let bytes = 12 + chunks.reduce((n, item) => n + item.length, 0)
  const frameBytes = width * height * 4
  for (let frame = 0; frame < frames; frame++) {
    const encoded = await sharp(pixels.subarray(frame * frameBytes, (frame + 1) * frameBytes), { raw: { width, height, channels: 4 } })
      .webp({ lossless: true, exact: true, effort: 4 }).toBuffer()
    const image = webpChunks(encoded).filter(part => ['VP8 ', 'VP8L', 'ALPH'].includes(part.type))
    if (image.filter(part => ['VP8 ', 'VP8L'].includes(part.type)).length !== 1) throw new Error('REJECT:invalid')
    const header = Buffer.alloc(16)
    header.writeUIntLE(width - 1, 6, 3)
    header.writeUIntLE(height - 1, 9, 3)
    header.writeUIntLE(delay[frame], 12, 3)
    header[15] = 2 // full decoded canvas, replace rather than blend again
    const framed = chunk('ANMF', Buffer.concat([header, ...image.map(part => chunk(part.type, part.data))]))
    bytes += framed.length
    if (bytes > 5 * 1024 * 1024) throw new Error('REJECT:output')
    chunks.push(framed)
  }
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(bytes - 8, 4)
  header.write('WEBP', 8, 'ascii')
  return Buffer.concat([header, ...chunks])
}
