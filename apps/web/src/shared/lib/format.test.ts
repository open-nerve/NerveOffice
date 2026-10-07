import { describe, expect, it } from 'vitest'
import { formatClockTime, formatRecentClockTime } from './format.ts'

describe('formatClockTime：服务端的时刻按浏览器的时区写成 HH:mm', () => {
  it('24 小时制、补零，按浏览器的时区（不是 UTC 的钟点）', () => {
    expect(formatClockTime(new Date(2026, 9, 7, 15, 3, 59).toISOString())).toBe('15:03')
    expect(formatClockTime(new Date(2026, 9, 7, 0, 0, 0).toISOString())).toBe('00:00')
    expect(formatClockTime(new Date(2026, 9, 7, 9, 30).toISOString())).toBe('09:30')
  })
})

describe('formatRecentClockTime：刚过去不久的服务端时刻（M3-P5 设计 §3.11 的异常中断）——"现在"可能已经是另一天时带日期，不与浏览器的时钟比较', () => {
  const HALF_HOUR = 30 * 60_000

  it('从这个时刻起 recentMs 之内都还是同一天（按浏览器的时区）：只写 HH:mm', () => {
    expect(formatRecentClockTime(new Date(2026, 9, 7, 14, 32, 10).toISOString(), HALF_HOUR)).toBe('14:32')
    expect(formatRecentClockTime(new Date(2026, 9, 7, 0, 5).toISOString(), HALF_HOUR)).toBe('00:05')
    expect(formatRecentClockTime(new Date(2026, 9, 7, 23, 29, 59).toISOString(), HALF_HOUR)).toBe('23:29')
  })

  it('这段时间跨过了午夜（"现在"可能已经是第二天）：前面加上日期（月、日），钟点照样按浏览器的时区', () => {
    expect(formatRecentClockTime(new Date(2026, 9, 6, 23, 50).toISOString(), HALF_HOUR)).toBe('10月6日 23:50')
    expect(formatRecentClockTime(new Date(2026, 9, 6, 23, 30).toISOString(), HALF_HOUR)).toBe('10月6日 23:30')
    expect(formatRecentClockTime(new Date(2026, 11, 31, 23, 45).toISOString(), HALF_HOUR)).toBe('12月31日 23:45')
  })

  it('跨不跨午夜只看这个时刻与 recentMs：同一个时刻，范围更长时带日期', () => {
    const at = new Date(2026, 9, 7, 20, 0).toISOString()
    expect(formatRecentClockTime(at, HALF_HOUR)).toBe('20:00')
    expect(formatRecentClockTime(at, 5 * 60 * 60_000)).toBe('10月7日 20:00')
  })
})
