// SVG 文件里可能是地址的值（复验 TA6）：按 XML 解析（saxes），不按 HTML。SVG 作为文档加载（object、iframe）时浏览器用的是 XML 解析器：
// DTD 内部子集定义的实体会展开、xml-stylesheet 处理指令会加载样式表，这两样 HTML 解析器都不认；<svg> 里的 <img> 这类标签
// 在 HTML 里会跳出外来内容、之后的 <style> 变成原始文本，在 XML 里不会。
// 只支持不带 DTD、不带处理指令、格式正确、编码是 UTF-8 的 SVG：其余写法门禁无法确定会请求什么，直接报出（fail closed）。
// 属性取展开实体与字符引用之后的值，srcdoc（XHTML 的 iframe）另按 HTML 解析（复验 UA1）；样式元素（任何命名空间的 style）取直接的文字与 CDATA 子节点连起来。
// saxes 给出的位置是事件发生时读到的地方：属性记在所在开始标签的范围上，样式记在整个元素的范围上。
import type { ExtractedValues, LocatedValues, MarkupProblem } from './addresses.ts'
import { SaxesParser } from 'saxes'
import { htmlValues } from './html-values.ts'
import { attributeValues, styleValues } from './markup-values.ts'

/** 打开着的元素：开头的位置；样式元素另记下直接的文字子节点 */
interface OpenElement {
  readonly index: number
  readonly texts: string[] | undefined
}

function isStyle(name: string): boolean {
  return name.slice(name.indexOf(':') + 1) === 'style'
}

export function svgValues(svg: string): ExtractedValues {
  const groups: LocatedValues[] = []
  const problems: MarkupProblem[] = []
  // 开头的 BOM 不属于内容，位置按原文补回
  const shift = svg.startsWith('\uFEFF') ? 1 : 0
  // 不处理命名空间：属性按原文的名字（xlink:href）取值；未声明的前缀浏览器报错，门禁照样取值（只会多报）
  const parser = new SaxesParser({ xmlns: false, position: true })
  const position = (): number => parser.position + shift
  const open: OpenElement[] = []
  let tagStart = 0
  let malformed = false
  const problem = (detail: string): void => {
    problems.push({ detail, index: Math.min(svg.length, position()) })
  }
  // 发 SVG 时 Content-Type 不带 charset，浏览器按 XML 声明里的编码解码；门禁按 UTF-8 读（复验 UA5）
  parser.on('xmldecl', ({ encoding }) => {
    if (encoding !== undefined && !/^utf-?8$/i.test(encoding))
      problem(`SVG 的 XML 声明写的编码是 ${encoding}：浏览器按它解码，门禁按 UTF-8 读，无法确定会请求什么；改用 UTF-8`)
  })
  parser.on('doctype', () => problem('SVG 里有 DOCTYPE：浏览器按 XML 加载时会展开其中定义的实体，门禁不展开，无法确定会请求什么；去掉 DOCTYPE'))
  parser.on('processinginstruction', ({ target }) => problem(`SVG 里有处理指令 <?${target} …?>（例如 xml-stylesheet 会加载样式表）：门禁不支持，去掉它`))
  // 格式错误之后的内容浏览器不再解析；只报第一处，之后的错误多半是它引起的
  parser.on('error', (error) => {
    if (!malformed)
      problem(`SVG 不是格式正确的 XML（${error.message}）：门禁无法确定浏览器会解析到哪里、请求什么`)
    malformed = true
  })
  // 事件发生时刚读完标签名与其后的一个字符（空白、> 或 /）
  parser.on('opentagstart', (tag) => {
    tagStart = Math.max(0, position() - tag.name.length - 2)
  })
  parser.on('opentag', (tag) => {
    const span = { index: tagStart, end: position() }
    for (const [name, value] of Object.entries(tag.attributes)) {
      groups.push({ values: attributeValues(name, value), ...span })
      // XHTML 的 iframe 的 srcdoc 是另一份 HTML，浏览器按 HTML 解析并加载其中的资源（复验 UA1）
      if (name === 'srcdoc') {
        const nested = htmlValues(value)
        for (const group of nested.groups)
          groups.push({ values: group.values, ...span })
        for (const item of nested.problems)
          problems.push({ detail: item.detail, index: span.index })
      }
    }
    open.push({ index: tagStart, texts: isStyle(tag.name) ? [] : undefined })
  })
  parser.on('text', text => open.at(-1)?.texts?.push(text))
  parser.on('cdata', data => open.at(-1)?.texts?.push(data))
  parser.on('closetag', () => {
    const element = open.pop()
    // 逐个加入：一段样式里的值可能有几十万个，展开成参数会超出调用栈（复验 UA6）
    if (element?.texts !== undefined) {
      for (const group of styleValues(element.texts, { index: element.index, end: position() }))
        groups.push(group)
    }
  })
  parser.write(svg.slice(shift)).close()
  return { groups, problems }
}
