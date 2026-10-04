// 链接地址的判定（00 号计划书 §11.3 的细化，M3-P3 设计 §3.2）：前后端共用、纯函数、不依赖 Univer。
// - 服务端：快照里每个单元格的链接，地址合法并且等于它的规范写法、rangeId 合写法（checkCellLinks）；
// - 页面：写入之前把 SDK 自动识别出的链接改成规范写法，不合法的去掉链接、保留文字（normalizeCellLinks，DEF-021）。
// 表格的链接只在单元格富文本里：cell.p.body.customRanges 里 rangeType 为 0（CustomRangeType.HYPERLINK）的区间，地址在 properties.url。
// 规范写法用 WHATWG URL 解析（Node 与浏览器都有）：同一组用例（link-address.test-support.ts）在 Node 的单元测试与三个浏览器的 E2E 里
// 得到同样的结果，并且规范写法再判定一次不变（不动点）
import type { RuleCheck, SnapshotRule } from './snapshot-rules.ts'
import { isJsonObject } from './json-values.ts'

/** 地址的长度上限（UTF-16 码元）：去掉首尾空白之后的写法与规范写法都不能超过 */
export const LINK_ADDRESS_MAX_LENGTH = 2048

/** 单元格富文本里链接区间的 rangeType：Univer 的 CustomRangeType.HYPERLINK（SDK 按严格相等判断，别的种类不是链接） */
export const HYPERLINK_RANGE_TYPE = 0

/**
 * 链接区间的 rangeId 的写法：SDK 生成的是 nanoid 的字符（字母、数字、_ 与 -）。SDK 复制链接时不转义它（计划书 §11.3），
 * 粘贴带 data-rangeid 的 HTML 能把任意的写法带进来
 */
const RANGE_ID = /^[\w-]{1,64}$/

/** C0 控制字符与 DEL：浏览器解析地址时会删掉其中的制表符与换行，含义随之改变（/\t/evil.example 成了协议相对的地址），见到就拒绝 */
// eslint-disable-next-line no-control-regex -- 要匹配的正是控制字符
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/

/** 文档内锚点：不含空白、引号、尖括号与反引号（计划书 §11.3；M0 原型另排除反引号） */
const ANCHOR = /^#[^\s"'<>`]*$/

/**
 * 本站相对地址按它解析：只用来解析与比较来源，不发请求（.invalid 不会被解析成任何主机，RFC 2606）。写成来源的样子（没有路径），
 * 解析结果的 origin 与它逐字相同。必须是特殊协议（https）：浏览器按页面的地址（https）解析相对地址时把反斜杠当作斜杠，
 * /\evil.example 换了主机
 */
const RELATIVE_BASE = 'https://relative-link.invalid'

/** 允许的协议：与 SDK 点击链接前的 isSafeUrl 一致（计划书 §11.3） */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:'])

/**
 * 不合法的原因：
 * - empty：去掉首尾空白之后是空的；too-long：超过 LINK_ADDRESS_MAX_LENGTH；control-character：含控制字符；
 * - unparsable：解析不了，包括没有协议、也不以 / 或 # 开头的写法（example.org、user@example.com）；scheme：协议不是 http、https、mailto；
 * - credentials：http(s) 带用户名或密码；mailto-host：mailto 带主机部分（mailto://x@y，SDK 键入邮箱时这样写，页面改写成 mailto:x@y）；
 * - off-site：相对地址解析之后换了主机（//host、/\host、点段化简出 //）；anchor：锚点含空白、引号、尖括号或反引号
 */
export const LINK_ADDRESS_INVALID_REASONS = ['empty', 'too-long', 'control-character', 'unparsable', 'scheme', 'credentials', 'mailto-host', 'off-site', 'anchor'] as const
export type LinkAddressInvalidReason = (typeof LINK_ADDRESS_INVALID_REASONS)[number]

/** 判定的结果：合法时是规范写法，不合法时是原因 */
export type CanonicalLink = { readonly ok: true, readonly href: string } | { readonly ok: false, readonly reason: LinkAddressInvalidReason }

function invalid(reason: LinkAddressInvalidReason): CanonicalLink {
  return { ok: false, reason }
}

/**
 * 规范写法里的 | 一律编成 %7C：Chromium 把路径里的 | 编码、Node 与 WebKit 保留，统一之后各引擎的结果相同（P3 设计前的跨引擎实测）。
 * 规范写法里 | 只会出现在路径、查询与片段里（主机不能含 |，用户名与密码一律拒绝），%7C 与 | 指的是同一个地址
 */
function settled(href: string): CanonicalLink {
  const encoded = href.replaceAll('|', '%7C')
  return encoded.length > LINK_ADDRESS_MAX_LENGTH ? invalid('too-long') : { ok: true, href: encoded }
}

function parsed(text: string, base?: string): URL | undefined {
  try {
    return new URL(text, base)
  }
  catch {
    return undefined
  }
}

/** 本站相对地址 /…：按占位的站点解析，主机必须不变；规范写法是解析之后的路径、查询与片段 */
function relativeLink(text: string): CanonicalLink {
  // 以 // 或 /\ 开头是协议相对的地址：浏览器按它换主机（写的恰好是占位的主机也一样）
  if (text.startsWith('//') || text.startsWith('/\\'))
    return invalid('off-site')
  const url = parsed(text, RELATIVE_BASE)
  if (url === undefined)
    return invalid('unparsable')
  // 主机必须不变：按 WHATWG URL，/ 开头的写法只有上面两种会换主机；这一条照规则本身再核对一次，某个引擎的解析与规范不同时也拦得住
  if (url.origin !== RELATIVE_BASE)
    return invalid('off-site')
  const path = `${url.pathname}${url.search}${url.hash}`
  // 点段化简之后以 // 开头（/..//evil.example）：当作地址时它是协议相对的，换了主机
  return path.startsWith('//') ? invalid('off-site') : settled(path)
}

/** 有协议的地址：只允许 http、https、mailto */
function absoluteLink(text: string): CanonicalLink {
  const url = parsed(text)
  if (url === undefined)
    return invalid('unparsable')
  if (!ALLOWED_PROTOCOLS.has(url.protocol))
    return invalid('scheme')
  if (url.protocol === 'mailto:') {
    // 只接受没有主机部分的写法 mailto:x@y；mailto://x@y 与 mailto:///x 都带着主机部分（后者是空的主机）
    return url.href.startsWith('mailto://') ? invalid('mailto-host') : settled(url.href)
  }
  // 带用户名或密码的 http(s)：钓鱼常用的写法（https://bank.example@evil.example/）
  if (url.username !== '' || url.password !== '')
    return invalid('credentials')
  return settled(url.href)
}

/**
 * 链接地址的规范写法（计划书 §11.3 的细化）：
 * 1. 含控制字符（C0 与 DEL）一律拒绝，不先删掉再判断；然后去掉首尾空白（String.prototype.trim 的空白），规范写法里没有它们；
 * 2. 长度不超过 LINK_ADDRESS_MAX_LENGTH（去掉空白之后的写法与规范写法都算）；
 * 3. # 开头是文档内锚点：不含空白、引号、尖括号与反引号，原样就是规范写法（不解析）；
 * 4. / 开头是本站相对地址：按占位的站点解析，主机必须不变，规范写法是解析之后的路径、查询与片段；
 * 5. 其余必须带协议、只允许 http、https、mailto：http(s) 取 WHATWG URL 的 href（协议与主机小写、主机按 IDN 转成 punycode、
 *    去掉默认端口、点段化简、百分号编码），带用户名或密码的拒绝；mailto 只接受没有主机部分的写法；
 * 6. 规范写法里的 | 一律编成 %7C（跨引擎一致）。
 * 合法时 canonicalLink(href) 给出同一个 href（不动点）；任何字符串都不抛出
 */
export function canonicalLink(url: string): CanonicalLink {
  if (CONTROL_CHARACTER.test(url))
    return invalid('control-character')
  const text = url.trim()
  if (text === '')
    return invalid('empty')
  if (text.length > LINK_ADDRESS_MAX_LENGTH)
    return invalid('too-long')
  if (text.startsWith('#'))
    return ANCHOR.test(text) ? { ok: true, href: text } : invalid('anchor')
  if (text.startsWith('/'))
    return relativeLink(text)
  return absoluteLink(text)
}

/** 绝对地址（带协议）的规范写法：链接文字只有是这样的地址时，才能代替不合法的链接地址 */
function isAbsoluteHref(href: string): boolean {
  return /^(?:https?|mailto):/.test(href)
}

/** 单元格富文本的正文：p 与 p.body 都是对象时给出 body；否则这个单元格没有链接 */
function bodyOf(p: unknown): Record<string, unknown> | undefined {
  if (!isJsonObject(p))
    return undefined
  const body = p.body
  return isJsonObject(body) ? body : undefined
}

function isRangeId(value: unknown): boolean {
  return typeof value === 'string' && RANGE_ID.test(value)
}

/** 链接区间的地址：properties.url 是字符串时给出它 */
function urlOf(range: Record<string, unknown>): string | undefined {
  const properties = range.properties
  return isJsonObject(properties) && typeof properties.url === 'string' ? properties.url : undefined
}

/** SDK 键入邮箱时写出的 mailto://x@y 改成 mailto:x@y（协议不区分大小写，前面的空白留给判定去掉） */
function withoutMailtoSlashes(url: string): string {
  return url.replace(/^(\s*mailto:)\/\//i, '$1')
}

/** 链接区间覆盖的文字（startIndex、endIndex 都含）：下标不合理或者没有正文时为 undefined */
function coveredText(range: Record<string, unknown>, dataStream: string | undefined): string | undefined {
  const { startIndex: start, endIndex: end } = range
  if (dataStream === undefined || typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end))
    return undefined
  return start >= 0 && start <= end && end < dataStream.length ? dataStream.slice(start, end + 1) : undefined
}

/**
 * 修好的地址：mailto:// 改成 mailto: 之后合法，就是它的规范写法；仍不合法、而链接覆盖的文字本身是合法的绝对地址时用这段文字
 * （计划书 §11.3 粘贴清洗的同一条：SDK 在单元格编辑器里粘贴时把整段文字当作地址）；都不行是 undefined（去掉这段链接）
 */
function repairedHref(range: Record<string, unknown>, dataStream: string | undefined): string | undefined {
  const url = urlOf(range)
  if (url === undefined)
    return undefined
  const own = canonicalLink(withoutMailtoSlashes(url))
  if (own.ok)
    return own.href
  const text = coveredText(range, dataStream)
  const fromText = text === undefined ? undefined : canonicalLink(text)
  return fromText?.ok === true && isAbsoluteHref(fromText.href) ? fromText.href : undefined
}

/** 换下不合写法的 rangeId：link-<这一项的下标>，与同一个单元格里已有的重复时再加序号（结果只由输入决定） */
function freshRangeId(index: number, used: Set<unknown>): string {
  let id = `link-${index}`
  for (let suffix = 1; used.has(id); suffix += 1)
    id = `link-${index}-${suffix}`
  used.add(id)
  return id
}

/**
 * 把一个单元格富文本（cell.p）里的链接改成规范写法（页面在写入之前改写用，M3-P3 设计 §3.6）：就地改写 p.body.customRanges，
 * 返回改动过没有。只动链接（rangeType 为 HYPERLINK_RANGE_TYPE 的区间），别的种类原样保留：
 * - 地址：mailto:// 修成 mailto:；不合法、而链接覆盖的文字是合法的绝对地址时改用这段文字；仍不合法就去掉这段链接，文字保留
 *   （正文的 dataStream 不动）；
 * - rangeId 不合写法的换掉（见 freshRangeId）；
 * - 看不懂的结构按不合法处理：customRanges 不是数组时清空，不是对象的项去掉，链接没有字符串的地址时去掉这段链接。
 * 改动时换上新的数组与新的区间对象（原来的区间对象不改）；p 不是对象、没有正文或没有链接时什么也不做。任何 JSON 的值都不抛出。
 * 结果一定通过 checkCellLinks
 */
export function normalizeCellLinks(p: unknown): boolean {
  const body = bodyOf(p)
  const ranges = body?.customRanges
  if (body === undefined || ranges === undefined || ranges === null)
    return false
  if (!Array.isArray(ranges)) {
    body.customRanges = []
    return true
  }
  const dataStream = typeof body.dataStream === 'string' ? body.dataStream : undefined
  const used = new Set<unknown>((ranges as readonly unknown[]).map(range => isJsonObject(range) ? range.rangeId : undefined))
  const kept: unknown[] = []
  let changed = false
  for (const [index, range] of (ranges as readonly unknown[]).entries()) {
    if (!isJsonObject(range)) {
      changed = true
      continue
    }
    if (range.rangeType !== HYPERLINK_RANGE_TYPE) {
      kept.push(range)
      continue
    }
    const href = repairedHref(range, dataStream)
    if (href === undefined) {
      changed = true
      continue
    }
    let next = range
    if (href !== urlOf(range))
      next = { ...next, properties: { ...(range.properties as Record<string, unknown>), url: href } }
    if (!isRangeId(range.rangeId))
      next = { ...next, rangeId: freshRangeId(index, used) }
    changed ||= next !== range
    kept.push(next)
  }
  if (changed)
    body.customRanges = kept
  return changed
}

/** checkCellLinks 可能给出的规则 */
export type CellLinkRule = Extract<SnapshotRule, 'link-structure' | 'link-address' | 'link-range-id'>

const PASS: RuleCheck<CellLinkRule> = { ok: true }

/**
 * 服务端核对一个单元格富文本（cell.p）里的链接，只判定、不改写（M3-P3 设计 §3.3 的链接一条）。逐个区间，第一条不满足的就是结果：
 * - link-structure：customRanges 不是数组（null 与没有一样：没有链接）、某一项不是对象、链接没有字符串的地址（properties.url）；
 * - link-address：地址不合法，或者不等于它的规范写法（canonicalLink）；
 * - link-range-id：rangeId 不合写法。
 * p 不是对象、没有正文时没有链接，通过。任何输入都不抛出
 */
export function checkCellLinks(p: unknown): RuleCheck<CellLinkRule> {
  const ranges = bodyOf(p)?.customRanges
  if (ranges === undefined || ranges === null)
    return PASS
  if (!Array.isArray(ranges))
    return { ok: false, rule: 'link-structure' }
  for (const range of ranges as readonly unknown[]) {
    if (!isJsonObject(range))
      return { ok: false, rule: 'link-structure' }
    if (range.rangeType !== HYPERLINK_RANGE_TYPE)
      continue
    const url = urlOf(range)
    if (url === undefined)
      return { ok: false, rule: 'link-structure' }
    const link = canonicalLink(url)
    if (!link.ok || link.href !== url)
      return { ok: false, rule: 'link-address' }
    if (!isRangeId(range.rangeId))
      return { ok: false, rule: 'link-range-id' }
  }
  return PASS
}
