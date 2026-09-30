// 表定义共用的写法（不是一个模块，只有表定义引用它）。
import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { Buffer } from 'node:buffer'
import { sql } from 'drizzle-orm'
import { customType } from 'drizzle-orm/pg-core'

/** bytea：drizzle 0.45 没有内置这个列类型。pg 驱动读出来就是 Buffer，写入时直接传 Buffer。 */
export const bytea = customType<{ data: Buffer, driverData: Buffer }>({
  dataType: () => 'bytea',
  fromDriver: value => Buffer.from(value),
})

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

/** 码点的闭区间：[第一个, 最后一个] */
export type CodePointRange = readonly [number, number]

/** 正则（PostgreSQL 的 ARE）里的一个码点：\uXXXX 或 \UXXXXXXXX 转义，看不见的字符不直接出现在 SQL 里 */
function escapedCodePoint(codePoint: number): string {
  const hex = codePoint.toString(16).toUpperCase()
  return codePoint > 0xFFFF ? `\\U${hex.padStart(8, '0')}` : `\\u${hex.padStart(4, '0')}`
}

/** 这些区间组成的方括号表达式（PostgreSQL 的 ARE），例如 [\u0009-\u000D ] */
export function bracketExpressionOf(ranges: readonly CodePointRange[]): string {
  const items = ranges.map(([first, last]) => first === last ? escapedCodePoint(first) : `${escapedCodePoint(first)}-${escapedCodePoint(last)}`)
  return `[${items.join('')}]`
}

/**
 * 每一段空白（blanks 里的字符，一个或连续几个）合成一个普通空格，不去首尾。blanks 是 contracts 的 NAME_BLANK_CHARACTERS：
 * 判重键（nameKeyOf 的第 3 步）与按名称搜索时库里的名称（各表定义转出的"空白合一的名称"，M2-P6 复验 G1）用这一份清单，
 * 搜索的关键词在应用里按同一份清单归一（contracts 的 collapseNameBlanks）
 */
export function blanksCollapsedOf(value: AnyPgColumn | SQL, blanks: readonly CodePointRange[]): SQL {
  return sql`regexp_replace(${value}, ${stringLiteral(`${bracketExpressionOf(blanks)}+`)}, ' ', 'g')`
}

/** 判重键里另外要处理的两类字符（都来自 contracts，与名称的规则用同一份清单） */
export interface NameKeyCharacters {
  /** 判重时不算区别、直接去掉的字符：名称里放行的格式字符（contracts 的 NAME_KEY_IGNORED_CHARACTERS） */
  readonly ignored: readonly CodePointRange[]
  /**
   * 判重时算作空白、每一段合成一个空格的字符：White_Space 与显示成空白的非格式字符（contracts 的 NAME_BLANK_CHARACTERS；
   * 后者入口已经拒绝，入口拒绝之前写进去的名称里可能有它们，M2-P6 复验 R-M1）
   */
  readonly blanks: readonly CodePointRange[]
}

/**
 * 名称的判重键（M2-P6 复核 B 的 M-1）：看起来一样的两个名称算出同一个键。只有这一处算法，由数据库算
 * （生成列，表达式里的函数都是 IMMUTABLE：normalize、regexp_replace、btrim、lower、casefold），唯一索引建在它上面：
 * 1. NFKC：全角与半角、兼容写法（连字、上标、带圈数字等）归成一样，各种宽度的空格变成普通空格，
 *    带空格的声调符号（´、¨ 等）展开成"空格 + 组合符号"——在合并空白之前做，展开出来的空格才会一起合并；
 * 2. 去掉名称里放行的格式字符（ignored：零宽连接符与不连字、组合用字形连接符、蒙古文的变体选择符与元音分隔符、
 *    变体选择符、标签字符），它们看不见；
 * 3. 每一段空白（blanks：White_Space 与显示成空白的非格式字符——盲文空白、契丹小字填充符、乐谱的空符头，M2-P6 复验 R-M1）
 *    合成一个普通空格（blanksCollapsedOf），再去掉首尾的空格（名称开头夹一个零宽连接符再跟空格时，去掉前者之后会露出后者）。
 *    名称的入口已经拒绝后者，这里照样当空白：入口拒绝之前写进去的名称里可能有它们；
 * 4. 大小写：先 lower（简单的小写映射，与原来按 lower 判重的结果一致，例如 İ 与 i），再 casefold（大小写折叠，
 *    统一 lower 统一不了的，例如希腊字母词尾的 ς 与 σ；PostgreSQL 18 起）；
 * 5. 再做一次 NFKC：去掉格式字符之后，原来被它隔开的字母与组合符号能重新合成（e、CGJ、组合重音符与 é），
 *    大小写折叠的结果也不一定是归一的。
 * 数据库的排序规则是内置的 C.UTF-8：大小写与归一按数据库自带的 Unicode 表，与操作系统无关
 */
export function nameKeyOf(column: AnyPgColumn, characters: NameKeyCharacters): SQL {
  const stripped = sql`regexp_replace(normalize(${column}, NFKC), ${stringLiteral(bracketExpressionOf(characters.ignored))}, '', 'g')`
  const spaced = sql`btrim(${blanksCollapsedOf(stripped, characters.blanks)}, ' ')`
  return sql`normalize(casefold(lower(${spaced})), NFKC)`
}
