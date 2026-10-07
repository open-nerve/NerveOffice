const DATE_TIME = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

/** ISO 8601 的时间按浏览器的时区显示，例如"2026年9月26日 15:00"。 */
export function formatDateTime(iso: string): string {
  return DATE_TIME.format(new Date(iso))
}

/**
 * ISO 8601 的时刻按浏览器的时区写成"HH:mm"（24 小时制，补零），例如编辑权留给请求方到几点（M3-P5）。只格式化服务端给的时刻，
 * 不与浏览器的时钟比较（浏览器的时钟可能不准，M3 总设计 §2.1）
 */
export function formatClockTime(iso: string): string {
  const at = new Date(iso)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}
