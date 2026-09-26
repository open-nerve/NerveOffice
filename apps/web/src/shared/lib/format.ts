const DATE_TIME = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

/** ISO 8601 的时间按浏览器的时区显示，例如"2026年9月26日 15:00"。 */
export function formatDateTime(iso: string): string {
  return DATE_TIME.format(new Date(iso))
}
