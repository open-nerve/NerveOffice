// 表定义共用的写法（不是一个模块，只有表定义引用它）。
import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/** 代码里的常量写成 SQL 字符串字面量（单引号加倍）。只用于表定义：这里只有 DDL 与常量，没有运行时的输入。 */
export function stringLiteral(value: string): SQL {
  return sql.raw(`'${value.replaceAll('\'', '\'\'')}'`)
}

/**
 * 枚举用 text 加 CHECK 约束（规范 §5）。取值是代码里的常量，拼成 SQL 字面量：
 * drizzle-kit 不会把参数内联进 CHECK（inArray 生成的是 $1、$2，无法执行）。
 */
export function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.join(values.map(stringLiteral), sql`, `)})`
}

/** 按码点计的长度范围（PostgreSQL 的 char_length），与 contracts 的规则一致。 */
export function lengthBetween(column: AnyPgColumn, min: number, max: number): SQL {
  return sql`char_length(${column}) BETWEEN ${sql.raw(String(min))} AND ${sql.raw(String(max))}`
}
