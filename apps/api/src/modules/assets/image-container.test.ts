import { Buffer } from 'node:buffer'
import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { ImageRejected } from './container-reader.ts'
import { processImage } from './image-codec.ts'
import { inspectContainer } from './image-container.ts'
import { fixtureInput, imageFixtures } from './image-fixtures.test-support.ts'

function fixture(id: string) {
  return fixtureInput(imageFixtures.find(f => f.id === id)!)
}

function pngChunk(kind: string, data = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length)
  header.write(kind, 4)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind), data])))
  return Buffer.concat([header, data, crc])
}

function minimalGif({ frames = 2, loop = 65535, userInput = false }: { frames?: number, loop?: number | null, userInput?: boolean } = {}): Buffer {
  // 手写 1x1 红色 GIF：LZW 三个 3-bit code 为 clear(4), literal(0), end(5)。
  const parts = [Buffer.from('47494638396101000100800000ff00000000ff', 'hex')]
  if (loop !== null)
    parts.push(Buffer.concat([Buffer.from('21ff0b4e45545343415045322e300301', 'hex'), Buffer.from([loop & 255, loop >>> 8, 0])]))
  for (let i = 0; i < frames; i++) {
    parts.push(Buffer.from([0x21, 0xF9, 4, userInput ? 2 : 0, i % 2 ? 255 : 0, i % 2 ? 255 : 0, 0, 0]))
    parts.push(Buffer.from('2c0000000001000100000202440100', 'hex'))
  }
  return Buffer.concat([...parts, Buffer.from([0x3B])])
}

describe('容器边界和语义', () => {
  it.each(['minimum', 'single', 'static', 'progressive'])('%s 在任一字节截断均失败，不能越界读', (id) => {
    const input = fixture(id)
    for (let length = 0; length < input.data.length; length++)
      expect(() => inspectContainer(input.data.subarray(0, length), input.mimeType, input.extension)).toThrow(ImageRejected)
  })

  it.each(['minimum', 'single', 'static', 'progressive'])('%s 拒绝尾随字节或第二份文件', (id) => {
    const input = fixture(id)
    for (const tail of [Buffer.from([0]), input.data])
      expect(() => inspectContainer(Buffer.concat([input.data, tail]), input.mimeType, input.extension)).toThrow(ImageRejected)
  })

  it.each(['single', 'static'])('%s 的 magic 按原始字节匹配，不能丢弃高位', async (id) => {
    const input = fixture(id)
    input.data[0]! |= 0x80
    expect(await processImage(input)).toEqual({ rule: 'type' })
  })

  it('PNG 拒绝未知关键块、错误顺序、重复头和非连续像素块', async () => {
    const input = fixture('minimum')
    const header = input.data.subarray(0, 33)
    const pixels = input.data.subarray(33, input.data.length - 12)
    const end = input.data.subarray(-12)
    for (const data of [
      Buffer.concat([header, pngChunk('ABCD'), pixels, end]),
      Buffer.concat([header, header.subarray(8), pixels, end]),
      Buffer.concat([input.data.subarray(0, 8), pixels, header.subarray(8), end]),
      Buffer.concat([header, pixels, pngChunk('tEXt', Buffer.from('note\0private')), pngChunk('IDAT'), end]),
      Buffer.concat([header, pngChunk('PLTE', Buffer.from([1, 2])), pixels, end]),
    ])
      expect(await processImage({ ...input, data })).toEqual({ rule: 'corrupt' })
  })

  it('PNG 的文字/EXIF 元数据在 fresh 编码后不保留', async () => {
    const input = fixture('minimum')
    const data = Buffer.concat([input.data.subarray(0, -12), pngChunk('tEXt', Buffer.from('private\0location')), input.data.subarray(-12)])
    expect(inspectContainer(data, 'image/png', 'png').hasMetadata).toBe(true)
    const result = await processImage({ ...input, data })
    expect(result).not.toHaveProperty('rule')
    if ('rule' in result)
      throw new Error('正常样本被拒绝')
    expect(Buffer.from(result.data).includes(Buffer.from('location'))).toBe(false)
  })

  it.each([65535, 0, null])('GIF 重复帧、原始 0/655350ms 和循环 %s 不被合并或归一化', async (loop) => {
    const result = await processImage({ data: minimalGif({ loop }), mimeType: 'image/gif', extension: 'gif' })
    expect(result).not.toHaveProperty('rule')
    if ('rule' in result)
      throw new Error('正常样本被拒绝')
    expect(inspectContainer(Buffer.from(result.data), 'image/gif', 'gif')).toMatchObject({ width: 1, height: 1, frames: 2, animation: { delays: [0, 655350], loop } })
  })

  it('GIF 的 100 帧成立，101 帧在解码前拒绝；用户交互帧不能变成普通动画', async () => {
    expect(inspectContainer(minimalGif({ frames: 100 }), 'image/gif', 'gif').frames).toBe(100)
    expect(await processImage({ data: minimalGif({ frames: 101 }), mimeType: 'image/gif', extension: 'gif' })).toEqual({ rule: 'frames' })
    expect(await processImage({ data: minimalGif({ userInput: true }), mimeType: 'image/gif', extension: 'gif' })).toEqual({ rule: 'animation' })
  })

  it('GIF 单帧无循环也能保留，坏像素索引/多余压缩数据拒绝', async () => {
    const data = minimalGif({ frames: 1, loop: null })
    const result = await processImage({ data, mimeType: 'image/gif', extension: 'gif' })
    expect(result).not.toHaveProperty('rule')
    if ('rule' in result)
      throw new Error('正常样本被拒绝')
    expect(inspectContainer(Buffer.from(result.data), 'image/gif', 'gif').animation).toEqual({ delays: [0], loop: null })
    const index = Buffer.from(data)
    index[index.length - 4] = 0x5C // literal(3)，超过两色调色板。
    expect(await processImage({ data: index, mimeType: 'image/gif', extension: 'gif' })).toEqual({ rule: 'corrupt' })
    const extra = Buffer.concat([data.subarray(0, -5), Buffer.from([3, 0x44, 0x01, 0, 0, 0x3B])])
    expect(await processImage({ data: extra, mimeType: 'image/gif', extension: 'gif' })).toEqual({ rule: 'corrupt' })
  })

  it('WebP 保留 24-bit 原始帧时长和最大循环次数，忽略库的最小时长', async () => {
    const input = fixture('animated-webp')
    // 固定自有文件：按公开 chunk 边界定位，预期值为手工给定而非被测解析器生成。
    let frame = 0
    for (let offset = 12; offset < input.data.length; offset += 8 + input.data.readUInt32LE(offset + 4) + (input.data.readUInt32LE(offset + 4) & 1)) {
      const kind = input.data.toString('latin1', offset, offset + 4)
      if (kind === 'ANIM')
        input.data.writeUInt16LE(65535, offset + 12)
      if (kind === 'ANMF')
        input.data.writeUIntLE([0, 10, 16777215][frame++]!, offset + 20, 3)
    }
    const result = await processImage(input)
    expect(result).not.toHaveProperty('rule')
    if ('rule' in result)
      throw new Error('正常样本被拒绝')
    expect(inspectContainer(Buffer.from(result.data), 'image/webp', 'webp').animation).toEqual({ delays: [0, 10, 16777215], loop: 65535 })
  })

  it('正式大样本先检查元数据预算，满额样本可以进入解码', () => {
    for (const item of imageFixtures.filter(f => f.large && !['above-input', 'output-growth'].includes(f.id))) {
      const input = fixtureInput(item)
      if (item.expected.status === 'reject') {
        expect(() => inspectContainer(input.data, input.mimeType, input.extension)).toThrow(ImageRejected)
        try {
          inspectContainer(input.data, input.mimeType, input.extension)
        }
        catch (error) {
          expect(error).toHaveProperty('rule', item.expected.rule)
        }
      }
      else {
        expect(inspectContainer(input.data, input.mimeType, input.extension)).toMatchObject({ width: item.expected.width, height: item.expected.height, frames: item.expected.frames })
      }
    }
  })
})
