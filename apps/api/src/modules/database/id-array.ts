import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * `列 = ANY($n::uuid[])`：一串 id 作为**一个**数组参数交给数据库（M2-P6 复核 A 的 S-2、B 的 G1）。
 *
 * 不用 drizzle 的 inArray：它把每个 id 展开成一个参数（`IN ($1, $2, …)`），而 PostgreSQL 一条语句最多 65535 个参数。
 * 子树里的文件夹与文档、连带的删除单元都没有数量上限，超过这个数时整条语句失败，而且每次都失败（定时清理也一直清不掉那一单）；
 * 语句的文本还随 id 的个数变化。这里不论多少个 id，语句里都只有一个参数。
 *
 * column 也可以是写好的 SQL：给别名过的表写条件时用（inArray 只会写出主表的列名）。
 * ids 为空时条件恒为假；调用方多半先判断空的情况，根本不发语句
 */
export function inIdArray(column: AnyPgColumn | SQL, ids: readonly string[]): SQL {
  return sql`${column} = ANY(${sql.param([...ids])}::uuid[])`
}
