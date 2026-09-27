// 文本规则的共用部分：各处的名称、标题与密码按同一个口径计长度、查控制字符。

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
