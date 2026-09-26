// A01：构建产物扫描（00 号计划书 §3.3、§11.3）。严格 CSP 会拦下动态代码与外部请求，
// 但 WebKit 的 Worker 内的违规没有任何渠道可见，所以用静态扫描兜底；范围包括 Worker 自己加载的子块。
// JS 文件按语法树找出 eval 与 Function 的每一处引用（eval-and-function.ts，审查 B3）；
// 其他文本文件（HTML、SVG、JSON）没有语法树，按写法匹配。其余几类动态代码与地址对所有文本文件按写法匹配。
// 静态扫描判断不了运行时才拼出来的代码与地址（例如 setTimeout(变量)、"https:" + "//" + host、
// 从任意函数的 .constructor 取到的构造函数），这部分由 CSP 兜底：策略里没有 'unsafe-eval'，connect-src 只有 'self'。
import type { Reference } from './eval-and-function.ts'
import type { Violation } from './types.ts'
import { findEvalAndFunction } from './eval-and-function.ts'

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
 */
export interface AllowedAddress {
  /** 地址原文。比较时协议与主机不区分大小写，句末的句点不算；路径要完全一致 */
  address: string
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

/** 其他动态代码：所有文本文件都按写法匹配。 */
const OTHER_DYNAMIC_CODE: Readonly<Record<string, RegExp>> = {
  '.constructor(\'…\')': /\.constructor\s*\(\s*["'`]/g,
  'setTimeout(\'…\')': new RegExp(String.raw`(?:(?<![\w$.])|\b${GLOBAL})set(?:Timeout|Interval|Immediate)\s*\(\s*["'\x60]`, 'g'),
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
/** 字符串里的协议相对地址：整个字符串就是地址（前后紧挨着引号），主机是固定的域名。 */
const PROTOCOL_RELATIVE_URL = /(?<=["'`])\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^"'`\s]*)?(?=["'`])/gi
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

/** 比较用的写法：协议与主机不区分大小写；句末的句点不属于地址（例如错误信息里的 "See https://….")。 */
function comparableAddress(address: string): string {
  const trimmed = address.replace(/\.+$/, '')
  const end = authorityEnd(trimmed)
  return trimmed.slice(0, end).toLowerCase() + trimmed.slice(end)
}

export function scanArtifacts(files: readonly ArtifactFile[], policy: ArtifactPolicy): ArtifactScan {
  const violations: Violation[] = []
  const hosts = new Map<string, number>()
  let runtimeHosts = 0
  const allowed = new Map(policy.allowedAddresses.map(entry => [comparableAddress(entry.address), entry.address]))
  const usedAddresses = new Set<string>()
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
    if (address !== undefined && allowed.has(address)) {
      usedAddresses.add(address)
      return
    }
    violations.push({ rule: 'artifacts/address', subject: file.path, detail: `${address ?? shape.host} 不在允许清单里（主机 ${shape.host}）：${context(file.content, index)}` })
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
    if (isJavaScript(file.path)) {
      const outcome = findEvalAndFunction(file.content)
      if ('error' in outcome) {
        violations.push({ rule: 'artifacts/unparsable', subject: file.path, detail: `无法解析，扫描不了其中的 eval 与 Function：${outcome.error}` })
      }
      else {
        for (const reference of outcome.references) {
          if (isGlobalThisProbe(reference))
            probes += 1
          else
            reportDynamicCode(USAGE_LABELS[reference.usage](reference.name), reference.index)
        }
      }
    }
    else {
      for (const [name, pattern] of Object.entries(EVAL_AND_FUNCTION_PATTERNS)) {
        for (const match of file.content.matchAll(pattern))
          reportDynamicCode(name, match.index)
      }
      probes += [...file.content.matchAll(GLOBAL_THIS_PROBE)].length
    }
    for (const [name, pattern] of Object.entries(OTHER_DYNAMIC_CODE)) {
      for (const match of file.content.matchAll(pattern))
        reportDynamicCode(name, match.index)
    }
    for (const match of file.content.matchAll(ABSOLUTE_URL))
      noteAddress(file, match[0], match.index)
    for (const match of file.content.matchAll(PROTOCOL_RELATIVE_URL))
      noteAddress(file, match[0], match.index)
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
  const unusedAddresses = [...allowed].filter(([address]) => !usedAddresses.has(address)).map(([, original]) => original)
  return { violations, hosts, runtimeHosts, unusedAddresses, knownDynamicCode: new Map(knownCounts.map(({ known, count }) => [known.name, count])) }
}

/** 构建产物里允许出现的文件类型：text 类扫描内容（含 .json），binary 类只放行。 */
export const ARTIFACT_FILE_TYPES = {
  text: ['.js', '.mjs', '.css', '.html', '.svg', '.json'],
  binary: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf'],
} as const

/** 构建清单与第三方许可清单（路径相对产物目录）：只放行这几个文件，不扫描内容，许可正文里的地址不会被请求。 */
export const ARTIFACT_METADATA_FILES: readonly string[] = ['.vite/manifest.json', '.vite/third-party-packages.json', 'THIRD-PARTY-LICENSES.md']

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
 * 只属于测试构建的文件（vite build --mode e2e）：CSP 阳性对照的页面与 Worker（P3 设计 §3.9）。
 * 它们故意尝试 eval 与跨源请求，不能出现在生产构建里。
 */
export const TEST_ONLY_ARTIFACTS: readonly RegExp[] = [/^csp-probe\.html$/, /^assets\/(?:csp-probe|probe-worker)-[^/]*$/]

export function checkTestOnlyArtifacts(paths: readonly string[]): Violation[] {
  return paths
    .filter(path => TEST_ONLY_ARTIFACTS.some(pattern => pattern.test(path)))
    .map(path => ({ rule: 'artifacts/test-only', subject: path, detail: '生产构建里出现了只属于测试构建的文件（CSP 探针）：检查 vite.config.ts 的构建入口' }))
}

/** 出现未登记的文件类型即违规，免得绕过扫描。 */
export function checkFileTypes(paths: readonly string[]): Violation[] {
  return paths
    .filter(path => classifyArtifact(path) === 'unknown')
    .map(path => ({ rule: 'artifacts/file-type', subject: path, detail: '构建产物里出现了未登记的文件类型，产物扫描会漏掉它；确认来源后登记到 ARTIFACT_FILE_TYPES' }))
}
