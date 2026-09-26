// A01：依赖许可（规范 §3，00 号计划书 §3.3）。
// 生产依赖只接受白名单；开发依赖不得有 GPL、AGPL、SSPL 与没有声明许可的包。
// 生产依赖的范围以 `pnpm ls --prod` 展开的安装实例为准（`pnpm licenses list --prod` 会漏掉可选依赖），
// 再按安装路径到全量的许可清单里查它的许可。SPDX 许可标识不区分大小写。
import type { InstalledPackage } from './dependency-graph.ts'
import type { LicenseEntry, LicenseReport } from './pnpm-outputs.ts'
import type { LicenseException } from './policy.ts'
import type { Violation } from './types.ts'

type Token = '(' | ')' | 'AND' | 'OR' | 'WITH' | { id: string }

function tokenize(expression: string): Token[] | undefined {
  const tokens: Token[] = []
  for (const raw of expression.replace(/[()]/g, ' $& ').trim().split(/\s+/)) {
    if (raw === '')
      continue
    const upper = raw.toUpperCase()
    if (raw === '(' || raw === ')')
      tokens.push(raw)
    else if (upper === 'AND' || upper === 'OR' || upper === 'WITH')
      tokens.push(upper)
    else if (/^[\w.+-]+$/.test(raw))
      tokens.push({ id: raw })
    else
      return undefined
  }
  return tokens
}

/**
 * SPDX 许可表达式是否能只用允许的许可满足：OR 取任一分支，AND 要求全部，
 * WITH 的例外条款不改变基础许可的判断。无法解析的表达式（例如 "SEE LICENSE IN …"）视为不满足。
 */
export function satisfies(expression: string, isAllowed: (id: string) => boolean): boolean {
  const parsed = tokenize(expression)
  if (parsed === undefined || parsed.length === 0)
    return false
  const tokens: readonly Token[] = parsed
  let position = 0

  function parseOr(): boolean | undefined {
    let result = parseAnd()
    while (tokens[position] === 'OR') {
      position++
      const right = parseAnd()
      if (result === undefined || right === undefined)
        return undefined
      result = result || right
    }
    return result
  }
  function parseAnd(): boolean | undefined {
    let result = parseWith()
    while (tokens[position] === 'AND') {
      position++
      const right = parseWith()
      if (result === undefined || right === undefined)
        return undefined
      result = result && right
    }
    return result
  }
  function parseWith(): boolean | undefined {
    const base = parseAtom()
    if (tokens[position] === 'WITH') {
      position++
      if (typeof tokens[position] !== 'object')
        return undefined
      position++
    }
    return base
  }
  function parseAtom(): boolean | undefined {
    const token = tokens[position]
    if (token === '(') {
      position++
      const inner = parseOr()
      if (tokens[position] !== ')')
        return undefined
      position++
      return inner
    }
    if (typeof token === 'object') {
      position++
      return isAllowed(token.id)
    }
    return undefined
  }

  const result = parseOr()
  return result === true && position === tokens.length
}

/** 没有声明许可的各种写法：pnpm 12 对没有 license 字段的包输出 Unknown。 */
const UNDECLARED = new Set(['UNKNOWN', 'UNLICENSED', 'NONE', 'NOASSERTION'])

/** 强 copyleft：GPL、AGPL、SSPL 的各种写法（GPL-3.0、GPLv3、gpl-3.0、AGPL-3.0-only…）；LGPL 不在内。 */
const STRONG_COPYLEFT = /^(?:A?GPL|SSPL)/i

export function isAllowedIn(allowed: readonly string[]): (id: string) => boolean {
  const normalized = new Set(allowed.map(id => id.toUpperCase()))
  return id => normalized.has(id.toUpperCase())
}

function isException(name: string, license: string, exceptions: readonly LicenseException[]): boolean {
  return exceptions.some(e => e.name === name && e.license.toUpperCase() === license.toUpperCase())
}

export function flattenLicenseReport(report: LicenseReport): LicenseEntry[] {
  return Object.values(report).flat()
}

/** 安装路径 → 许可清单里的那一项。 */
export function licensesByPath(report: LicenseReport): Map<string, LicenseEntry> {
  const byPath = new Map<string, LicenseEntry>()
  for (const entry of flattenLicenseReport(report)) {
    for (const path of entry.paths)
      byPath.set(path, entry)
  }
  return byPath
}

/**
 * isInstalled 判断安装实例是否真的装在本机：`pnpm ls` 也列出因操作系统或 CPU 不匹配而没有安装的平台专属包，
 * 它们不在许可清单里，这里跳过；平台专属包的许可以 CI（Linux x64，与生产镜像同一平台）的检查为准。
 */
export function checkProductionLicenses(
  installed: readonly InstalledPackage[],
  byPath: ReadonlyMap<string, LicenseEntry>,
  allowed: readonly string[],
  exceptions: readonly LicenseException[],
  isInstalled: (path: string) => boolean,
): Violation[] {
  const isAllowed = isAllowedIn(allowed)
  const violations: Violation[] = []
  for (const item of installed) {
    if (!isInstalled(item.path))
      continue
    const subject = `${item.name}@${item.version}`
    const entry = byPath.get(item.path)
    if (entry === undefined) {
      violations.push({ rule: 'licenses/not-listed', subject, detail: `许可清单里找不到这个安装实例（${item.path}），无法确认它的许可` })
      continue
    }
    if (!satisfies(entry.license, isAllowed) && !isException(entry.name, entry.license, exceptions))
      violations.push({ rule: 'licenses/production', subject, detail: `许可 ${entry.license || '（未声明）'} 不在生产依赖的白名单里` })
  }
  return violations
}

export function checkDevelopmentLicenses(entries: readonly LicenseEntry[], exceptions: readonly LicenseException[]): Violation[] {
  const isPermitted = (id: string): boolean => !STRONG_COPYLEFT.test(id) && !UNDECLARED.has(id.toUpperCase())
  return entries
    .filter(entry => !satisfies(entry.license, isPermitted) && !isException(entry.name, entry.license, exceptions))
    .map(entry => ({
      rule: 'licenses/development',
      subject: `${entry.name}@${entry.versions.join('、')}`,
      detail: `开发依赖不得使用 GPL、AGPL、SSPL 或没有声明许可，现在是 ${entry.license || '（未声明）'}`,
    }))
}
