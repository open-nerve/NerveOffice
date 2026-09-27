// HTML 与 SVG 共用：一个属性的值里、一个样式元素里可能是地址的值（复验 SA2、SA4、TA6）。
import type { LocatedValues } from './addresses.ts'
import { cssValues } from './css-values.ts'

/** HTML 的空白（ASCII whitespace） */
const WHITESPACE = /[\t\n\f\r ]/

/**
 * meta refresh 的地址（HTML 规范的"共享的声明式刷新步骤"）：跳过空白与时间，再跳过空白与一个分号或逗号，可以有 url=，
 * 引号里的或剩下的就是地址。任何 content 属性都按这个规则看一遍（不是 refresh 时取出的值不像地址，不会报出）
 */
function refreshUrl(content: string): string {
  let position = 0
  const skip = (pattern: RegExp): void => {
    while (position < content.length && pattern.test(content.charAt(position)))
      position += 1
  }
  skip(WHITESPACE)
  skip(/[\d.]/)
  skip(WHITESPACE)
  if (content.charAt(position) === ';' || content.charAt(position) === ',')
    position += 1
  skip(WHITESPACE)
  if (content.slice(position, position + 3).toLowerCase() === 'url') {
    const before = position
    position += 3
    skip(WHITESPACE)
    if (content.charAt(position) === '=') {
      position += 1
      skip(WHITESPACE)
    }
    else {
      position = before
    }
  }
  const rest = content.slice(position)
  const quote = rest[0]
  if (quote !== '"' && quote !== '\'')
    return rest
  const end = rest.indexOf(quote, 1)
  return end < 0 ? rest.slice(1) : rest.slice(1, end)
}

/**
 * 一个属性的值里可能是地址的部分：整个值、按空白、逗号与分号切开的每一段（srcset、ping、SMIL 的 values 等，复验 TA6）、
 * 样式里的值（style 与 SVG 的呈现属性）、meta refresh 的地址
 */
export function attributeValues(name: string, value: string): string[] {
  const values = [value, ...value.split(/[\t\n\f\r ,;]+/).filter(part => part !== '' && part !== value)]
  if (value.includes('(') || value.includes('"') || value.includes('\''))
    values.push(...cssValues(value).map(item => item.value))
  if (name === 'content')
    values.push(refreshUrl(value))
  return values
}

/**
 * 样式元素里的值：直接的文字子节点连起来当作样式（SVG 的 <style> 可以被注释或子元素拆成几段，浏览器连起来，复验 TA6）。
 * offset 是文字在原文里的开头，只在文字与原文逐字对应时给出（HTML 的 style 元素：一段原始文本，没有解码、没有统一换行），
 * 这时每个值记在各自的范围上；否则都记在整个元素的范围 span 上
 */
export function styleValues(texts: readonly string[], span: { readonly index: number, readonly end: number }, offset?: number): LocatedValues[] {
  const values = cssValues(texts.join(''))
  if (offset !== undefined)
    return values.map(item => ({ values: [item.value], index: offset + item.index, end: offset + item.end }))
  return values.map(item => ({ values: [item.value], index: span.index, end: span.end }))
}
