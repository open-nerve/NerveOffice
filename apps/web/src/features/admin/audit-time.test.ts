// 审计页的时间条件（审查 B8）：本地时间换算成 UTC；结束时间含所选的这一分钟；换算不出接口接受的时刻就不作为条件。
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { auditTimeFrom, auditTimeTo } from './audit-time.ts'

/** 浏览器所在的时区：用例结束时恢复 */
function inTimeZone(zone: string): void {
  vi.stubEnv('TZ', zone)
  onTestFinished(() => {
    vi.unstubAllEnvs()
  })
}

describe('审计页的时间条件', () => {
  it('开始时间：本地时间换算成 UTC（东八区）', () => {
    inTimeZone('Etc/GMT-8')
    expect(auditTimeFrom('2026-09-28T10:30')).toBe('2026-09-28T02:30:00.000Z')
    expect(auditTimeFrom('2026-09-28T07:15')).toBe('2026-09-27T23:15:00.000Z')
  })

  it('结束时间含所选的这一分钟：取下一分钟的开始（接口的 to 不含）', () => {
    inTimeZone('Etc/GMT-8')
    expect(auditTimeTo('2026-09-28T10:30')).toBe('2026-09-28T02:31:00.000Z')
    expect(auditTimeTo('2026-09-28T10:30:45')).toBe('2026-09-28T02:31:00.000Z')
    expect(auditTimeTo('2026-12-31T23:59')).toBe('2026-12-31T16:00:00.000Z')
  })

  it('按本地时间取整到分钟：时区偏移带秒（1901 年以前上海的地方平时 +08:05:43）时也含这一分钟', () => {
    inTimeZone('Asia/Shanghai')
    // 本地 10:30:00 是 UTC 02:24:17；下一分钟的开始是本地 10:31:00，即 UTC 02:25:17
    expect(auditTimeFrom('1900-06-01T10:30')).toBe('1900-06-01T02:24:17.000Z')
    expect(auditTimeTo('1900-06-01T10:30')).toBe('1900-06-01T02:25:17.000Z')
  })

  it('没填、无效：不作为条件', () => {
    expect(auditTimeFrom('')).toBeUndefined()
    expect(auditTimeTo('')).toBeUndefined()
    expect(auditTimeFrom('not a time')).toBeUndefined()
    expect(auditTimeTo('not a time')).toBeUndefined()
  })

  it('换算成 UTC 之后是 0 年，或者超过 9999 年：接口不接受，不发出去（审查 A4、B8）', () => {
    inTimeZone('Etc/GMT-8')
    expect(auditTimeFrom('0001-01-01T05:00')).toBeUndefined()
    expect(auditTimeTo('0001-01-01T05:00')).toBeUndefined()
    expect(auditTimeFrom('0001-01-01T09:00')).toBe('0001-01-01T01:00:00.000Z')
    inTimeZone('UTC')
    expect(auditTimeFrom('9999-12-31T23:59')).toBe('9999-12-31T23:59:00.000Z')
    expect(auditTimeTo('9999-12-31T23:59')).toBeUndefined()
  })
})
