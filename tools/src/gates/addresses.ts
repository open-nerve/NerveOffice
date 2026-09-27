// 按浏览器的规则认出会被请求的跨源地址（DEF-016，审查 A4，复验 RA2–RA4）。
// 浏览器解析地址之前：HTML 属性先解码字符引用，样式先还原转义；解析时去掉首尾的空白与控制字符、删掉制表符与换行，
// 把反斜杠当作斜杠，解码主机里的百分号编码、把全角与非 ASCII 的主机转成 ASCII，协议之后不带斜杠（wss:evil.example）也行。
// 这里按同样的顺序处理，再用 WHATWG URL 按站点解析：得到跨源的 http(s)、ws(s) 地址，就是会被请求的地址。
import { INTERPOLATION_PLACEHOLDER } from './eval-and-function.ts'

/** 解析相对地址用的站点：解析出的主机是它，就是本站 */
const SITE = new URL('https://site.invalid/')
const NETWORK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:'])

/** 模板字符串的插值在解析时的替身：主机与路径里都能出现，产物里不会有这个写法 */
const HOLE = 'x0hole0x'

/** 正则的片段："//g"、"//gi" 这样两个斜杠之后只有正则标志的值，不是地址 */
const REGEX_FLAGS_ONLY = /^[\\/]{2}[dgimsuvy]{1,8}$/

/** 写法像地址：以协议（http、https、ws、wss）或两个斜杠（含反斜杠）开头 */
const ADDRESS_LIKE = /^(?:(?:https?|wss?):|[\\/]{2})/i

/** 只是正则的片段（"//g"），不当作地址 */
export function isRegexFlags(value: string): boolean {
  return REGEX_FLAGS_ONLY.test(value)
}

/**
 * 能请求到的主机：IPv4、方括号里的 IPv6，或者每一段只有字母、数字、连字符与下划线的名字（转成 ASCII 之后）。
 * 正则的片段也会被解析出"主机"（React Router 产物里的一段正则被解析成主机 *$），这样的名字查不到地址，不算（复验时真实产物里的误报）
 */
function isRequestableHost(hostname: string): boolean {
  return hostname.startsWith('[') || /^(?:\w(?:[\w-]*\w)?\.)*\w(?:[\w-]*\w)?\.?$/.test(hostname)
}

/**
 * value 被浏览器当作地址解析时，若得到跨源的 http(s)、ws(s) 地址，返回它；否则返回 undefined。
 * 模板字符串的插值（INTERPOLATION_PLACEHOLDER）写回返回值里：主机里有插值的，由调用方按"运行时拼出"计数。
 * 以插值开头、后面紧跟两个斜杠（反斜杠）时，插值当作协议（`${location.protocol}//evil.example`）。
 */
export function crossOriginAddress(value: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- 浏览器去掉开头的 C0 控制字符与空格（WHATWG URL 规范），要匹配的正是它们
  let candidate = value.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, '')
  const afterHole = candidate.slice(INTERPOLATION_PLACEHOLDER.length)
  if (candidate.startsWith(INTERPOLATION_PLACEHOLDER) && /^[\\/]{2}/.test(afterHole))
    candidate = `https:${afterHole}`
  if (!ADDRESS_LIKE.test(candidate) || isRegexFlags(candidate))
    return undefined
  const url = URL.parse(candidate.replaceAll(INTERPOLATION_PLACEHOLDER, HOLE), SITE.href)
  if (url === null || !NETWORK_SCHEMES.has(url.protocol) || url.host === SITE.host || !isRequestableHost(url.hostname))
    return undefined
  return url.href.replaceAll(HOLE, INTERPOLATION_PLACEHOLDER)
}

/** 值与它在所在文本里的位置（[index, end)） */
export interface LocatedValue {
  readonly value: string
  readonly index: number
  readonly end: number
}

/**
 * HTML 里会改变地址结构的命名字符引用（/ \ : . @ # ? % 与空白等）。其他命名引用不解码：
 * 它们只可能是主机或路径里的字母，不解码照样解析成一个跨源的主机，照样报出
 */
const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  sol: '/',
  bsol: '\\',
  colon: ':',
  period: '.',
  commat: '@',
  num: '#',
  quest: '?',
  percnt: '%',
  Tab: '\t',
  NewLine: '\n',
  nbsp: '\u00A0',
  amp: '&',
  quot: '"',
  apos: '\'',
  lt: '<',
  gt: '>',
}

function codePoint(code: number): string {
  return code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF) ? '\uFFFD' : String.fromCodePoint(code)
}

/** 解码 HTML 的字符引用：数字引用（分号可以省略）与会改变地址结构的命名引用 */
export function decodeHtmlReferences(text: string): string {
  return text.replace(/&(?:#(\d{1,7});?|#x([\da-f]{1,6});?|([a-z]+);)/gi, (match, decimal?: string, hex?: string, name?: string) => {
    if (decimal !== undefined)
      return codePoint(Number.parseInt(decimal, 10))
    if (hex !== undefined)
      return codePoint(Number.parseInt(hex, 16))
    return NAMED_REFERENCES[name ?? ''] ?? match
  })
}

/** 还原样式里的转义（\2f、\/）：浏览器解析 url() 与字符串之前先还原 */
export function unescapeCss(text: string): string {
  return text.replace(/\\(?:([\da-f]{1,6})[ \t\n\r\f]?|([^\n\r\f\da-f]))/gi, (_match, hex?: string, char?: string) =>
    hex === undefined ? char ?? '' : codePoint(Number.parseInt(hex, 16)))
}

/** 去掉首尾的空白与成对的引号 */
function unquote(text: string): string {
  const trimmed = text.trim()
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed)
  return quoted === null ? trimmed : (quoted[2] ?? '').trim()
}

/** 样式里可能是地址的值（在已还原转义的文本里）：url(…) 的内容（带不带引号）与 url() 之外引号里的字符串（@import、image-set 等） */
export function cssValues(css: string): LocatedValue[] {
  const urls = [...css.matchAll(/url\(([^)]*)\)/gi)].map(match => ({ value: unquote(match[1] ?? ''), index: match.index, end: match.index + match[0].length }))
  const strings = [...css.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)]
    .filter(match => !urls.some(url => match.index >= url.index && match.index < url.end))
    .map(match => ({ value: (match[1] ?? match[2] ?? '').trim(), index: match.index, end: match.index + match[0].length }))
  return [...urls, ...strings]
}

/** srcset 的每个候选的地址（候选以逗号分隔，地址是候选里的第一段） */
function srcsetCandidates(value: string): string[] {
  return value.split(',').map(candidate => candidate.trim().split(/\s+/)[0] ?? '').filter(candidate => candidate !== '')
}

/** 属性的值（已解码）里可能是地址的部分：srcset 的每个候选、style 里的样式、meta refresh 的 url=，其余是整个值 */
function attributeValues(name: string, value: string): string[] {
  if (name === 'srcset' || name === 'imagesrcset')
    return srcsetCandidates(value)
  if (name === 'style')
    return cssValues(unescapeCss(value)).map(item => item.value)
  const refresh = /url\s*=([\s\S]*)$/i.exec(value)
  if (name === 'content' && refresh !== null)
    return [unquote(refresh[1] ?? '')]
  return [value]
}

/**
 * HTML、SVG 里可能是地址的值：属性的值（解码字符引用之后，见 attributeValues）与 style 元素里的样式（见 cssValues）。
 * 位置是整个属性或 style 元素在原文里的位置
 */
export function htmlValues(html: string): LocatedValue[] {
  const values: LocatedValue[] = []
  for (const match of html.matchAll(/(?<=[\s"'/])([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const value = decodeHtmlReferences(match[2] ?? match[3] ?? match[4] ?? '')
    for (const candidate of attributeValues((match[1] ?? '').toLowerCase(), value))
      values.push({ value: candidate, index: match.index, end: match.index + match[0].length })
  }
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const item of cssValues(unescapeCss(match[1] ?? '')))
      values.push({ value: item.value, index: match.index, end: match.index + match[0].length })
  }
  return values
}

/** 把 spans 覆盖的部分换成等长的空白（位置不变）：取出值之后，剩下的文本照旧按写法找地址，不重复计数 */
export function blankOut(text: string, spans: readonly Pick<LocatedValue, 'index' | 'end'>[]): string {
  let result = ''
  let cursor = 0
  for (const span of [...spans].sort((a, b) => a.index - b.index)) {
    const start = Math.max(span.index, cursor)
    if (span.end <= start)
      continue
    result += text.slice(cursor, start) + ' '.repeat(span.end - start)
    cursor = span.end
  }
  return result + text.slice(cursor)
}
