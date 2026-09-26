import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from './document-cursor.ts'

const CURSOR = { updatedAt: '2026-09-26T15:00:38.878123Z', id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d' }

describe('文档列表的游标', () => {
  it('编码后能原样解开，保留微秒', () => {
    const encoded = encodeCursor(CURSOR)
    expect(encoded).toMatch(/^[\w-]+$/)
    expect(decodeCursor(encoded)).toEqual(CURSOR)
  })

  it.each([
    ['不是 base64url 的 JSON', 'not-json'],
    ['缺字段', Buffer.from(JSON.stringify({ t: CURSOR.updatedAt })).toString('base64url')],
    ['id 不是 UUID', Buffer.from(JSON.stringify({ t: CURSOR.updatedAt, i: 'x' })).toString('base64url')],
    ['时间的写法不对', Buffer.from(JSON.stringify({ t: '2026-09-26 15:00:38', i: CURSOR.id })).toString('base64url')],
    ['多余的字段', Buffer.from(JSON.stringify({ t: CURSOR.updatedAt, i: CURSOR.id, x: 1 })).toString('base64url')],
  ])('不是我们发的游标（%s）：返回 undefined', (_case, value) => {
    expect(decodeCursor(value)).toBeUndefined()
  })

  it.each([
    ['不存在的日期', '2026-02-30T00:00:00.000000Z'],
    ['13 月', '2026-13-01T00:00:00.000000Z'],
    ['24 点', '2026-01-01T24:00:00.000000Z'],
    ['60 秒', '2026-12-31T23:59:60.000000Z'],
    ['0 年（数据库没有）', '0000-01-01T00:00:00.000000Z'],
  ])('写法对、但时间不存在（%s）：返回 undefined，不交给数据库', (_case, updatedAt) => {
    expect(decodeCursor(encodeCursor({ ...CURSOR, updatedAt }))).toBeUndefined()
  })

  it('闰年的 2 月 29 日与公元 1 年都是真实的时间', () => {
    for (const updatedAt of ['2028-02-29T23:59:59.999999Z', '0001-01-01T00:00:00.000000Z'])
      expect(decodeCursor(encodeCursor({ ...CURSOR, updatedAt })), updatedAt).toEqual({ ...CURSOR, updatedAt })
  })
})
