import type { LicenseEntry } from './licenses.ts'
import { describe, expect, it } from 'vitest'
import { checkDevelopmentLicenses, checkProductionLicenses, flattenLicenseReport, satisfies } from './licenses.ts'

const allowed = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', '0BSD']
const isAllowed = (id: string): boolean => allowed.includes(id)

function entry(name: string, license: string): LicenseEntry {
  return { name, versions: ['1.0.0'], license }
}

describe('satisfies（SPDX 表达式）', () => {
  it.each([
    ['MIT', true],
    ['GPL-3.0', false],
    ['(MIT OR GPL-3.0)', true],
    ['MIT OR GPL-3.0', true],
    ['MIT AND GPL-3.0', false],
    ['MIT AND Apache-2.0', true],
    ['(MIT AND BSD-3-Clause) OR GPL-2.0', true],
    ['Apache-2.0 WITH LLVM-exception', true],
    ['GPL-2.0 WITH Classpath-exception-2.0', false],
    ['', false],
    ['UNKNOWN', false],
    ['SEE LICENSE IN LICENSE.md', false],
    ['(MIT', false],
  ])('%s → %s', (expression, expected) => {
    expect(satisfies(expression, isAllowed)).toBe(expected)
  })
})

describe('flattenLicenseReport', () => {
  it('展开 pnpm licenses list --json 的分组输出', () => {
    const report = { 'MIT': [{ name: 'react', versions: ['19.3.0'], license: 'MIT' }], '(MIT OR CC0-1.0)': [{ name: 'x', versions: ['1.0.0'], license: '(MIT OR CC0-1.0)' }] }
    expect(flattenLicenseReport(report).map(e => e.name)).toEqual(['react', 'x'])
  })
})

describe('US-M1-11 A01 生产依赖的许可', () => {
  it('合规：全部在白名单里（含多选一）', () => {
    expect(checkProductionLicenses([entry('react', 'MIT'), entry('x', '(MIT OR CC0-1.0)')], allowed, [])).toEqual([])
  })

  it.each(['GPL-3.0', 'MPL-2.0', 'CC-BY-4.0', 'UNKNOWN', ''])('违规：生产依赖的许可 %s 不在白名单', (license) => {
    expect(checkProductionLicenses([entry('bad', license)], allowed, []).map(v => v.rule)).toEqual(['licenses/production'])
  })

  it('合规：登记过的例外', () => {
    const exceptions = [{ name: 'special', license: 'MPL-2.0', reason: '已评审' }]
    expect(checkProductionLicenses([entry('special', 'MPL-2.0')], allowed, exceptions)).toEqual([])
  })

  it('违规：例外登记的许可与实际不同时不放行', () => {
    const exceptions = [{ name: 'special', license: 'MPL-2.0', reason: '已评审' }]
    expect(checkProductionLicenses([entry('special', 'GPL-3.0')], allowed, exceptions).map(v => v.rule)).toEqual(['licenses/production'])
  })
})

describe('US-M1-11 A01 开发依赖的许可', () => {
  it('合规：宽松许可与弱 copyleft 都可以用在开发工具里', () => {
    expect(checkDevelopmentLicenses([entry('a', 'MIT'), entry('b', 'MPL-2.0'), entry('c', 'CC-BY-4.0'), entry('d', 'LGPL-3.0'), entry('e', 'BlueOak-1.0.0')], [])).toEqual([])
  })

  it.each(['GPL-3.0', 'GPL-2.0-only', 'AGPL-3.0', 'SSPL-1.0', 'UNKNOWN', '', 'SEE LICENSE IN LICENSE'])('违规：开发依赖的许可 %s', (license) => {
    expect(checkDevelopmentLicenses([entry('bad', license)], []).map(v => v.rule)).toEqual(['licenses/development'])
  })

  it('合规：GPL 与宽松许可多选一', () => {
    expect(checkDevelopmentLicenses([entry('dual', '(GPL-2.0 OR MIT)')], [])).toEqual([])
  })
})
