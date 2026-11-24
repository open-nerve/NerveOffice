// 文字文档（doc@1）的服务端规则（M6-P1 S3、S4 spec §3，00 号计划书 §11.2，M6 总设计 §6.2）：纯函数、不抛出，遍历一律迭代。
// - 结构（docStructure）：顶层是对象、id、body 与 dataStream，正文里几个列表与顶层几项对象的种类；
// - 结构之后、资源之前（checkDocContent，按这个先后，第一条不满足的就是结果）：版式只收 MODERN；页眉页脚、脚注尾注为空；
//   表格之外至多文末一个分节符；没有目录块的区间；
// - 链接（checkDocLinks）：正文的 customRanges 逐个区间按 contracts 的 checkLinkRange，位置是区间起点所在的段落。页眉页脚与脚注尾注
//   已要求为空，只看正文；
// - 资源与正文的交叉核对（checkDocResources，规则 resource-mismatch）：SDK 加载时链接资源覆盖正文的地址、图片资源覆盖正文的图片，
//   不核对的话，伪造的资源能绕过正文的检查。
// 图片地址的位置在 snapshot-image-locations.ts（docImageLocations）。原则同 M3：只拒绝有证据会出问题的内容，没有证据的结构不判
import type { CellLinkRule, RuleCheck, SnapshotLinkLocation } from '@nerve-office/contracts'
import type { CheckedStructure, EmbeddedJson, ProfileContentRule } from './snapshot-checks.ts'
import type { SnapshotLinkCheck } from './snapshot-link-check.ts'
import { checkLinkRange, HYPERLINK_RANGE_TYPE, isDeepEmpty, SNAPSHOT_LINK_LOCATION_LIMIT } from '@nerve-office/contracts'

/** Univer 的 DocumentFlavor.MODERN（无分页的版式）：doc@1 只收这一种 */
const MODERN_FLAVOR = 2
/** Univer 的 CustomRangeType.FIELD */
const FIELD_RANGE_TYPE = 1
/** 目录块写下的字段（docs-toc 的 table-of-contents.command.ts）：外层的 TOC 与每一项页码的 PAGEREF */
const TOC_FIELD_TYPES: ReadonlySet<unknown> = new Set(['TOC', 'PAGEREF'])
/** 正文里在时必须是数组的列表：之后的规则要逐项读它们 */
const BODY_LISTS = ['paragraphs', 'sectionBreaks', 'tables', 'customRanges', 'customBlocks'] as const
/** 顶层在时必须是对象的几项 */
const DOCUMENT_OBJECTS = ['documentStyle', 'headers', 'footers', 'drawings'] as const
/**
 * Univer 的 DataStreamTreeTokenType 里表格开始与表格结束的控制符。SDK 写表格时（docs-ui 的 buildDocTableInsertBody），区间的起点是表格开始，
 * 终点是表格结束之后的那个段落结尾 \r
 */
const TABLE_START = '\x1A'
const TABLE_END = '\x0F'
/** 链接资源与图片资源的名称（插件档案 v1 §3） */
const LINKS_RESOURCE = 'DOC_HYPER_LINK_PLUGIN'
const DRAWINGS_RESOURCE = 'DOC_DRAWING_PLUGIN'

const PASS = { ok: true } as const
const DOCUMENT: SnapshotLinkLocation = { kind: 'document' }

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** dataStream 里的下标：非负整数 */
function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** 正文里的一个列表；不在时是空的（结构已要求在时是数组） */
function listOf(body: Readonly<Record<string, unknown>>, key: (typeof BODY_LISTS)[number]): readonly unknown[] {
  const value = body[key]
  return Array.isArray(value) ? value as readonly unknown[] : []
}

/** 结构通过之后的正文（结构已要求它是对象） */
function bodyOf(checked: CheckedStructure): Readonly<Record<string, unknown>> {
  const body = checked.snapshot.body
  return record(body) ? body : {}
}

/**
 * 文字文档的结构（doc@1）：顶层是对象，id 是非空的字符串；body 是对象，body.dataStream 是字符串；body 的 paragraphs、sectionBreaks、tables、
 * customRanges、customBlocks 在时都是数组（null 也不行）；documentStyle、headers、footers、drawings 在时都是对象；drawingsOrder 在时是数组。
 * 用 M0 的 30 份文字文档样本核实过不会误拒
 */
export function docStructure(snapshot: unknown): CheckedStructure | undefined {
  if (!record(snapshot))
    return undefined
  const { id, body } = snapshot
  if (typeof id !== 'string' || id === '')
    return undefined
  if (!record(body) || typeof body.dataStream !== 'string')
    return undefined
  if (!BODY_LISTS.every(key => body[key] === undefined || Array.isArray(body[key])))
    return undefined
  if (!DOCUMENT_OBJECTS.every(key => snapshot[key] === undefined || record(snapshot[key])))
    return undefined
  if (snapshot.drawingsOrder !== undefined && !Array.isArray(snapshot.drawingsOrder))
    return undefined
  return { unitId: id, snapshot }
}

/**
 * 表格占据的区间（含两端）：写法对、而且两端落在 dataStream 的表格控制符上的表格（起点是表格开始，终点的前一位是表格结束），按起点排序之后
 * 合并成不相交、递增的区间（嵌套的表格取外层的终点）。只看 tables 的话，伪造一个区间就能把任意分节符算成表格里的（P1 审查 A 的 M-1）。
 * 这里只核对两端：两端都落在控制符上但不是一对的区间、正文里自造的一对控制符，以及 dataStream 里没有记录的分节符，P2 定稿 doc@1 时按控制符的
 * 完整结构判定（DEF-089）
 */
function tableIntervals(tables: readonly unknown[], dataStream: string): readonly (readonly [number, number])[] {
  const intervals: [number, number][] = []
  for (const table of tables) {
    if (record(table) && isIndex(table.startIndex) && isIndex(table.endIndex) && table.startIndex <= table.endIndex
      && dataStream[table.startIndex] === TABLE_START && dataStream[table.endIndex - 1] === TABLE_END) {
      intervals.push([table.startIndex, table.endIndex])
    }
  }
  intervals.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const [start, end] of intervals) {
    const last = merged.at(-1)
    if (last !== undefined && start <= last[1])
      last[1] = Math.max(last[1], end)
    else
      merged.push([start, end])
  }
  return merged
}

/** index 落在某个表格的区间里：二分找最后一个起点不大于 index 的区间 */
function insideTable(intervals: readonly (readonly [number, number])[], index: number): boolean {
  let low = 0
  let high = intervals.length - 1
  let candidate: readonly [number, number] | undefined
  while (low <= high) {
    const middle = (low + high) >>> 1
    const interval = intervals[middle]
    if (interval === undefined)
      break
    if (interval[0] <= index) {
      candidate = interval
      low = middle + 1
    }
    else {
      high = middle - 1
    }
  }
  return candidate !== undefined && index <= candidate[1]
}

/**
 * 表格之外的分节符至多一个，有的话在文末（startIndex 是 dataStream 的最后一个下标）。表格里每个单元格各有一个分节符，是正常结构。
 * 写法不对、不落在表格控制符上的表格不算；写法不对的分节符按表格之外算（它的位置不可能是文末）
 */
function sectionBreaksAllowed(body: Readonly<Record<string, unknown>>): boolean {
  const dataStream = typeof body.dataStream === 'string' ? body.dataStream : ''
  const end = dataStream.length - 1
  const intervals = tableIntervals(listOf(body, 'tables'), dataStream)
  let outside = 0
  let position: unknown
  for (const sectionBreak of listOf(body, 'sectionBreaks')) {
    const index = record(sectionBreak) ? sectionBreak.startIndex : undefined
    if (isIndex(index) && insideTable(intervals, index))
      continue
    outside += 1
    if (outside > 1)
      return false
    position = index
  }
  return outside === 0 || position === end
}

/** 有目录块的区间：FIELD 区间的 fieldType 是 TOC 或 PAGEREF */
function hasTableOfContents(body: Readonly<Record<string, unknown>>): boolean {
  return listOf(body, 'customRanges').some(range => record(range) && range.rangeType === FIELD_RANGE_TYPE
    && record(range.properties) && TOC_FIELD_TYPES.has(range.properties.fieldType))
}

/**
 * 结构之后、资源之前的五条（SNAPSHOT_RULES 的先后）：
 * - doc-flavor：documentStyle.documentFlavor 是 MODERN（缺少也拒绝）；
 * - doc-header-footer：headers、footers 不在或深层为空（documentStyle 里页眉页脚的 id 不单独判：样本里是空串）；
 * - doc-notes：notes、footnotes、endnotes 不在或深层为空。noteSettings 不判：它除了编号的设置，还能带分隔符等几段正文（Univer 的
 *   INoteSettings），这些正文只在有脚注尾注时排版，而脚注尾注已要求为空；P2 定稿 doc@1 时核实它们会不会显示（P1 审查 A 的 M-2，DEF-090）；
 * - doc-section-break：见 sectionBreaksAllowed；doc-toc：见 hasTableOfContents
 */
export function checkDocContent(checked: CheckedStructure): RuleCheck<ProfileContentRule> {
  const { snapshot } = checked
  const style = snapshot.documentStyle
  if (!record(style) || style.documentFlavor !== MODERN_FLAVOR)
    return { ok: false, rule: 'doc-flavor' }
  if (!isDeepEmpty(snapshot.headers) || !isDeepEmpty(snapshot.footers))
    return { ok: false, rule: 'doc-header-footer' }
  if (!isDeepEmpty(snapshot.notes) || !isDeepEmpty(snapshot.footnotes) || !isDeepEmpty(snapshot.endnotes))
    return { ok: false, rule: 'doc-notes' }
  const body = bodyOf(checked)
  if (!sectionBreaksAllowed(body))
    return { ok: false, rule: 'doc-section-break' }
  if (hasTableOfContents(body))
    return { ok: false, rule: 'doc-toc' }
  return PASS
}

/** 段落在文档里的先后：写法对的段落的 startIndex（段落结尾的 \r 的下标），升序 */
function paragraphEnds(paragraphs: readonly unknown[]): readonly number[] {
  const ends: number[] = []
  for (const paragraph of paragraphs) {
    if (record(paragraph) && isIndex(paragraph.startIndex))
      ends.push(paragraph.startIndex)
  }
  return ends.sort((a, b) => a - b)
}

/** 区间起点所在的段落（从 0 起）：第一个 startIndex 不小于起点的段落；起点看不懂或在最后一段之后时是“文档里别的位置” */
function paragraphLocation(ends: readonly number[], start: unknown): SnapshotLinkLocation {
  if (!isIndex(start))
    return DOCUMENT
  let low = 0
  let high = ends.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if ((ends[middle] ?? Number.POSITIVE_INFINITY) < start)
      low = middle + 1
    else
      high = middle
  }
  return low < ends.length ? { kind: 'paragraph', paragraph: low } : DOCUMENT
}

/**
 * 正文里的链接：逐个区间按 checkLinkRange，第一条不满足的规则是结果；额外收集同一规则的至多五个位置（去重），别的规则的区间不收
 * （与表格的 checkWorkbookLinks 同一个口径）
 */
export function checkDocLinks(checked: CheckedStructure): SnapshotLinkCheck {
  const body = bodyOf(checked)
  let rule: CellLinkRule | undefined
  let ends: readonly number[] | undefined
  const linkLocations: SnapshotLinkLocation[] = []
  const seen = new Set<string>()
  for (const range of listOf(body, 'customRanges')) {
    const check = checkLinkRange(range)
    if (check.ok)
      continue
    rule ??= check.rule
    if (check.rule !== rule)
      continue
    ends ??= paragraphEnds(listOf(body, 'paragraphs'))
    const location = paragraphLocation(ends, record(range) ? range.startIndex : undefined)
    const key = JSON.stringify(location)
    if (seen.has(key))
      continue
    seen.add(key)
    linkLocations.push(location)
    if (linkLocations.length === SNAPSHOT_LINK_LOCATION_LIMIT)
      return { ok: false, rule, linkLocations }
  }
  return rule === undefined ? PASS : { ok: false, rule, linkLocations }
}

/** 两个 JSON 值相等：对象不看键序，数组看顺序（迭代比较，栈随已受限的元素数增长） */
function sameJson(a: unknown, b: unknown): boolean {
  const pending: [unknown, unknown][] = [[a, b]]
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [left, right] = pair
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
        return false
      for (const [index, item] of (left as readonly unknown[]).entries())
        pending.push([item, (right as readonly unknown[])[index]])
      continue
    }
    if (record(left) || record(right)) {
      if (!record(left) || !record(right))
        return false
      const keys = Object.keys(left)
      if (keys.length !== Object.keys(right).length)
        return false
      for (const key of keys) {
        if (!Object.hasOwn(right, key))
          return false
        pending.push([left[key], right[key]])
      }
      continue
    }
    if (left !== right)
      return false
  }
  return true
}

/** 资源的取值：不在时 present 为假；data 是空串时是 empty（这类资源的空结构）；否则是解析出的值（解析不了时 undefined，比较一定不等） */
function resourceValue(snapshot: Readonly<Record<string, unknown>>, embedded: readonly EmbeddedJson[], name: string, empty: unknown): { readonly present: false } | { readonly present: true, readonly value: unknown } {
  const resources = snapshot.resources
  if (!Array.isArray(resources))
    return { present: false }
  for (const [resourceIndex, entry] of (resources as readonly unknown[]).entries()) {
    if (!record(entry) || entry.name !== name)
      continue
    if (entry.data === '')
      return { present: true, value: empty }
    return { present: true, value: embedded.find(item => item.resourceIndex === resourceIndex)?.value }
  }
  return { present: false }
}

/** 链接资源与正文一致：条数相同，逐项的 id 等于 rangeId、payload 等于地址（SDK 的 toJson 写 url || ''；只比这两个字段，加载时只读它们） */
function sameLinks(value: unknown, ranges: readonly unknown[]): boolean {
  const links = record(value) && Array.isArray(value.links) ? value.links as readonly unknown[] : undefined
  const expected = ranges.filter(range => record(range) && range.rangeType === HYPERLINK_RANGE_TYPE) as readonly Readonly<Record<string, unknown>>[]
  if (links === undefined || links.length !== expected.length)
    return false
  return expected.every((range, index) => {
    const link = links[index]
    const url = record(range.properties) && typeof range.properties.url === 'string' ? range.properties.url : ''
    return record(link) && link.id === range.rangeId && link.payload === url
  })
}

/** 图片资源与正文一致：data 等于 drawings ?? {}，order 等于 drawingsOrder ?? []（加载时 resetDrawing(data, order)，只读这两个字段） */
function sameDrawings(value: unknown, snapshot: Readonly<Record<string, unknown>>): boolean {
  return record(value) && sameJson(value.data, snapshot.drawings ?? {}) && sameJson(value.order, snapshot.drawingsOrder ?? [])
}

/**
 * 资源与正文的交叉核对（resource-mismatch）：链接资源与图片资源在时（空串按空的结构）必须与正文一致；不在时不判——资源消失由不缩水管
 * （上一版非空的资源这一版必须还在）
 */
export function checkDocResources(checked: CheckedStructure, embedded: readonly EmbeddedJson[]): RuleCheck<'resource-mismatch'> {
  const { snapshot } = checked
  const links = resourceValue(snapshot, embedded, LINKS_RESOURCE, { links: [] })
  if (links.present && !sameLinks(links.value, listOf(bodyOf(checked), 'customRanges')))
    return { ok: false, rule: 'resource-mismatch' }
  const drawings = resourceValue(snapshot, embedded, DRAWINGS_RESOURCE, { data: {}, order: [] })
  if (drawings.present && !sameDrawings(drawings.value, snapshot))
    return { ok: false, rule: 'resource-mismatch' }
  return PASS
}
