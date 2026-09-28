import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { decodeTimeCursor, encodeTimeCursor } from './time-cursor.ts'

const CURSOR = { position: '2026-09-26T15:00:38.878123Z', id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d' }

describe('按时间排序的列表的游标', () => {
  it('编码后能原样解开，保留微秒', () => {
    const encoded = encodeTimeCursor(CURSOR)
    expect(encoded).toMatch(/^[\w-]+$/)
    expect(decodeTimeCursor(encoded)).toEqual(CURSOR)
  })

  it.each([
    ['不是 base64url 的 JSON', 'not-json'],
    ['缺字段', Buffer.from(JSON.stringify({ t: CURSOR.position })).toString('base64url')],
    ['id 不是 UUID', Buffer.from(JSON.stringify({ t: CURSOR.position, i: 'x' })).toString('base64url')],
    ['时间的写法不对', Buffer.from(JSON.stringify({ t: '2026-09-26 15:00:38', i: CURSOR.id })).toString('base64url')],
    ['多余的字段', Buffer.from(JSON.stringify({ t: CURSOR.position, i: CURSOR.id, x: 1 })).toString('base64url')],
  ])('不是我们发的游标（%s）：返回 undefined', (_case, value) => {
    expect(decodeTimeCursor(value)).toBeUndefined()
  })

  it.each([
    ['不存在的日期', '2026-02-30T00:00:00.000000Z'],
    ['13 月', '2026-13-01T00:00:00.000000Z'],
    ['24 点', '2026-01-01T24:00:00.000000Z'],
    ['60 秒', '2026-12-31T23:59:60.000000Z'],
    ['0 年（数据库没有）', '0000-01-01T00:00:00.000000Z'],
  ])('写法对、但时间不存在（%s）：返回 undefined，不交给数据库', (_case, position) => {
    expect(decodeTimeCursor(encodeTimeCursor({ ...CURSOR, position }))).toBeUndefined()
  })

  it('闰年的 2 月 29 日与公元 1 年都是真实的时间', () => {
    for (const position of ['2028-02-29T23:59:59.999999Z', '0001-01-01T00:00:00.000000Z'])
      expect(decodeTimeCursor(encodeTimeCursor({ ...CURSOR, position })), position).toEqual({ ...CURSOR, position })
  })
})
