// 文本规则的共用部分：各处的名称、标题与密码按同一个口径计长度、查控制字符；
// 名称（显示名、团队空间名称、文件夹名称）与标题另按同一套规则查"看起来与实际不同"的字符（M2-P6 复核 B2）。
import { z } from 'zod'

/** 按码点计的长度：与 PostgreSQL 的 char_length 一致（JavaScript 的 length 按 UTF-16 计，表情符号算两个）。 */
export function codePointLength(value: string): number {
  return [...value].length
}

// eslint-disable-next-line no-control-regex -- 名称、标题与密码里不允许控制字符，要匹配的正是它们
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/

/** 含有 C0、C1 控制字符（包括换行、制表符与 DEL）。 */
export function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value)
}

/**
 * 双向控制字符：阿拉伯字母标记、从左到右与从右到左标记、嵌入与覆盖（LRE、RLE、PDF、LRO、RLO）、隔离（LRI、RLI、FSI、PDI）。
 * 它们改变后面文字的显示方向，能让名字看起来与实际存的不同（例如把一段字倒过来显示），审计与成员列表按名字认人时就不可靠了。
 * 正常的阿拉伯文、希伯来文不需要它们：文字自己的方向由字符本身决定。
 */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/

/** 含有双向控制字符（BIDI_CONTROLS）。 */
export function hasBidiControls(value: string): boolean {
  return BIDI_CONTROLS.test(value)
}

/** 行分隔符与段分隔符（U+2028、U+2029）：在只有一行的名字、标题里断行。 */
const LINE_SEPARATORS = /[\u2028\u2029]/

/** 含有行分隔符或段分隔符。 */
export function hasLineSeparators(value: string): boolean {
  return LINE_SEPARATORS.test(value)
}

/**
 * 看不见的字符：空白（White_Space）、默认可忽略的字符（Default_Ignorable_Code_Point：零宽空格与零宽连接符、
 * 词连接符、BOM、变体选择符、韩文填充符 U+3164 等、蒙古文元音分隔符），以及盲文空白 U+2800（显示成空白的常见替身）。
 * 零宽连接符、零宽不连字与变体选择符在表情组合与一些文字里是必需的，所以这里只用来判断"去掉之后还剩不剩"，不拒绝它们出现。
 */
const INVISIBLE = /[\p{White_Space}\p{Default_Ignorable_Code_Point}\u2800]/gu

/** 去掉看不见的字符（INVISIBLE）之后还有字：整个名字不能只由空白、零宽字符、填充符组成。 */
export function hasVisibleCharacters(value: string): boolean {
  return value.replace(INVISIBLE, '') !== ''
}

export interface TextRuleOptions {
  /** 说明里的叫法，例如"显示名""名称""标题" */
  readonly label: string
  readonly maxLength: number
}

/**
 * 名称（显示名、团队空间名称、文件夹名称）：先 NFC 归一（同一个字的组合写法与预组写法存成一样），去掉首尾空白之后
 * 1–maxLength 个字符（按码点）；不含控制字符、双向控制字符、行与段分隔符；去掉看不见的字符之后仍然有字。
 */
export function nameTextSchema({ label, maxLength }: TextRuleOptions) {
  return z.string()
    .trim()
    .transform(value => value.normalize('NFC'))
    .refine(value => codePointLength(value) >= 1 && codePointLength(value) <= maxLength, `${label}为 1–${maxLength} 个字符`)
    .refine(value => !hasControlCharacters(value), `${label}不能包含控制字符`)
    .refine(value => !hasBidiControls(value), `${label}不能包含改变文字方向的控制字符`)
    .refine(value => !hasLineSeparators(value), `${label}不能包含换行符`)
    .refine(value => hasVisibleCharacters(value), `${label}不能只有空白或看不见的字符`)
}

/**
 * 文档标题：标题是用户的内容，规则比名称宽——不做 NFC 归一，原样保存；只拒绝控制字符、双向控制字符与行、段分隔符，
 * 并要求去掉看不见的字符之后仍然有字（整个标题是零宽字符时，列表里就是一行空白）。
 */
export function titleTextSchema({ label, maxLength }: TextRuleOptions) {
  return z.string()
    .trim()
    .refine(value => codePointLength(value) >= 1 && codePointLength(value) <= maxLength, `${label}为 1–${maxLength} 个字符`)
    .refine(value => !hasControlCharacters(value), `${label}不能包含控制字符`)
    .refine(value => !hasBidiControls(value), `${label}不能包含改变文字方向的控制字符`)
    .refine(value => !hasLineSeparators(value), `${label}不能包含换行符`)
    .refine(value => hasVisibleCharacters(value), `${label}不能只有空白或看不见的字符`)
}
