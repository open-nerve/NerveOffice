import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { processImage } from './image-codec.ts'
import { inspectContainer } from './image-container.ts'
import { fixtureInput, imageFixtures } from './image-fixtures.test-support.ts'
import { validateProcessedImage } from './image-types.ts'

describe('四格式正式处理器（固定小矩阵；大矩阵在受限 Linux 串行执行）', () => {
  it.each(imageFixtures.filter(f => !f.large))('$id', async (fixture) => {
    const result = await processImage(fixtureInput(fixture))
    const expected = fixture.expected
    if (expected.status === 'reject') {
      expect(result).toEqual({ rule: expected.rule })
      return
    }
    expect(result).not.toHaveProperty('rule')
    if ('rule' in result)
      throw new Error('正常样本被拒绝')
    expect(validateProcessedImage(result)).toMatchObject({
      width: expected.width,
      height: expected.height,
      frames: expected.frames,
      mimeType: fixture.declaredType,
    })
    const data = Buffer.from(result.data)
    const container = inspectContainer(data, fixture.declaredType, fixture.extension)
    if (expected.delay)
      expect(container.animation).toEqual({ delays: expected.delay, loop: expected.loop })
    expect(container.hasMetadata).toBe(false)

    const native = sharp(data, { animated: true, failOn: 'warning' })
    const meta = await native.metadata()
    for (const field of ['exif', 'icc', 'xmp', 'iptc', 'comments', 'orientation'])
      expect(meta).not.toHaveProperty(field)
    // 逐帧像素预期来自 Pillow，不能用被测处理器或本次输出重算预期。
    // eslint-disable-next-line no-restricted-properties -- Sharp 的 raw 输出像素，不是 SQL。
    const raw = await native.ensureAlpha().raw().toBuffer()
    const frameBytes = result.width * result.height * 4
    expect(raw.length).toBe(frameBytes * result.frames)
    for (let i = 0; i < result.frames; i++) {
      const frame = raw.subarray(i * frameBytes, (i + 1) * frameBytes)
      if (expected.rgbaSha256)
        expect(createHash('sha256').update(frame).digest('hex')).toBe(expected.rgbaSha256[i])
      for (const point of expected.points?.[i] ?? []) {
        const pixel = frame.subarray((point.y * result.width + point.x) * 4, (point.y * result.width + point.x) * 4 + 4)
        for (const [channel, value] of point.rgba.entries())
          expect(Math.abs(pixel[channel]! - value)).toBeLessThanOrEqual(fixture.declaredType === 'image/jpeg' ? 12 : 0)
      }
    }
  })

  it('后缀、声明与文件头均须一致，不能接受路径或其他格式', async () => {
    const input = fixtureInput(imageFixtures[0]!)
    expect(await processImage({ ...input, extension: 'gif' })).toEqual({ rule: 'type' })
    expect(await processImage({ ...input, mimeType: 'image/webp' })).toEqual({ rule: 'type' })
    expect(await processImage({ ...input, data: Buffer.alloc(0) })).toEqual({ rule: 'corrupt' })
  })

  it('在解码前拒绝违反有界输入接口的 5 MiB + 1，不误报图片规则', async () => {
    const fixture = imageFixtures.find(f => f.id === 'above-input')!
    await expect(processImage(fixtureInput(fixture))).rejects.toThrow(RangeError)
  })

  it('只开启四种 Buffer loader，路径/SVG loader 保持关闭', async () => {
    const input = fixtureInput(imageFixtures[0]!)
    await processImage(input)
    // eslint-disable-next-line no-restricted-properties -- 触发真实 Sharp 解码以验证 loader 白名单，不是 SQL。
    await expect(sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')).raw().toBuffer()).rejects.toThrow()
    // eslint-disable-next-line no-restricted-properties -- 同上，检查文件 loader 不能绕过 Buffer 入口。
    await expect(sharp(new URL('./testdata/rgba-text.png', import.meta.url).pathname).raw().toBuffer()).rejects.toThrow()
  })
})
