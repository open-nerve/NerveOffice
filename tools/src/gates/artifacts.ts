// A01：构建产物扫描（00 号计划书 §3.3、§11.3）。严格 CSP 会拦下动态代码与外部请求，
// 但 WebKit 的 Worker 内的违规没有任何渠道可见，所以用静态扫描兜底；范围包括 Worker 自己加载的子块。
// 静态扫描判断不了运行时才拼出来的代码与地址（例如 setTimeout(变量)、"https:" + "//" + host），这部分由 CSP 兜底：
// 策略里没有 'unsafe-eval'，connect-src 只有 'self'。
import type { Violation } from './types.ts'

export interface ArtifactFile {
  path: string
  content: string
}

/** 已登记的能力探测：形如动态代码，但不执行任何代码。出现次数有上限，超过即违规。 */
export interface KnownProbe {
  name: string
  reason: string
  pattern: RegExp
  max: number
}

export interface ArtifactPolicy {
  allowedHosts: Readonly<Record<string, string>>
  globalThisProbeMax: number
  knownProbes: readonly KnownProbe[]
  forbiddenKeywords: readonly string[]
}

/** 全局对象的各种写法：Worker 里是 self，页面里是 window，通用的是 globalThis。 */
const GLOBAL = String.raw`(?:globalThis|window|self|global|this)\s*\.\s*`

const DYNAMIC_CODE: Readonly<Record<string, RegExp>> = {
  'eval(': /(?<![\w$.])eval\s*(?:\?\.\s*)?\(/g,
  '全局对象.eval(': new RegExp(String.raw`\b${GLOBAL}eval\s*(?:\?\.\s*)?\(`, 'g'),
  '[\'eval\']': /\[\s*["'`]eval["'`]\s*\]/g,
  '(0, eval)': /,\s*eval\s*\)/g,
  'new Function(': new RegExp(String.raw`\bnew\s+(?:${GLOBAL})?Function\s*\(`, 'g'),
  // 不带 new 的调用；new Function 由上一条计入，全局对象探测单独计数
  'Function(': new RegExp(String.raw`(?<!\bnew\s+)(?:(?<![\w$.])|\b${GLOBAL})Function\s*\((?!\s*["'\x60]return this["'\x60]\s*\))`, 'g'),
  '.constructor(\'…\')': /\.constructor\s*\(\s*["'`]/g,
  'setTimeout(\'…\')': new RegExp(String.raw`(?:(?<![\w$.])|\b${GLOBAL})set(?:Timeout|Interval|Immediate)\s*\(\s*["'\x60]`, 'g'),
  'WebAssembly': /\bWebAssembly\b/g,
  '内联 Worker': /\bnew\s+(?:Shared)?Worker\s*\(\s*(?:URL\s*\.\s*createObjectURL|["'`](?:blob|data):)/g,
  'data: 脚本': /["'`]data:(?:text|application)\/(?:javascript|ecmascript)/gi,
}

/** `Function('return this')()`：lodash 等库的全局对象探测，登记过的次数以内允许。 */
const GLOBAL_THIS_PROBE = /(?<![\w$.])Function\s*\(\s*["'`]return this["'`]\s*\)/g
/** 绝对地址（含 ws/wss，不区分大小写，含 JSON 转义的 \/ 与再经 JS 字符串转义的 \\/）与字符串里的协议相对地址。 */
const ABSOLUTE_URL = /\b(?:https?|wss?):(?:\\{0,2}\/){2}[^\s"'`()<>\\,;{}]+/gi
const PROTOCOL_RELATIVE_URL = /["'`]\/\/((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#][^"'`\s]*)?["'`]/gi

function context(text: string, index: number): string {
  return text.slice(Math.max(0, index - 40), index + 60).replace(/\s+/g, ' ')
}

function hostOf(url: string): string {
  try {
    return new URL(url.replace(/\\+\//g, '/')).host.toLowerCase()
  }
  catch {
    return url
  }
}

export function scanArtifacts(files: readonly ArtifactFile[], policy: ArtifactPolicy): { violations: Violation[], hosts: Map<string, number> } {
  const violations: Violation[] = []
  const hosts = new Map<string, number>()
  const allowedHosts = new Set(Object.keys(policy.allowedHosts).map(h => h.toLowerCase()))
  let probes = 0
  const keywordSamples = new Map<string, string>()

  const noteHost = (file: ArtifactFile, host: string, index: number): void => {
    hosts.set(host, (hosts.get(host) ?? 0) + 1)
    if (!allowedHosts.has(host))
      violations.push({ rule: 'artifacts/host', subject: file.path, detail: `${host}：${context(file.content, index)}` })
  }

  const knownProbeCounts = new Map<string, number>()
  for (const file of files) {
    // 已登记的探测所在的位置：落在这里的动态代码匹配不算违规，按探测计数
    const probeRanges: [number, number][] = []
    for (const probe of policy.knownProbes) {
      for (const match of file.content.matchAll(new RegExp(probe.pattern.source, 'g'))) {
        probeRanges.push([match.index, match.index + match[0].length])
        knownProbeCounts.set(probe.name, (knownProbeCounts.get(probe.name) ?? 0) + 1)
      }
    }
    const insideProbe = (index: number): boolean => probeRanges.some(([start, end]) => index >= start && index < end)
    for (const [name, pattern] of Object.entries(DYNAMIC_CODE)) {
      for (const match of file.content.matchAll(pattern)) {
        if (!insideProbe(match.index))
          violations.push({ rule: 'artifacts/dynamic-code', subject: file.path, detail: `${name}：${context(file.content, match.index)}` })
      }
    }
    probes += [...file.content.matchAll(GLOBAL_THIS_PROBE)].length
    for (const match of file.content.matchAll(ABSOLUTE_URL)) {
      // 模板字符串里在运行时拼出的地址（例如 `http://[${host}]`）：没有固定的主机，由 CSP 的 connect-src 兜底
      if (file.content.startsWith('${', match.index + match[0].length - 1))
        continue
      noteHost(file, hostOf(match[0]), match.index)
    }
    for (const match of file.content.matchAll(PROTOCOL_RELATIVE_URL))
      noteHost(file, (match[1] ?? '').toLowerCase(), match.index)
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
  for (const probe of policy.knownProbes) {
    const count = knownProbeCounts.get(probe.name) ?? 0
    if (count > probe.max)
      violations.push({ rule: 'artifacts/known-probe', subject: probe.name, detail: `出现 ${count} 次，登记的上限是 ${probe.max} 次` })
  }
  for (const [keyword, sample] of keywordSamples)
    violations.push({ rule: 'artifacts/keyword', subject: keyword, detail: sample })
  return { violations, hosts }
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

/** 出现未登记的文件类型即违规，免得绕过扫描。 */
export function checkFileTypes(paths: readonly string[]): Violation[] {
  return paths
    .filter(path => classifyArtifact(path) === 'unknown')
    .map(path => ({ rule: 'artifacts/file-type', subject: path, detail: '构建产物里出现了未登记的文件类型，产物扫描会漏掉它；确认来源后登记到 ARTIFACT_FILE_TYPES' }))
}
