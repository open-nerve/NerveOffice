import { describe, expect, it } from 'vitest'
import { formatClockTime } from './format.ts'

describe('formatClockTime：服务端的时刻按浏览器的时区写成 HH:mm', () => {
  it('24 小时制、补零，按浏览器的时区（不是 UTC 的钟点）', () => {
    expect(formatClockTime(new Date(2026, 9, 7, 15, 3, 59).toISOString())).toBe('15:03')
    expect(formatClockTime(new Date(2026, 9, 7, 0, 0, 0).toISOString())).toBe('00:00')
    expect(formatClockTime(new Date(2026, 9, 7, 9, 30).toISOString())).toBe('09:30')
  })
})
