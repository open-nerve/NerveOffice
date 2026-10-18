// Candidate experiment only; do not import this from production.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { requireCompleteContainer } from './container.mjs'
import { encodeWebpAnimation } from './webp-animation.mjs'

const [runtime, file, destination, declaredType, extension] = process.argv.slice(2)
const sharp = createRequire(join(runtime, 'package.json'))('sharp')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const reject = reason => { throw new Error(`REJECT:${reason}`) }
sharp.cache(false)
sharp.concurrency(1)
sharp.block({ operation: ['VipsForeignLoad'] })
sharp.unblock({ operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpBuffer', 'VipsForeignLoadNsgifBuffer'] })
const options = { animated: true, failOn: 'warning', limitInputPixels: 32_000_000, limitInputChannels: 4 }
let sampledRss = process.memoryUsage().rss
const monitor = setInterval(() => { sampledRss = Math.max(sampledRss, process.memoryUsage().rss) }, 25)
let result, stage = 'input'
try {
  const bytes = await readFile(join('fixtures', file))
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) reject('bytes')
  let format
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) format = 'png'
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) format = 'jpeg'
  else if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) format = 'gif'
  else if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') format = 'webp'
  if (!format || declaredType !== `image/${format}` || !(format === 'jpeg' ? ['jpg', 'jpeg'] : [format]).includes(extension)) reject('type')
  const structure = requireCompleteContainer(format, bytes)
  const metadata = await sharp(bytes, options).metadata()
  if (metadata.format !== format) reject('type')
  const frames = metadata.pages ?? 1
  if (structure.frames !== undefined && structure.frames !== frames) reject('invalid')
  const height = metadata.pageHeight ?? metadata.height
  const width = metadata.width
  if (!width || !height) reject('invalid')
  if (width > 8192 || height > 8192) reject('dimensions')
  if (frames > 100) reject('frames')
  if (width * height > 16_000_000 || width * height * frames > 32_000_000) reject('pixels')
  stage = 'decode'
  const decoded = await sharp(bytes, options).autoOrient().toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  const rawHeight = decoded.info.height / frames
  if (!Number.isInteger(rawHeight) || decoded.data.length !== decoded.info.width * rawHeight * frames * 4) reject('invalid')
  stage = 'encode'
  let encoder = sharp(decoded.data, { raw: { width: decoded.info.width, height: decoded.info.height, channels: 4, ...(frames > 1 ? { pageHeight: rawHeight } : {}) } })
  if (format === 'png') encoder = encoder.png({ compressionLevel: 6 })
  else if (format === 'jpeg') encoder = encoder.jpeg({ quality: 90 })
  else if (format === 'webp') encoder = encoder.webp({ lossless: true, exact: true, effort: 4, ...(frames > 1 ? { loop: metadata.loop, delay: metadata.delay } : {}) })
  else encoder = encoder.gif({ effort: 7, interPaletteMaxError: 0, keepDuplicateFrames: true, loop: metadata.loop ?? 0, delay: metadata.delay ?? [0] })
  const output = format === 'webp' && frames > 1
    ? await encodeWebpAnimation(sharp, decoded.data, decoded.info.width, rawHeight, frames, structure.delay, structure.loop)
    : await encoder.toBuffer()
  if (format === 'gif') {
    const encodedStructure = requireCompleteContainer(format, output)
    if (encodedStructure.frames !== frames) reject('invalid')
    for (let i = 0; i < frames; i++) {
      const offset = encodedStructure.delayOffsets[i]
      if (offset !== undefined) output.writeUInt16LE(structure.delay[i] / 10, offset)
      else if (structure.delay[i] !== 0) reject('invalid')
    }
  }
  if (output.length > 5 * 1024 * 1024) reject('output')
  stage = 'output-decode'
  const finalMetadata = await sharp(output, options).metadata()
  const finalStructure = requireCompleteContainer(format, output)
  const finalPixels = await sharp(output, options).ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  const count = finalMetadata.pages ?? 1
  const finalHeight = finalMetadata.pageHeight ?? finalMetadata.height
  const finalWidth = finalMetadata.width
  if (count !== frames || finalWidth !== decoded.info.width || finalHeight !== rawHeight) reject('invalid')
  const frameBytes = finalWidth * finalHeight * 4
  const points = [], rgbaSha256 = []
  for (let i = 0; i < count; i++) {
    const frame = finalPixels.data.subarray(i * frameBytes, (i + 1) * frameBytes)
    rgbaSha256.push(hash(frame))
    points.push([[0, 0], [finalWidth - 1, 0], [0, finalHeight - 1], [Math.floor(finalWidth / 2), Math.floor(finalHeight / 2)]].map(([x, y]) => [...frame.subarray((y * finalWidth + x) * 4, (y * finalWidth + x) * 4 + 4)]))
  }
  const privateMetadata = ['exif', 'icc', 'xmp', 'iptc', 'comments', 'orientation'].filter(key => finalMetadata[key] !== undefined)
  if (output.includes(Buffer.from('NERVE_TEST_PRIVATE_METADATA'))) privateMetadata.push('marker')
  await writeFile(destination, output, { flag: 'wx' })
  result = { status: 'accept', width: finalWidth, height: finalHeight, frames: count, delay: finalStructure.delay ?? finalMetadata.delay, loop: finalStructure.loop ?? null,
    outputBytes: output.length, outputSha256: hash(output), inputBytes: bytes.length, inputSha256: hash(bytes), privateMetadata, points, rgbaSha256 }
}
catch (error) {
  const message = String(error)
  result = { status: 'reject', reason: message.startsWith('Error: REJECT:') ? message.slice('Error: REJECT:'.length) : 'invalid', diagnostic: message }
}
clearInterval(monitor)
let addressLimit
try { addressLimit = (await readFile('/proc/self/limits', 'utf8')).split('\n').find(line => line.startsWith('Max address space')) }
catch { /* Not a Linux hard-limit result. */ }
console.log(JSON.stringify({ ...result, stage, versions: sharp.versions, sampledRss, maxRssKiB: process.resourceUsage().maxRSS, addressLimit }))
