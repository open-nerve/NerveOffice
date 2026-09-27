// 按浏览器的规则认出会被请求的跨源地址（DEF-016，审查 A4，复验 RA2–RA4、SA1、SA3）。
// 浏览器解析地址时去掉首尾的空白与控制字符、删掉制表符与换行，把反斜杠当作斜杠，解码主机里的百分号编码、
// 把全角与非 ASCII 的主机转成 ASCII，协议之后不带斜杠（wss:evil.example）也行。这里用 WHATWG URL 按站点解析：
// 得到跨源的 http(s)、ws(s) 地址，就是会被请求的地址。值从哪里来（JS 的字符串、HTML 的属性、样式、JSON）见 css-values.ts、html-values.ts。
import { INTERPOLATION_PLACEHOLDER } from './eval-and-function.ts'

/** 值与它在所在文本里的位置（[index, end)） */
export interface LocatedValue {
  readonly value: string
  readonly index: number
  readonly end: number
}

/** 解析相对地址用的站点：解析出的主机是它，就是本站 */
const SITE = new URL('https://site.invalid/')
const NETWORK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:'])

/** 模板字符串的插值在解析时的替身：主机与路径里都能出现，产物里不会有这个写法 */
const HOLE = 'x0hole0x'

/** 正则的片段："//g"、"//gi" 这样两个斜杠之后只有正则标志的值，不是地址 */
const REGEX_FLAGS_ONLY = /^[\\/]{2}[dgimsuvy]{1,8}$/

/** 写法像地址：以协议（http、https、ws、wss）或两个斜杠（含反斜杠）开头 */
const ADDRESS_LIKE = /^(?:(?:https?|wss?):|[\\/]{2})/i

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const PLACEHOLDER = escapeRegExp(INTERPOLATION_PLACEHOLDER)
/** 协议里有插值（`http${s}://`、`${scheme}://`），或者拼接的后半段以 :// 开头：主机是固定的（复验 SA3） */
const INTERPOLATED_SCHEME = new RegExp(String.raw`^(?:[a-z]*${PLACEHOLDER}[a-z]*)?:(?=[\\/]{2})`, 'i')
/** 端口是插值（`//evil.example:${port}/x`）：解析时换成一个端口号，主机照样是固定的（复验 SA3） */
const INTERPOLATED_PORT = new RegExp(String.raw`:${PLACEHOLDER}(?=[\\/?#]|$)`, 'g')

/** 只是正则的片段（"//g"），不当作地址 */
export function isRegexFlags(value: string): boolean {
  return REGEX_FLAGS_ONLY.test(value)
}

/**
 * 能请求到的主机：至少有一个字母或数字（转成 ASCII 之后）。以连字符开头或结尾、带星号的名字浏览器照样请求（复验 SA1）；
 * 只排除正则的片段被解析出的"主机"（React Router 产物里的一段正则被解析成主机 *$）
 */
function isRequestableHost(hostname: string): boolean {
  return /[a-z\d]/i.test(hostname)
}

/**
 * value 被浏览器当作地址解析时，若得到跨源的 http(s)、ws(s) 地址，返回它；否则返回 undefined。
 * 模板字符串的插值（INTERPOLATION_PLACEHOLDER）写回返回值里：主机里有插值的，由调用方按"运行时拼出"计数。
 * 以插值开头、后面紧跟两个斜杠（反斜杠）时，插值当作协议（`${location.protocol}//evil.example`）；
 * 协议里有插值或者以 :// 开头时，按 https 算（主机是固定的）
 */
export function crossOriginAddress(value: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- 浏览器去掉开头的 C0 控制字符与空格（WHATWG URL 规范），要匹配的正是它们
  let candidate = value.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, '')
  const afterHole = candidate.slice(INTERPOLATION_PLACEHOLDER.length)
  if (candidate.startsWith(INTERPOLATION_PLACEHOLDER) && /^[\\/]{2}/.test(afterHole))
    candidate = `https:${afterHole}`
  else
    candidate = candidate.replace(INTERPOLATED_SCHEME, 'https:')
  if (!ADDRESS_LIKE.test(candidate) || isRegexFlags(candidate))
    return undefined
  const url = URL.parse(candidate.replace(INTERPOLATED_PORT, ':1').replaceAll(INTERPOLATION_PLACEHOLDER, HOLE), SITE.href)
  if (url === null || !NETWORK_SCHEMES.has(url.protocol) || url.host === SITE.host || !isRequestableHost(url.hostname))
    return undefined
  return url.href.replaceAll(HOLE, INTERPOLATION_PLACEHOLDER)
}

/**
 * 地址的来源（协议、主机与端口），比较两种认法的结果用：写法规范的地址（JSON 转义的斜杠也认得）与按浏览器的规则解析的地址。
 * 解析不了时返回原文的小写
 */
export function originOf(address: string): string {
  const text = address.replace(/\\+\//g, '/').replace(INTERPOLATED_PORT, ':1').replaceAll(INTERPOLATION_PLACEHOLDER, HOLE)
  const url = URL.parse(text.startsWith('//') ? `https:${text}` : text)
  return url === null ? address.toLowerCase() : `${url.protocol}//${url.host}`
}
