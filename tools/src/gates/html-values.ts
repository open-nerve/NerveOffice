// HTML 与 SVG 里可能是地址的值（复验 SA2、SA4）：用 parse5 按 HTML 规范解析（字符引用按完整的表解码，属性按规范切分），
// 取出每个属性的值与 style 元素里的样式。位置是整个属性或文本在原文里的位置。原来按正则切属性、只解码一部分字符引用，
// 文字里的 x=" 会让后面的属性被吞掉（复验 SA2），前导零很多的数字引用、&lsqb; 这类命名引用解不出来（复验 SA4）。
import type { DefaultTreeAdapterMap } from 'parse5'
import type { LocatedValue } from './addresses.ts'
import { parse } from 'parse5'
import { cssValues } from './css-values.ts'

type ParentNode = DefaultTreeAdapterMap['parentNode']

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

/** 一个属性的值里可能是地址的部分：整个值、按空白与逗号切开的每一段（srcset、ping 等）、样式里的值（style 与 SVG 的呈现属性）、meta refresh 的地址 */
function attributeValues(name: string, value: string): string[] {
  const values = [value, ...value.split(/[\t\n\f\r ,]+/).filter(part => part !== '' && part !== value)]
  if (value.includes('(') || value.includes('"') || value.includes('\''))
    values.push(...cssValues(value).map(item => item.value))
  if (name === 'content')
    values.push(refreshUrl(value))
  return values
}

function collect(node: ParentNode, values: LocatedValue[]): void {
  for (const element of node.childNodes) {
    if (!('tagName' in element))
      continue
    for (const attribute of element.attrs) {
      const location = element.sourceCodeLocation?.attrs?.[attribute.name]
      const span = { index: location?.startOffset ?? 0, end: location?.endOffset ?? 0 }
      for (const value of attributeValues(attribute.name, attribute.value))
        values.push({ value, ...span })
      // iframe 的 srcdoc 是另一份 HTML
      if (attribute.name === 'srcdoc')
        values.push(...htmlValues(attribute.value).map(item => ({ value: item.value, ...span })))
    }
    if (element.tagName === 'style') {
      for (const text of element.childNodes) {
        if (text.nodeName === '#text' && 'value' in text) {
          const offset = text.sourceCodeLocation?.startOffset ?? 0
          values.push(...cssValues(text.value).map(item => ({ value: item.value, index: offset + item.index, end: offset + item.end })))
        }
      }
    }
    collect(element, values)
    if (element.tagName === 'template' && 'content' in element)
      collect(element.content, values)
  }
}

export function htmlValues(html: string): LocatedValue[] {
  const values: LocatedValue[] = []
  collect(parse(html, { sourceCodeLocationInfo: true }), values)
  return values
}
