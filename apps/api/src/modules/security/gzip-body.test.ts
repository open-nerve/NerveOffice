import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { gunzipWithin } from './gzip-body.ts'

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

const TEXT = Buffer.from('{"id":"unit","sheetOrder":[],"sheets":{}}', 'utf8')

describe('gunzipWithin', () => {
  it('解压单个完整的 gzip 成员', async () => {
    expect(await gunzipWithin(zlib.gzipSync(TEXT), 1024)).toEqual(TEXT)
  })

  it('解压后恰好等于上限可以，超过上限 413（压缩炸弹在上限处截住）', async () => {
    expect(await gunzipWithin(zlib.gzipSync(Buffer.alloc(1024)), 1024)).toHaveLength(1024)
    const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024))
    expect(bomb.length).toBeLessThan(128 * 1024)
    const error = await rejection(gunzipWithin(bomb, 1024 * 1024))
    expect(error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', message: '请求体解压后超过上限（1048576 字节）' })
  })

  it.each([
    ['不是 gzip', Buffer.from('{"id":"unit"}', 'utf8')],
    ['空的', Buffer.alloc(0)],
    ['被截断', zlib.gzipSync(TEXT).subarray(0, 20)],
    ['末尾多出数据', Buffer.concat([zlib.gzipSync(TEXT), Buffer.from('xyz')])],
    ['末尾多出一个 gzip 头', Buffer.concat([zlib.gzipSync(TEXT), Buffer.from([0x1F, 0x8B])])],
    ['两个成员拼接', Buffer.concat([zlib.gzipSync(TEXT), zlib.gzipSync(TEXT)])],
    // 审查 A1：空成员的 CRC 与长度不影响末尾的核对，浏览器只解第一个成员，得到空串
    ['空成员加上合法的成员', Buffer.concat([zlib.gzipSync(Buffer.alloc(0)), zlib.gzipSync(TEXT)])],
    // 审查 A1：zlib 遇到 0 字节就停下，后面拼上成员的 8 字节尾部，末尾的核对也能通过
    ['成员之后是 0 字节、任意数据与成员的尾部', (() => {
      const member = zlib.gzipSync(TEXT)
      return Buffer.concat([member, Buffer.from([0]), Buffer.from('junk'), member.subarray(member.length - 8)])
    })()],
    ['deflate 而不是 gzip', zlib.deflateSync(TEXT)],
  ])('%s：400 REQUEST_INVALID', async (_case, compressed) => {
    expect(await rejection(gunzipWithin(compressed, 1024))).toMatchObject({ code: 'REQUEST_INVALID', message: '请求体不是完整的 gzip 数据' })
  })

  it('CRC 被改动：400', async () => {
    const tampered = Buffer.from(zlib.gzipSync(TEXT))
    tampered.writeUInt32LE((tampered.readUInt32LE(tampered.length - 8) + 1) % 2 ** 32, tampered.length - 8)
    expect((await rejection(gunzipWithin(tampered, 1024))).code).toBe('REQUEST_INVALID')
  })
})
