import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { validateProcessedImage } from './image-types.ts'

// 已知短字节只验证 IPC 协议；格式的完整解码由 image-codec 的真实图片测试证明。
const data = new Uint8Array([97, 98, 99])
const result = { data, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', mimeType: 'image/png', width: 1, height: 1, frames: 1, bytes: 3 }

describe('父进程校验图片处理结果', () => {
  it('接受有界 Uint8Array 和 IPC Buffer', () => {
    expect(validateProcessedImage(result)).toEqual(result)
    expect(validateProcessedImage({ ...result, data: Buffer.from(data) }).data).toEqual(Buffer.from(data))
  })
  it.each([
    null,
    {},
    { ...result, data: [97, 98, 99] },
    { ...result, data: 'abc' },
    { ...result, bytes: 2 },
    { ...result, sha256: '0'.repeat(64) },
    { ...result, sha256: result.sha256.toUpperCase() },
    { ...result, originalName: 'private-photo.png' },
    { ...result, mimeType: 'image/svg+xml' },
    { ...result, width: 0 },
    { ...result, height: 8193 },
    { ...result, width: 4001, height: 4000 },
    { ...result, mimeType: 'image/webp', width: 800, height: 800, frames: 51 },
    { ...result, mimeType: 'image/gif', frames: 101 },
    { ...result, frames: 0 },
    { ...result, frames: 1.5 },
    { ...result, frames: 2 },
    { ...result, mimeType: 'image/jpeg', frames: 2 },
  ])('拒绝损坏或越界结果 %#，不回显原始数据', (value) => {
    expect(() => validateProcessedImage(value)).toThrow('图片处理结果不符合协议')
  })
  it('空或超过 5 MiB 的结果即使摘要相符也拒绝', () => {
    for (const size of [0, 5 * 1024 * 1024 + 1]) {
      const bytes = Buffer.alloc(size)
      expect(() => validateProcessedImage({ ...result, data: bytes, bytes: size, sha256: createHash('sha256').update(bytes).digest('hex') })).toThrow('图片处理结果不符合协议')
    }
  })
  it('16M 单帧和 32M 总像素边界成立，动画仅 WebP/GIF', () => {
    expect(validateProcessedImage({ ...result, width: 4000, height: 4000 }).width).toBe(4000)
    for (const mimeType of ['image/webp', 'image/gif'])
      expect(validateProcessedImage({ ...result, mimeType, width: 800, height: 800, frames: 50 }).frames).toBe(50)
  })
})
