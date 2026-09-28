// 审计页的时间条件（M2-P1 设计 §3.7）：datetime-local 的值是浏览器所在时区的本地时间，精确到分钟；接口要 ISO 8601 的 UTC。
// 接口只接受四位数、不为 0 的年份（PostgreSQL 没有 0 年，审查 A4；五位数的年份 toISOString 写成 +010000，格式也不对）：
// 换算出来不是这样的时刻就不发出去，由页面标成无效（审查 B8）。

const MINUTE_MS = 60_000
const QUERY_INSTANT = /^(?!0000)\d{4}-/

/** 接口接受的 UTC 时刻；无效或者年份超出 1–9999 时 undefined */
function queryInstant(instant: Date): string | undefined {
  if (Number.isNaN(instant.getTime()))
    return undefined
  const iso = instant.toISOString()
  return QUERY_INSTANT.test(iso) ? iso : undefined
}

/** 开始时间（接口的 from 含这一刻）；没填或无效时 undefined */
export function auditTimeFrom(local: string): string | undefined {
  return local === '' ? undefined : queryInstant(new Date(local))
}

/**
 * 结束时间：界面按分钟选，含这一分钟（选 10:30 要包括 10:30:xx 的事件）；接口的 to 不含，所以取下一分钟的开始。
 * 按本地时间取整到分钟：历史上有的时区偏移带秒，本地的整分不一定是 UTC 的整分。没填或无效时 undefined
 */
export function auditTimeTo(local: string): string | undefined {
  if (local === '')
    return undefined
  const minute = new Date(local)
  minute.setSeconds(0, 0)
  return queryInstant(new Date(minute.getTime() + MINUTE_MS))
}
