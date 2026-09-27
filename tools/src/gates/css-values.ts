// 样式里可能是地址的值（复验 SA2、SA4）：按 CSS Syntax Level 3 的分词规则取出字符串与 url 的值（已还原转义），以及它们在原文里的位置。
// 只实现与地址有关的部分：注释、字符串（含转义与续行）、名字（含转义，u\72l( 也是 url）与 url(…)；其余字符逐个跳过。
// 原来按正则切：带引号的 url() 里有右括号、转义的引号或注释让引号配错对时会切错（复验 SA2）
import type { LocatedValue } from './addresses.ts'

function isNewline(char: string | undefined): boolean {
  return char === '\n' || char === '\r' || char === '\f'
}

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || isNewline(char)
}

function isHexDigit(char: string | undefined): boolean {
  return char !== undefined && /^[\da-f]$/i.test(char)
}

function isIdentStart(char: string | undefined): boolean {
  return char !== undefined && (/^[a-z_]$/i.test(char) || char.charCodeAt(0) >= 0x80)
}

function isIdentChar(char: string | undefined): boolean {
  return isIdentStart(char) || (char !== undefined && /^[\d-]$/.test(char))
}

function isNonPrintable(char: string | undefined): boolean {
  if (char === undefined)
    return false
  const code = char.charCodeAt(0)
  return code <= 0x08 || code === 0x0B || (code >= 0x0E && code <= 0x1F) || code === 0x7F
}

function codePoint(code: number): string {
  return code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF) ? '\uFFFD' : String.fromCodePoint(code)
}

/** 从 css[start] 开始的一个 CSS 分词的状态机 */
class CssReader {
  position = 0
  private readonly css: string
  constructor(css: string) {
    this.css = css
  }

  at(offset = 0): string | undefined {
    return this.css[this.position + offset]
  }

  /** 两个字符是合法的转义：反斜杠后面不是换行 */
  validEscape(offset = 0): boolean {
    return this.at(offset) === '\\' && !isNewline(this.at(offset + 1)) && this.at(offset + 1) !== undefined
  }

  /** 从当前位置开始是一个名字（ident）：字母、下划线、非 ASCII、转义，或者以连字符开头的这些 */
  startsIdent(offset = 0): boolean {
    const first = this.at(offset)
    if (first === '-')
      return isIdentStart(this.at(offset + 1)) || this.at(offset + 1) === '-' || this.validEscape(offset + 1)
    return isIdentStart(first) || this.validEscape(offset)
  }

  /** 反斜杠之后的转义：最多 6 位十六进制（后面可以跟一个空白），或者单个字符 */
  escaped(): string {
    this.position += 1
    const first = this.at()
    if (first === undefined)
      return '\uFFFD'
    if (isHexDigit(first)) {
      let hex = ''
      while (hex.length < 6 && isHexDigit(this.at())) {
        hex += this.at()
        this.position += 1
      }
      if (this.at() === '\r' && this.at(1) === '\n')
        this.position += 2
      else if (isWhitespace(this.at()))
        this.position += 1
      return codePoint(Number.parseInt(hex, 16))
    }
    this.position += 1
    return first
  }

  name(): string {
    let result = ''
    for (;;) {
      const char = this.at()
      if (isIdentChar(char)) {
        result += char
        this.position += 1
      }
      else if (this.validEscape()) {
        result += this.escaped()
      }
      else {
        return result
      }
    }
  }

  /** 引号里的字符串（当前位置是开头的引号）；遇到换行即结束（坏的字符串，照样取出已读到的部分） */
  string(): string {
    const quote = this.at()
    this.position += 1
    let result = ''
    for (;;) {
      const char = this.at()
      if (char === undefined || char === quote) {
        if (char === quote)
          this.position += 1
        return result
      }
      if (isNewline(char))
        return result
      if (char === '\\') {
        const next = this.at(1)
        if (next === undefined) {
          this.position += 1
        }
        else if (isNewline(next)) {
          // 续行：反斜杠加换行不算内容
          this.position += next === '\r' && this.at(2) === '\n' ? 3 : 2
        }
        else {
          result += this.escaped()
        }
        continue
      }
      result += char
      this.position += 1
    }
  }

  skipWhitespace(): void {
    while (isWhitespace(this.at()))
      this.position += 1
  }

  /** url( 之后、不带引号的地址（当前位置在左括号之后的空白之后）；坏的 url 返回 undefined */
  url(): string | undefined {
    let result = ''
    for (;;) {
      const char = this.at()
      if (char === undefined)
        return result
      if (char === ')') {
        this.position += 1
        return result
      }
      if (isWhitespace(char)) {
        this.skipWhitespace()
        if (this.at() === ')' || this.at() === undefined) {
          if (this.at() === ')')
            this.position += 1
          return result
        }
        this.skipBadUrl()
        return undefined
      }
      if (char === '"' || char === '\'' || char === '(' || isNonPrintable(char)) {
        this.skipBadUrl()
        return undefined
      }
      if (char === '\\') {
        if (!this.validEscape()) {
          this.skipBadUrl()
          return undefined
        }
        result += this.escaped()
        continue
      }
      result += char
      this.position += 1
    }
  }

  skipBadUrl(): void {
    for (;;) {
      const char = this.at()
      if (char === undefined)
        return
      this.position += 1
      if (char === ')')
        return
      if (char === '\\' && this.at() !== undefined && !isNewline(this.at()))
        this.escaped()
    }
  }
}

/**
 * 样式里可能是地址的值：字符串与 url(…)（含 u\72l( 这样转义出来的 url）。
 * 带引号的 url("…") 按规范是 url 函数加一个字符串，取出的是字符串
 */
export function cssValues(css: string): LocatedValue[] {
  const values: LocatedValue[] = []
  const reader = new CssReader(css)
  while (reader.at() !== undefined) {
    const start = reader.position
    const char = reader.at()
    if (char === '/' && reader.at(1) === '*') {
      const close = css.indexOf('*/', start + 2)
      reader.position = close < 0 ? css.length : close + 2
    }
    else if (char === '"' || char === '\'') {
      const value = reader.string()
      values.push({ value, index: start, end: reader.position })
    }
    else if (reader.startsIdent()) {
      const name = reader.name()
      if (reader.at() === '(' && name.toLowerCase() === 'url') {
        reader.position += 1
        reader.skipWhitespace()
        if (reader.at() !== '"' && reader.at() !== '\'') {
          const value = reader.url()
          if (value !== undefined)
            values.push({ value, index: start, end: reader.position })
        }
      }
    }
    else {
      reader.position += 1
    }
  }
  return values
}
