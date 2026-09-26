// A01：构建产物扫描（00 号计划书 §3.3、§11.3）。严格 CSP 会拦下动态代码与外部请求，
// 但 WebKit 的 Worker 内的违规没有任何渠道可见，所以用静态扫描兜底；范围包括 Worker 自己加载的子块。
import type { Violation } from './types.ts'

export interface ArtifactFile {
  path: string
  content: string
}

export interface ArtifactPolicy {
  allowedHosts: Readonly<Record<string, string>>
  globalThisProbeMax: number
  forbiddenKeywords: readonly string[]
}

const DYNAMIC_CODE: Readonly<Record<string, RegExp>> = {
  'eval(': /(?<![\w$.])eval\s*\(/g,
  '(0, eval)': /\(\s*0\s*,\s*eval\s*\)/g,
  'new Function(': /\bnew\s+Function\s*\(/g,
  // new Function(...) 由上一条计入；这里只算不带 new 的调用
  'Function(\'…\')': /(?<!\bnew\s+)(?<![\w$.])Function\s*\(\s*["'`](?!return this["'`]\s*\))/g,
  'setTimeout(\'…\')': /(?<![\w$.])set(?:Timeout|Interval)\s*\(\s*["'`]/g,
  'WebAssembly.': /\bWebAssembly\./g,
}

/** `Function('return this')()`：lodash 等库的全局对象探测，登记过的次数以内允许。 */
const GLOBAL_THIS_PROBE = /(?<![\w$.])Function\s*\(\s*["'`]return this["'`]\s*\)/g
const ABSOLUTE_URL = /\bhttps?:\/\/[^\s"'`()<>\\,;{}]+/g

function context(text: string, index: number): string {
  return text.slice(Math.max(0, index - 40), index + 60).replace(/\s+/g, ' ')
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  }
  catch {
    return url
  }
}

export function scanArtifacts(files: readonly ArtifactFile[], policy: ArtifactPolicy): { violations: Violation[], hosts: Map<string, number> } {
  const violations: Violation[] = []
  const hosts = new Map<string, number>()
  let probes = 0
  const keywordCounts = new Map<string, { count: number, sample: string }>()

  for (const file of files) {
    for (const [name, pattern] of Object.entries(DYNAMIC_CODE)) {
      for (const match of file.content.matchAll(pattern))
        violations.push({ rule: 'artifacts/dynamic-code', subject: file.path, detail: `${name}：${context(file.content, match.index)}` })
    }
    probes += [...file.content.matchAll(GLOBAL_THIS_PROBE)].length
    for (const match of file.content.matchAll(ABSOLUTE_URL)) {
      const host = hostOf(match[0])
      hosts.set(host, (hosts.get(host) ?? 0) + 1)
      if (policy.allowedHosts[host] === undefined)
        violations.push({ rule: 'artifacts/host', subject: file.path, detail: `${host}：${context(file.content, match.index)}` })
    }
    for (const keyword of policy.forbiddenKeywords) {
      const index = file.content.indexOf(keyword)
      if (index >= 0 && !keywordCounts.has(keyword))
        keywordCounts.set(keyword, { count: 1, sample: `${file.path}：${context(file.content, index)}` })
    }
  }

  if (probes > policy.globalThisProbeMax) {
    violations.push({
      rule: 'artifacts/global-this-probe',
      subject: '构建产物',
      detail: `Function('return this') 出现 ${probes} 次，登记的上限是 ${policy.globalThisProbeMax} 次`,
    })
  }
  for (const [keyword, { sample }] of keywordCounts)
    violations.push({ rule: 'artifacts/keyword', subject: keyword, detail: sample })
  return { violations, hosts }
}
