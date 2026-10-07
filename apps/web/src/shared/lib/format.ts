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

/**
 * 服务端给的、刚过去不久的时刻（例如异常中断的时刻，M3-P5 设计 §3.11）按浏览器的时区写成"HH:mm"；"现在"可能已经是另一天时前面加上日期
 * （"10月6日 23:50"）。只格式化服务端的时刻，不与浏览器的时钟比较（M3 总设计 §2.1）：服务端只在这个时刻之后 recentMs 之内给出它，
 * 所以"现在"一定落在 [时刻, 时刻 + recentMs] 里——这段时间跨过了午夜（按页面的时区）才可能不是今天，这时加上日期；没跨过的一定是今天。
 * 代价是午夜之前 recentMs 之内的时刻即使还是今天也带日期（照样对）；换来的是浏览器的时钟不准时也不会该写日期却没写（只看服务端的时刻）。
 * 说明在页面上留得比 recentMs 还久（一直没点"知道了"、编辑到了第二天）时日期不会补上：那时它说的事早已过去，不再值得为它读时钟
 */
export function formatRecentClockTime(iso: string, recentMs: number): string {
  const at = new Date(iso)
  const until = new Date(at.getTime() + recentMs)
  const sameDay = at.getFullYear() === until.getFullYear() && at.getMonth() === until.getMonth() && at.getDate() === until.getDate()
  // 日期按浏览器的时区写成"10月6日"（不经 Intl：各浏览器、各版本的 ICU 对"月、日"的写法不一，"10/6"读起来像分数）
  return sameDay ? formatClockTime(iso) : `${at.getMonth() + 1}月${at.getDate()}日 ${formatClockTime(iso)}`
}
