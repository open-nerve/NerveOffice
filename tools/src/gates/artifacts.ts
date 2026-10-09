// A01：构建产物扫描（00 号计划书 §3.3、§11.3）。严格 CSP 会拦下动态代码与外部请求，
// 但 WebKit 的 Worker 内的违规没有任何渠道可见，所以用静态扫描兜底；范围包括 Worker 自己加载的子块。
// JS 文件按语法树找出 eval 与 Function 的每一处引用（eval-and-function.ts，审查 B3），
// 地址按语法树取出的字符串的值、模板字符串、正则与注释识别（DEF-016）；
// 其他文本文件按各自的语法取出可能是地址的值再识别：HTML 用 parse5 解析（html-values.ts），SVG 按 XML 解析（svg-values.ts），
// 样式按 CSS 的分词规则（css-values.ts），JSON 按顺序取出每个字符串字面量（json-values.ts）（复验 RA4、SA2、SA4、TA2、TA6）；
// 门禁无法确定浏览器会怎样解析的写法直接报违规。整个文件另按写法匹配一遍兜底，落在已经报出同一个地址（规范写法）的那一处里的不重复计数。
// 以字符串为代码的定时器：JS 文件按语法树认调用对象静态可知是定时器、代码参数是字符串的调用（Codex 评审 CX11），其他文本文件按写法匹配；
// 其余几类动态代码对所有文本文件按写法匹配。
// 静态扫描判断不了运行时才拼出来的代码与地址（例如 setTimeout(变量)、经变量别名的定时器 const t=setTimeout; t("…")、
// 运行时才算出的属性名、"https:" + "//" + host 里的变量、从任意函数的 .constructor 取到的构造函数），
// 这部分由 CSP 兜底：策略里没有 'unsafe-eval'，connect-src 只有 'self'。
import type { ExtractedValues, LocatedValues } from './addresses.ts'
import type { Reference, TextValue } from './eval-and-function.ts'
import type { ModuleSources } from './module-sources.ts'
import type { Violation } from './types.ts'
import { crossOriginAddress, hrefOf, isRegexFlags } from './addresses.ts'
import { cssValues } from './css-values.ts'
import { analyzeJavaScript, INTERPOLATION_PLACEHOLDER } from './eval-and-function.ts'
import { htmlValues } from './html-values.ts'
import { jsonValues } from './json-values.ts'
import { isScript, MODULE_SOURCES_FILE } from './module-sources.ts'
import { svgValues } from './svg-values.ts'

export interface ArtifactFile {
  path: string
  content: string
}

/**
 * 已登记的动态代码：产物里确实有，但运行时不会执行（例如函数体为空的能力探测），
 * 或者在我们的配置下执行不到（例如关掉的 JIT 编译器）。reason 写明为什么安全、靠什么保证。
 * 出现次数有上限，超过即违规。
 */
export interface KnownDynamicCode {
  name: string
  reason: string
  /** 压缩后的原文。落在匹配范围里的动态代码按这一项计数，不算违规；压缩器或依赖升级改了写法时会重新报出来 */
  pattern: RegExp
  max: number
}

/**
 * 产物里允许出现的地址：只是字符串（命名空间标识、错误信息里的文档链接、解析地址用的基准），不会被请求。
 * 按具体地址登记，不按主机放行：同一个主机上的其他地址仍然违规（审查 B21）。
 * 编辑器（Univer）的产物里有成百上千条同一个前缀的文档链接（公式的帮助），可以按地址前缀登记（P4 设计 §3.9）；
 * 前缀的登记不适用于平台页面的产物，那里照旧按具体地址。
 */
export interface AllowedAddress {
  /**
   * 地址原文，或者 prefix 为 true 时的地址前缀。两边都按浏览器解析出的规范写法比较（hrefOf：协议与主机不区分大小写，
   * 路径里的点段化简，复验 TA5），句末的句点不算；路径要完全一致（前缀按路径的开头比较）
   */
  address: string
  /** 按前缀放行：前缀至少写到路径的第一段（主机之后的 /） */
  prefix?: boolean
  /** 来自哪个依赖 */
  source: string
  /** 做什么用，为什么不会被请求 */
  reason: string
}

export interface ArtifactPolicy {
  allowedAddresses: readonly AllowedAddress[]
  globalThisProbeMax: number
  knownDynamicCode: readonly KnownDynamicCode[]
  forbiddenKeywords: readonly string[]
}

export interface ArtifactScan {
  violations: Violation[]
  /** 出现过的主机与次数；主机以插值开头、后面是固定域名的，记为 *.域名 */
  hosts: Map<string, number>
  /** 主机完全在运行时拼出的地址（例如 `http://[${e}]`）的次数：静态扫描看不到主机，由 CSP 的 connect-src 兜底 */
  runtimeHosts: number
  /** 允许清单里这次没有出现的地址：依赖升级后核对，过时的删除，保持清单最小 */
  unusedAddresses: string[]
  /** 已登记的动态代码各自出现的次数（没出现的记 0，便于发现过时的登记） */
  knownDynamicCode: Map<string, number>
  /** 全局对象探测（Function('return this')）的次数 */
  globalThisProbes: number
}

/** 全局对象的各种写法：Worker 里是 self，页面里是 window，通用的是 globalThis。 */
const GLOBAL = String.raw`(?:globalThis|window|self|global|this)\s*\.\s*`

/** eval 与 Function 的写法：只用于没有语法树的文本文件；JS 文件按语法树判断，认得出别名与传出。 */
const EVAL_AND_FUNCTION_PATTERNS: Readonly<Record<string, RegExp>> = {
  'eval(': /(?<![\w$.])eval\s*(?:\?\.\s*)?\(/g,
  '全局对象.eval(': new RegExp(String.raw`\b${GLOBAL}eval\s*(?:\?\.\s*)?\(`, 'g'),
  '[\'eval\']': /\[\s*["'`]eval["'`]\s*\]/g,
  '(0, eval)': /,\s*eval\s*\)/g,
  'new Function(': new RegExp(String.raw`\bnew\s+(?:${GLOBAL})?Function\s*\(`, 'g'),
  // 不带 new 的调用；new Function 由上一条计入，全局对象探测单独计数
  'Function(': new RegExp(String.raw`(?<!\bnew\s+)(?:(?<![\w$.])|\b${GLOBAL})Function\s*\((?!\s*["'\x60]return this["'\x60]\s*\))`, 'g'),
}

/**
 * 以字符串为代码的定时器：只用于没有语法树的文本文件（与解析不了的 JS）。JS 文件按语法树认（eval-and-function.ts 的 stringTimerAt），
 * 认得出 globalThis["setTimeout"](…)、Reflect.get(…)(…)、(0,setTimeout)(…)、.call 与 .apply 这些按写法匹配漏掉的写法（Codex 评审 CX11）
 */
const STRING_TIMER_PATTERN = new RegExp(String.raw`(?:(?<![\w$.])|\b${GLOBAL})set(?:Timeout|Interval|Immediate)\s*\(\s*["'\x60]`, 'g')
const STRING_TIMER_LABEL = 'setTimeout(\'…\')'

/** 其他动态代码：所有文本文件都按写法匹配。 */
const OTHER_DYNAMIC_CODE: Readonly<Record<string, RegExp>> = {
  '.constructor(\'…\')': /\.constructor\s*\(\s*["'`]/g,
  'WebAssembly': /\bWebAssembly\b/g,
  '内联 Worker': /\bnew\s+(?:Shared)?Worker\s*\(\s*(?:URL\s*\.\s*createObjectURL|["'`](?:blob|data):)/g,
  'data: 脚本': /["'`]data:(?:text|application)\/(?:javascript|ecmascript)/gi,
}

/** `Function('return this')()`：lodash 等库的全局对象探测，登记过的次数以内允许（文本文件按写法数，JS 文件按语法树数）。 */
const GLOBAL_THIS_PROBE = /(?<![\w$.])Function\s*\(\s*["'`]return this["'`]\s*\)/g

const USAGE_LABELS: Readonly<Record<Reference['usage'], (name: string) => string>> = {
  call: name => `${name}(…)`,
  new: name => `new ${name}(…)`,
  tag: name => `${name}\`…\``,
  value: name => `把 ${name} 当作值引用（赋给变量、当作参数、取属性或解构）`,
}

function isGlobalThisProbe(reference: Reference): boolean {
  return reference.name === 'Function' && reference.usage === 'call' && reference.literalArguments?.length === 1 && reference.literalArguments[0] === 'return this'
}

function isJavaScript(path: string): boolean {
  return /\.m?js$/i.test(path)
}

/**
 * 绝对地址（含 ws/wss，不区分大小写，含 JSON 转义的 \/ 与再经 JS 字符串转义的 \\/，路径里的也算）。
 * 模板字符串里不带花括号的插值 ${…} 算作地址的一部分，由 addressShape 分出固定的部分与运行时拼出的部分（审查 B2）。
 */
const ABSOLUTE_URL = /\b(?:https?|wss?):(?:\\{0,2}\/){2}(?:[^\s"'`()<>\\,;{}$]|\\{1,2}\/|\$(?!\{)|\$\{[^{}]*\})+/gi
/** 取出值之后剩下的文本里的协议相对地址：整个字符串就是地址（前后紧挨着引号），主机是固定的域名。 */
const PROTOCOL_RELATIVE_URL = /(?<=["'`])\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^"'`\s]*)?(?=["'`])/gi
/**
 * 字符串的值里的协议相对地址（DEF-016）：值以 //主机 开头，或者模板字符串里紧跟在插值后面（`${location.protocol}//evil.example`）。
 * 主机可以是域名、不带域名后缀的名字（localhost）、IPv4 或方括号里的 IPv6，后面只能是端口、路径、查询、片段或结尾。
 */
const HOST = String.raw`(?:\[[\da-f:.]+\]|[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)*)(?::\d{1,5})?`
/** 模板字符串里插值的占位（INTERPOLATION_PLACEHOLDER）在正则里的写法 */
const PLACEHOLDER = String.raw`\$\{…\}`
const VALUE_PROTOCOL_RELATIVE_URL = new RegExp(String.raw`(?:^|(?<=${PLACEHOLDER}))//${HOST}(?=[/?#]|$|${PLACEHOLDER})[^\s"'\x60<>]*`, 'gi')
const INTERPOLATION = /\$\{[^{}]*\}/g
/** 插值在地址里的占位：地址里不会出现这个字符 */
const HOLE = '\0'

/** 主机是固定的。address 是第一个插值之前的固定部分；hostComplete 为假时主机或端口里还有插值 */
interface FixedHost { kind: 'fixed', address: string, host: string, hostComplete: boolean }
/** 主机以插值开头、后面是固定的域名（例如 `https://${region}.tracker.example/`）：按 *.域名 报出 */
interface FixedDomainSuffix { kind: 'suffix', host: string }
/** 主机完全在运行时拼出（例如 zod 的 `http://[${e}]`）：看不到主机，由 CSP 兜底 */
interface RuntimeHost { kind: 'runtime' }
type AddressShape = FixedHost | FixedDomainSuffix | RuntimeHost

function context(text: string, index: number): string {
  return text.slice(Math.max(0, index - 40), index + 60).replace(/\s+/g, ' ')
}

/** hostAndPort 形如 example.com:8080 或 [::1]；解析不了时原样返回，照样报出。 */
function hostOf(hostAndPort: string): string {
  try {
    return new URL(`//${hostAndPort}`, 'https://base.invalid').host
  }
  catch {
    return hostAndPort.toLowerCase()
  }
}

/** text 在第一个匹配之前的部分；没有匹配时是整个 text。 */
function before(text: string, pattern: string | RegExp): string {
  const index = typeof pattern === 'string' ? text.indexOf(pattern) : text.search(pattern)
  return index < 0 ? text : text.slice(0, index)
}

/** 地址（以 协议:// 或 // 开头）里协议、用户信息与主机、端口这一段结束的位置：之后是路径、查询或片段。 */
function authorityEnd(address: string): number {
  const start = address.indexOf('//') + 2
  return start + before(address.slice(start), /[/?#]/).length
}

/**
 * 地址原文（绝对地址，或以 // 开头的协议相对地址）的形状。插值之后的部分在运行时才有值：
 * 主机固定时按插值之前的部分检查（插值在路径、查询或端口里，例如 `https://t.example/c?u=${user}`）；
 * 只有主机本身以插值开头时才看不到主机（审查 B2）。
 */
function addressShape(raw: string): AddressShape {
  const text = raw.replace(/\\+\//g, '/').replace(INTERPOLATION, HOLE)
  const authority = text.slice(text.indexOf('//') + 2, authorityEnd(text))
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1)
  if (hostAndPort.replace(/^\[/, '').startsWith(HOLE)) {
    const suffix = before(hostAndPort.slice(hostAndPort.lastIndexOf(HOLE) + 1), /[:\]]/)
    return /\.[a-z]/i.test(suffix) ? { kind: 'suffix', host: `*${suffix.toLowerCase()}` } : { kind: 'runtime' }
  }
  return { kind: 'fixed', address: before(text, HOLE), host: hostOf(before(hostAndPort, HOLE)), hostComplete: !hostAndPort.includes(HOLE) }
}

/** 句末的句点：跟在普通字符后面的一个句点。跟在 .、/ 或 %2e 后面的是点段的一部分（..、/.、%2e.） */
const SENTENCE_END = /(?<![./]|%2e)\.$/i

/**
 * 比较用的写法：浏览器解析出的规范写法（hrefOf）。原来按原文比较路径：前缀后面的 ../ 与 %2e%2e 能跳出允许的前缀（复验 TA5）。
 * 句末的句点不属于地址（例如错误信息里的 "See https://….")，只去掉它；结尾的 ..、%2e. 是点段，照样化简（复验 UA2、VA1）
 */
function comparableAddress(address: string): string {
  return hrefOf(SENTENCE_END.test(address) ? address.slice(0, -1) : address)
}

export interface ScanOptions {
  /**
   * 允许按前缀放行地址的文件（编辑器页的产物与公式 Worker，P4 设计 §3.9）。默认没有：
   * 其他文件（平台页面、以后新增的入口、找不到构建清单时的全部文件）一律只按具体地址（审查 A 路建议 B1）
   */
  prefixFiles?: ReadonlySet<string>
}

/** 允许清单的查找：具体地址按全文，前缀按开头；记下用到了哪些登记。 */
function allowlist(entries: readonly AllowedAddress[]) {
  const exact = new Map<string, string>()
  const prefixes: { prefix: string, original: string }[] = []
  for (const entry of entries) {
    if (entry.prefix === true)
      prefixes.push({ prefix: comparableAddress(entry.address), original: entry.address })
    else
      exact.set(comparableAddress(entry.address), entry.address)
  }
  const used = new Set<string>()
  return {
    allows(address: string, byPrefix: boolean): boolean {
      const original = exact.get(address) ?? (byPrefix ? prefixes.find(entry => address.startsWith(entry.prefix))?.original : undefined)
      if (original !== undefined)
        used.add(original)
      return original !== undefined
    },
    unused: (): string[] => entries.map(entry => entry.address).filter(address => !used.has(address)),
  }
}

/** 值开头的空白与控制字符（浏览器解析地址时去掉） */
// eslint-disable-next-line no-control-regex -- 浏览器去掉开头的 C0 控制字符与空格（WHATWG URL 规范），要匹配的正是它们
const LEADING_JUNK = /^[\u0000-\u0020]*/

/**
 * 一个值里的地址（DEF-016）：JS 的字符串与模板字符串，以及 HTML、SVG 的属性、样式与 JSON 里取出的值。
 * - 写法规范的绝对地址，与插值后面紧跟 //主机 的协议相对地址（`${location.protocol}//evil.example`），出现在值的任何位置都认；
 *   "//g" 这样的正则片段不算（只排除它，不再按"像不像主机"过滤：单标签的主机同样会被请求，复验 RA3）；
 * - 整个值按浏览器的规则再解析一遍（crossOriginAddress，审查 A4）：值的开头已经按写法认出了地址、而两者的规范写法不同时另外报出，
 *   例如允许的地址后面接着制表符与另一个域名（"https://tailwindcss.com\t.evil.example"，复验 SA3）、制表符与 ../ 或空白与别的路径
 *   （"http://www.w3.org/2000/svg\t/../../evil"，复验 TA5）；写法不规范的（前导空白、反斜杠、用户信息、编码过的主机、
 *   不带斜杠的 wss:、协议或端口是插值等）由它认出。
 * 压缩器把普通字符串也写成模板字符串（复验 RA2），所以两者按同一个规则。
 */
function addressesInValue(text: string): string[] {
  const absolute = [...text.matchAll(ABSOLUTE_URL)]
  const relative = [...text.matchAll(VALUE_PROTOCOL_RELATIVE_URL)].filter(match => !isRegexFlags(match[0]))
  const found = [...absolute, ...relative]
  const addresses = found.map(match => match[0])
  const resolved = crossOriginAddress(text)
  if (resolved !== undefined) {
    // 值的开头（或者开头的插值之后）按写法认出的地址
    const head = LEADING_JUNK.exec(text)?.[0].length ?? 0
    const starts = new Set([head, text.startsWith(INTERPOLATION_PLACEHOLDER, head) ? head + INTERPOLATION_PLACEHOLDER.length : head])
    const leading = found.find(match => starts.has(match.index))
    if (leading === undefined || hrefOf(leading[0]) !== hrefOf(resolved))
      addresses.push(resolved)
  }
  return addresses
}

/** JS 的正则与注释里的地址：绝对地址。正则里写成转义的形式（https:\/\/evil\.example）：去掉斜杠、点与连字符前的转义再识别 */
function addressesInCode(value: TextValue): string[] {
  const text = value.kind === 'regexp' ? value.text.replace(/\\([./-])/g, '$1') : value.text
  return [...text.matchAll(ABSOLUTE_URL)].map(match => match[0])
}

/** 没有语法树的文本文件按各自的语法取出可能是地址的值；其余（例如解析不了的 JS）只按写法匹配 */
function extractValues(path: string, content: string): ExtractedValues | undefined {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (extension === '.css')
    return { groups: cssValues(content).map(item => ({ values: [item.value], index: item.index, end: item.end })), problems: [] }
  if (extension === '.html')
    return htmlValues(content)
  if (extension === '.svg')
    return svgValues(content)
  return extension === '.json' ? jsonValues(content) : undefined
}

interface Span {
  readonly index: number
  readonly end: number
}

/**
 * 报出过的地址（规范写法）各自所在的范围，查"某个位置是否落在报出过这个地址的某一处里"：
 * 范围按开头排序，记下前缀里最远的结尾，二分查找（每个写法匹配都遍历全部范围是平方级的，复验 TA7）
 */
function spanLookup(spans: ReadonlyMap<string, readonly Span[]>): (href: string, position: number) => boolean {
  const sorted = new Map<string, { starts: number[], reach: number[] }>()
  for (const [href, list] of spans) {
    const ordered = [...list].sort((a, b) => a.index - b.index)
    let reach = -1
    sorted.set(href, {
      starts: ordered.map(span => span.index),
      reach: ordered.map((span) => {
        reach = Math.max(reach, span.end)
        return reach
      }),
    })
  }
  return (href, position) => {
    const entry = sorted.get(href)
    if (entry === undefined)
      return false
    // 最后一个开头不超过 position 的范围
    let low = 0
    let high = entry.starts.length - 1
    let found = -1
    while (low <= high) {
      const middle = (low + high) >> 1
      if ((entry.starts[middle] ?? 0) <= position) {
        found = middle
        low = middle + 1
      }
      else {
        high = middle - 1
      }
    }
    return found >= 0 && (entry.reach[found] ?? -1) > position
  }
}

export function scanArtifacts(files: readonly ArtifactFile[], policy: ArtifactPolicy, options: ScanOptions = {}): ArtifactScan {
  const violations: Violation[] = []
  const hosts = new Map<string, number>()
  let runtimeHosts = 0
  const allowed = allowlist(policy.allowedAddresses)
  let probes = 0
  const keywordSamples = new Map<string, string>()

  const noteAddress = (file: ArtifactFile, raw: string, index: number): void => {
    const shape = addressShape(raw)
    if (shape.kind === 'runtime') {
      runtimeHosts += 1
      return
    }
    hosts.set(shape.host, (hosts.get(shape.host) ?? 0) + 1)
    // 主机或端口里有插值时，实际的地址不止这段固定部分，允许清单不适用
    const address = shape.kind === 'fixed' && shape.hostComplete ? comparableAddress(shape.address) : undefined
    if (address !== undefined && allowed.allows(address, options.prefixFiles?.has(file.path) === true))
      return
    violations.push({ rule: 'artifacts/address', subject: file.path, detail: `${address ?? shape.host} 不在允许清单里（主机 ${shape.host}）：${context(file.content, index)}` })
  }
  /**
   * 同一处（一个属性、一段样式、一个 JSON 字符串）取出的几个值（整个值、切开的各段等）里，规范写法相同的地址只报一次；
   * 规范写法不同的都要核对允许清单（原来按来源去重，允许的地址排在前面时同一来源的其他地址被跳过，复验 TA1）。
   * 返回报出过的地址各自所在的范围
   */
  const noteValues = (file: ArtifactFile, groups: readonly LocatedValues[]): Map<string, Span[]> => {
    const reported = new Map<string, Span[]>()
    for (const group of groups) {
      const seen = new Set<string>()
      for (const value of group.values) {
        for (const address of addressesInValue(value)) {
          const href = hrefOf(address)
          if (seen.has(href))
            continue
          seen.add(href)
          noteAddress(file, address, group.index)
          const spans = reported.get(href)
          if (spans === undefined)
            reported.set(href, [group])
          else
            spans.push(group)
        }
      }
    }
    return reported
  }
  /** 整个文件按写法匹配：取出值的时候切错或漏掉的，由它兜底（不再把取出的值从原文里抹掉，复验 SA2）；落在报出过同一个地址的那一处里的不重复计数 */
  const noteRawAddresses = (file: ArtifactFile, reported: ReadonlyMap<string, readonly Span[]> = new Map()): void => {
    const covered = spanLookup(reported)
    for (const pattern of [ABSOLUTE_URL, PROTOCOL_RELATIVE_URL]) {
      for (const match of file.content.matchAll(pattern)) {
        if (!covered(hrefOf(match[0]), match.index))
          noteAddress(file, match[0], match.index)
      }
    }
  }
  /** 没有语法树的文本文件：先按各自的语法取出可能是地址的值识别，再对整个文件按写法匹配；门禁无法确定浏览器会怎样解析的写法直接报出 */
  const noteTextAddresses = (file: ArtifactFile): void => {
    const extracted = extractValues(file.path, file.content)
    for (const problem of extracted?.problems ?? [])
      violations.push({ rule: 'artifacts/markup', subject: file.path, detail: `${problem.detail}：${context(file.content, problem.index)}` })
    noteRawAddresses(file, noteValues(file, extracted?.groups ?? []))
  }

  // 已登记的动态代码每出现一次记一个名字
  const knownHits: string[] = []
  for (const file of files) {
    // 已登记的动态代码所在的位置：落在这里的动态代码不算违规，按登记项计数
    const knownRanges: [number, number][] = []
    for (const known of policy.knownDynamicCode) {
      for (const match of file.content.matchAll(new RegExp(known.pattern.source, 'g'))) {
        knownRanges.push([match.index, match.index + match[0].length])
        knownHits.push(known.name)
      }
    }
    const reportDynamicCode = (name: string, index: number): void => {
      if (!knownRanges.some(([start, end]) => index >= start && index < end))
        violations.push({ rule: 'artifacts/dynamic-code', subject: file.path, detail: `${name}：${context(file.content, index)}` })
    }
    /** 有语法树时定时器按语法树认，没有时（不是 JS、JS 解析不了）按写法匹配 */
    let timersFromSyntax = false
    if (isJavaScript(file.path)) {
      const outcome = analyzeJavaScript(file.content)
      if ('error' in outcome) {
        violations.push({ rule: 'artifacts/unparsable', subject: file.path, detail: `无法解析，扫描不了其中的 eval 与 Function：${outcome.error}` })
        // 地址照样按写法找一遍
        noteRawAddresses(file)
      }
      else {
        timersFromSyntax = true
        for (const reference of outcome.references) {
          if (isGlobalThisProbe(reference))
            probes += 1
          else
            reportDynamicCode(USAGE_LABELS[reference.usage](reference.name), reference.index)
        }
        for (const timer of outcome.stringTimers)
          reportDynamicCode(`${timer.name}('…')`, timer.index)
        for (const value of outcome.texts) {
          const addresses = value.kind === 'string' || value.kind === 'template' ? addressesInValue(value.text) : addressesInCode(value)
          for (const address of addresses)
            noteAddress(file, address, value.index)
        }
      }
    }
    else {
      for (const [name, pattern] of Object.entries(EVAL_AND_FUNCTION_PATTERNS)) {
        for (const match of file.content.matchAll(pattern))
          reportDynamicCode(name, match.index)
      }
      probes += [...file.content.matchAll(GLOBAL_THIS_PROBE)].length
      noteTextAddresses(file)
    }
    if (!timersFromSyntax) {
      for (const match of file.content.matchAll(STRING_TIMER_PATTERN))
        reportDynamicCode(STRING_TIMER_LABEL, match.index)
    }
    for (const [name, pattern] of Object.entries(OTHER_DYNAMIC_CODE)) {
      for (const match of file.content.matchAll(pattern))
        reportDynamicCode(name, match.index)
    }
    const lower = file.content.toLowerCase()
    for (const keyword of policy.forbiddenKeywords) {
      const index = lower.indexOf(keyword.toLowerCase())
      if (index >= 0 && !keywordSamples.has(keyword))
        keywordSamples.set(keyword, `${file.path}：${context(file.content, index)}`)
    }
  }

  if (probes > policy.globalThisProbeMax) {
    violations.push({
      rule: 'artifacts/global-this-probe',
      subject: '构建产物',
      detail: `Function('return this') 出现 ${probes} 次，登记的上限是 ${policy.globalThisProbeMax} 次`,
    })
  }
  const knownCounts = policy.knownDynamicCode.map(known => ({ known, count: knownHits.filter(name => name === known.name).length }))
  for (const { known, count } of knownCounts) {
    if (count > known.max)
      violations.push({ rule: 'artifacts/known-dynamic-code', subject: known.name, detail: `出现 ${count} 次，登记的上限是 ${known.max} 次` })
  }
  for (const [keyword, sample] of keywordSamples)
    violations.push({ rule: 'artifacts/keyword', subject: keyword, detail: sample })
  return { violations, hosts, runtimeHosts, unusedAddresses: allowed.unused(), knownDynamicCode: new Map(knownCounts.map(({ known, count }) => [known.name, count])), globalThisProbes: probes }
}

/** 构建产物里允许出现的文件类型：text 类扫描内容（含 .json），binary 类只放行。 */
export const ARTIFACT_FILE_TYPES = {
  text: ['.js', '.mjs', '.css', '.html', '.svg', '.json'],
  binary: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf'],
} as const

/**
 * 构建清单、模块来源清单与第三方许可清单（路径相对产物目录）：只放行这几个文件，不扫描内容，许可正文里的地址不会被请求。
 * .vite/ 下的清单不对外托管（托管不发点开头的目录）
 */
export const ARTIFACT_METADATA_FILES: readonly string[] = ['.vite/manifest.json', MODULE_SOURCES_FILE, '.vite/third-party-packages.json', 'THIRD-PARTY-LICENSES.md']

export type ArtifactKind = 'text' | 'binary' | 'metadata' | 'unknown'

/** path 是相对产物目录的路径。 */
export function classifyArtifact(path: string): ArtifactKind {
  if (ARTIFACT_METADATA_FILES.includes(path))
    return 'metadata'
  const dot = path.lastIndexOf('.')
  const extension = dot > path.lastIndexOf('/') ? path.slice(dot).toLowerCase() : ''
  if ((ARTIFACT_FILE_TYPES.text as readonly string[]).includes(extension))
    return 'text'
  if ((ARTIFACT_FILE_TYPES.binary as readonly string[]).includes(extension))
    return 'binary'
  return 'unknown'
}

/**
 * 只属于测试构建的源码（vite build --mode e2e；路径相对 web 应用目录，以 / 结尾的是目录），不能出现在生产构建里：
 * - CSP 阳性对照的页面、脚本与 Worker（P3 设计 §3.9）：它们故意尝试 eval 与跨源请求；
 * - 编辑器的 testing/（M2-P3 设计 §3.7、M3-P2 设计 §3.5、M3-P4 设计 §3.14）：E2E 探针（把 Facade 挂在 window 上）与它补上的插件 Facade、
 *   页面自检与它和 E2E 共用的文件（入口清单、比较口径、结果的格式、切换的计时：switch-timing.ts 装上时替换 window.fetch；捕获时机复核的
 *   样本与捕获规则的参考实现）、公式模式的开关（formula-mode.ts：地址参数选主线程模式，生产构建里只有 Worker 模式）；
 * - 页面自检的入口页与编辑器页的挂接（features/sheet-editor/selftest-hook.ts，start.tsx 只在测试构建里动态引入）；
 * - 发件箱的浏览器层探针与崩溃用例的探针（M4-P1 设计 §3.1、§3.7，features/sheet-editor/outbox/testing/：start.tsx 只在测试构建、
 *   地址带 outboxProbe、crashProbe 时动态引入）。
 * 按模块的来源认（web 构建写出的模块来源清单，M3-P2 复核 B2）：分块改了名、被并进别的分块、被生产代码直接动态引入成了自己的分块，
 * 都认得出。分块名（TEST_ONLY_ARTIFACTS）与禁用关键字（policy.ts）照旧作兜底
 */
export const TEST_ONLY_SOURCES: readonly string[] = [
  'csp-probe.html',
  'selftest.html',
  'src/editor/testing/',
  'src/entries/csp-probe/',
  'src/entries/selftest/',
  'src/features/sheet-editor/selftest-hook.ts',
  'src/features/sheet-editor/outbox/testing/',
]

/** 模块是不是只属于测试构建：按路径认（查询串不算） */
export function isTestOnlySource(module: string): boolean {
  const path = module.split('?')[0] ?? ''
  return TEST_ONLY_SOURCES.some(source => source.endsWith('/') ? path.startsWith(source) : path === source)
}

/**
 * 按模块来源清单核对生产构建（M3-P2 复核 B2）：每个脚本里有没有只属于测试构建的模块；产物里的每个脚本都要在清单里
 * （不在的话按来源的核对看不到它）。files 是产物里的全部文件（相对产物目录）
 */
export function checkTestOnlySources(sources: ModuleSources, files: readonly string[]): Violation[] {
  const violations: Violation[] = []
  for (const [script, { modules }] of Object.entries(sources)) {
    const testOnly = modules.filter(isTestOnlySource)
    if (testOnly.length > 0) {
      violations.push({
        rule: 'artifacts/test-only-source',
        subject: script,
        detail: `生产构建里出现了只属于测试构建的模块（按来源认）：${testOnly.join('、')}。检查 vite.config.ts 的构建入口，以及只在测试构建（e2e 模式）执行的分支里的动态引入（createSheetEditor、编辑器页的 start.tsx）`,
      })
    }
  }
  for (const script of files.filter(file => isScript(file) && sources[file] === undefined))
    violations.push({ rule: 'artifacts/unlisted-script', subject: script, detail: `模块来源清单（${MODULE_SOURCES_FILE}）里没有这个脚本：按来源的核对看不到它，检查 web 构建是否挂上了 module-sources 插件（主构建与 Worker）` })
  return violations
}

/**
 * 只属于测试构建的文件，按名字认（兜底，主要的核对按来源，见 TEST_ONLY_SOURCES）：
 * - CSP 阳性对照的页面与 Worker（P3 设计 §3.9）；
 * - 编辑器的 E2E 探针（M2-P3 设计 §3.7）与它补上的插件 Facade（M2-P6 第 4 片复核 F5）：探针挂在 window 上的名字另由禁用关键字核对；
 * - 页面自检（M3-P2 设计 §3.5）：入口页 selftest.html 与它的脚本、编辑器页的挂接（selftest-hook）、自检模块（selftest，M3-P4 拆出的
 *   selftest-session、selftest-capture）与结果的格式（selftest-report），分块名都以 selftest- 开头；与 E2E 共用的入口清单（read-only-entries）、
 *   比较口径（content-compare）、切换的计时（switch-timing）与捕获时机复核的样本（capture-samples）
 *   被单独动态引入时也自成分块（M3-P2 复核 B2）；
 * - 公式模式的开关（formula-mode，M3-P4 设计 §3.14）：createSheetEditor 在测试构建的分支里动态引入它，自成分块；
 * - 档案故障开关（M3-P4 设计 §3.14，profile-fault）：编辑器在注册插件之前动态引入它，自成分块；
 * - 自动保存的控制（M3-P4 设计 §3.14，autosave-control）与交接日志（M3-P5 设计 §3.13，handover-log）：编辑器页的组装处（start.tsx）动态引入它们，
 *   各自成分块；
 * - 发件箱的浏览器层探针（M4-P1 设计 §3.1，outbox-probe）与崩溃用例的探针（§3.7，crash-probe）：同样由 start.tsx 动态引入，各自成分块
 *   （两个都引用的发件箱模块另成一个共用的分块，生产构建里没有：生产代码还不引用发件箱）；发件箱探针创建的记下事务的测试 Worker
 *   （outbox-probe.worker，M4-P1 S5）是另一个产物。生产的发件箱 Worker（outbox.worker）不在此列。
 * 自检结果的格式标识与计时、自动保存的控制、交接日志与两个发件箱探针挂在 window 上的名字另由禁用关键字核对
 */
export const TEST_ONLY_ARTIFACTS: readonly RegExp[] = [/^(?:csp-probe|selftest)\.html$/, /^assets\/(?:csp-probe|probe-worker|e2e-probe|probe-facades|selftest|read-only-entries|content-compare|switch-timing|capture-samples|formula-mode|profile-fault|autosave-control|handover-log|outbox-probe(?:\.worker)?|crash-probe)-[^/]*$/]

export function checkTestOnlyArtifacts(paths: readonly string[]): Violation[] {
  return paths
    .filter(path => TEST_ONLY_ARTIFACTS.some(pattern => pattern.test(path)))
    .map(path => ({
      rule: 'artifacts/test-only',
      subject: path,
      detail: '生产构建里出现了只属于测试构建的文件（CSP 探针、编辑器的 E2E 探针、页面自检）：检查 vite.config.ts 的构建入口，以及 createSheetEditor、编辑器页的 start.tsx 里只在测试构建（e2e 模式）执行的分支',
    }))
}

/** 出现未登记的文件类型即违规，免得绕过扫描。 */
export function checkFileTypes(paths: readonly string[]): Violation[] {
  return paths
    .filter(path => classifyArtifact(path) === 'unknown')
    .map(path => ({ rule: 'artifacts/file-type', subject: path, detail: '构建产物里出现了未登记的文件类型，产物扫描会漏掉它；确认来源后登记到 ARTIFACT_FILE_TYPES' }))
}
