import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * 按时间排序的 keyset 分页的"位置"：时间列换成 UTC 文本，保留微秒（shared/time-cursor.ts 的游标原样带着它）。
 * 比较时再转回 timestamptz：`(列, id) < (${位置}::timestamptz, ${id}::uuid)`。
 */
export function keysetPosition(column: AnyPgColumn): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}
