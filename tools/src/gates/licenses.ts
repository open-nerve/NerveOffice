// A01：依赖许可（规范 §3，00 号计划书 §3.3）。
// 生产依赖只接受白名单；开发依赖不得有 GPL、AGPL、SSPL 与没有声明许可的包。
import type { LicenseException } from './policy.ts'
import type { Violation } from './types.ts'

export interface LicenseEntry {
  name: string
  versions: string[]
  license: string
}

/** `pnpm licenses list --json` 的输出：许可 → 包列表。 */
export type LicenseReport = Record<string, LicenseEntry[]>

export function flattenLicenseReport(report: LicenseReport): LicenseEntry[] {
  return Object.values(report).flat()
}

type Token = '(' | ')' | 'AND' | 'OR' | 'WITH' | { id: string }

function tokenize(expression: string): Token[] | undefined {
  const tokens: Token[] = []
  for (const raw of expression.replace(/[()]/g, ' $& ').trim().split(/\s+/)) {
    if (raw === '')
      continue
    if (raw === '(' || raw === ')' || raw === 'AND' || raw === 'OR' || raw === 'WITH')
      tokens.push(raw)
    else if (/^[\w.+-]+$/.test(raw))
      tokens.push({ id: raw })
    else
      return undefined
  }
  return tokens
}

/**
 * SPDX 许可表达式是否能只用允许的许可满足：OR 取任一分支，AND 要求全部，
 * WITH 的例外条款不改变基础许可的判断。无法解析的表达式视为不满足。
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
      const exception = tokens[position]
      if (typeof exception !== 'object')
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

function isException(entry: LicenseEntry, exceptions: readonly LicenseException[]): boolean {
  return exceptions.some(e => e.name === entry.name && e.license === entry.license)
}

function describeEntry(entry: LicenseEntry): string {
  return `${entry.name}@${entry.versions.join('、')}`
}

export function checkProductionLicenses(entries: readonly LicenseEntry[], allowed: readonly string[], exceptions: readonly LicenseException[]): Violation[] {
  return entries
    .filter(entry => !satisfies(entry.license, id => allowed.includes(id)) && !isException(entry, exceptions))
    .map(entry => ({
      rule: 'licenses/production',
      subject: describeEntry(entry),
      detail: `许可 ${entry.license || '（未声明）'} 不在生产依赖的白名单里`,
    }))
}

const STRONG_COPYLEFT = /^(?:A?GPL|SSPL)-/

export function checkDevelopmentLicenses(entries: readonly LicenseEntry[], exceptions: readonly LicenseException[]): Violation[] {
  return entries
    .filter(entry => !satisfies(entry.license, id => !STRONG_COPYLEFT.test(id) && id !== 'UNKNOWN' && id !== 'UNLICENSED') && !isException(entry, exceptions))
    .map(entry => ({
      rule: 'licenses/development',
      subject: describeEntry(entry),
      detail: `开发依赖不得使用 GPL、AGPL、SSPL 或没有声明许可，现在是 ${entry.license || '（未声明）'}`,
    }))
}
