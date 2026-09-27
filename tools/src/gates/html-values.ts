// HTML 里可能是地址的值（复验 SA2、SA4、TA1、TA2、TA6、TA9）：用 parse5 按 HTML 规范解析（字符引用按完整的表解码，属性按规范切分）。
// 属性取自分词器给出的每个开始标签，而不是解析出的树（复验 TA2）：树构建会丢掉一些开始标签（parse5 仍按旧的规则解析 <select>，
// 丢掉里面的 <img>、<div>，浏览器已改用新的规则保留它们），重复的 <html>、<body> 的属性会并到第一个上。
// 分词的状态由树构建决定：原始文本一类的元素（style、script、textarea 等）与 svg、math 的开始标签被 parse5 丢掉时，
// 浏览器可能保留它，把之后的内容按另一种状态分词，门禁无法确定会请求什么，直接报出（fail closed）。
// style 元素的样式取自树：直接的文字子节点连起来（markup-values.ts）。位置是属性或样式在原文里的位置。
// 截取开始标签用的 Parser 在 parse5 里标着 @internal：parse5 的版本精确锁定，这里依赖的行为由单测锁住，升级时核对。
import type { DefaultTreeAdapterMap, Token } from 'parse5'
import type { ExtractedValues, LocatedValues, MarkupProblem } from './addresses.ts'
import { Parser } from 'parse5'
import { attributeValues, styleValues } from './markup-values.ts'

type ParentNode = DefaultTreeAdapterMap['parentNode']
type Element = DefaultTreeAdapterMap['element']

interface Span {
  readonly index: number
  readonly end: number
}

interface StartTag {
  readonly tagName: string
  readonly index: number
  readonly attributes: readonly (Span & { readonly name: string, readonly value: string })[]
}

/** 开始标签之后的内容按另一种状态分词的元素：原始文本、RCDATA、脚本、纯文本，以及外来内容的根（其中 CDATA 生效、style 等不再是原始文本） */
const STATE_SWITCHING: ReadonlySet<string> = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'title', 'textarea', 'plaintext', 'svg', 'math'])

/** 在树构建处理之前记下每个开始标签：树构建会就地调整属性的名字（SVG 的大小写、xlink:href 的前缀），位置按原文的名字查（复验 TA1） */
class StartTagRecorder extends Parser<DefaultTreeAdapterMap> {
  readonly startTags: StartTag[] = []

  override onStartTag(token: Token.TagToken): void {
    const index = token.location?.startOffset ?? 0
    const locations = token.location?.attrs
    this.startTags.push({
      tagName: token.tagName,
      index,
      attributes: token.attrs.map(({ name, value }) => ({ name, value, index: locations?.[name]?.startOffset ?? index, end: locations?.[name]?.endOffset ?? index })),
    })
    super.onStartTag(token)
  }
}

/** 树里的全部元素（含 template 的内容）：逐层展开，不递归（嵌套很深时不会栈溢出，复验 TA9） */
function elementsOf(document: ParentNode): Element[] {
  const elements: Element[] = []
  const pending: ParentNode[] = [document]
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const child of node.childNodes) {
      if (!('tagName' in child))
        continue
      elements.push(child)
      pending.push(child)
      if (child.tagName === 'template' && 'content' in child)
        pending.push(child.content)
    }
  }
  return elements
}

/** style 元素的样式：HTML 的 style 只有一段原始文本，文字与原文逐字对应时值的位置精确到各自的范围 */
function styleOf(element: Element): LocatedValues[] {
  const texts = element.childNodes.filter(child => child.nodeName === '#text' && 'value' in child)
  const location = element.sourceCodeLocation
  const span = { index: location?.startOffset ?? 0, end: location?.endOffset ?? 0 }
  const only = texts.length === 1 ? texts[0]?.sourceCodeLocation : undefined
  const exact = only !== undefined && only !== null && only.endOffset - only.startOffset === texts[0]?.value.length
  return styleValues(texts.map(text => text.value), span, exact ? only.startOffset : undefined)
}

export function htmlValues(html: string): ExtractedValues {
  const groups: LocatedValues[] = []
  const problems: MarkupProblem[] = []
  // iframe 的 srcdoc 是另一份 HTML：排在后面逐份处理（不递归，复验 TA9），其中的值与问题都记在 srcdoc 属性的位置上
  const documents: { readonly html: string, readonly at?: Span }[] = [{ html }]
  for (let item = documents.pop(); item !== undefined; item = documents.pop()) {
    const { at } = item
    const parser = new StartTagRecorder({ sourceCodeLocationInfo: true })
    parser.tokenizer.write(item.html, true)
    const elements = elementsOf(parser.document)
    const inserted = new Set(elements.map(element => element.sourceCodeLocation?.startTag?.startOffset))
    for (const tag of parser.startTags) {
      if (STATE_SWITCHING.has(tag.tagName) && !inserted.has(tag.index)) {
        problems.push({
          detail: `<${tag.tagName}> 的开始标签被 parse5 的树构建丢掉了（例如写在 <select> 里）：浏览器可能保留它，把之后的内容按另一种状态分词，门禁无法确定会请求什么`,
          index: at?.index ?? tag.index,
        })
      }
      for (const attribute of tag.attributes) {
        const span = at ?? attribute
        groups.push({ values: attributeValues(attribute.name, attribute.value), index: span.index, end: span.end })
        if (attribute.name === 'srcdoc')
          documents.push({ html: attribute.value, at: span })
      }
    }
    for (const element of elements) {
      if (element.tagName === 'style')
        groups.push(...styleOf(element).map(group => at === undefined ? group : { values: group.values, index: at.index, end: at.end }))
    }
  }
  return { groups, problems }
}
