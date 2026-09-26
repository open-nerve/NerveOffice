import type { LicenseEntry } from './pnpm-outputs.ts'
import { describe, expect, it } from 'vitest'
import { collectInstalled } from './dependency-graph.ts'
import { readFixture } from './fixtures.ts'
import { checkDevelopmentLicenses, checkProductionLicenses, flattenLicenseReport, isAllowedIn, licensesByPath, satisfies } from './licenses.ts'
import { licenseReportSchema, lsOutputSchema } from './pnpm-outputs.ts'

const allowed = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', '0BSD']
const isAllowed = isAllowedIn(allowed)

function entry(name: string, license: string): LicenseEntry {
  return { name, versions: ['1.0.0'], paths: [`/repo/node_modules/.pnpm/${name}@1.0.0/node_modules/${name}`], license }
}

describe('satisfies（SPDX 表达式）', () => {
  it.each([
    ['MIT', true],
    ['mit', true],
    ['GPL-3.0', false],
    ['(MIT OR GPL-3.0)', true],
    ['MIT or GPL-3.0', true],
    ['MIT OR GPL-3.0', true],
    ['MIT AND GPL-3.0', false],
    ['MIT AND Apache-2.0', true],
    ['(MIT AND BSD-3-Clause) OR GPL-2.0', true],
    ['Apache-2.0 WITH LLVM-exception', true],
    ['GPL-2.0 WITH Classpath-exception-2.0', false],
    ['', false],
    ['Unknown', false],
    ['SEE LICENSE IN LICENSE.md', false],
    ['(MIT', false],
  ])('%s → %s', (expression, expected) => {
    expect(satisfies(expression, isAllowed)).toBe(expected)
  })
})

describe('US-M1-11 A01 生产依赖的许可', () => {
  it('合规：生产依赖图里的每个安装实例（含可选依赖）都能在许可清单里查到，并且在白名单里（真实输出）', () => {
    const { installed } = collectInstalled(lsOutputSchema.parse(readFixture('pnpm-12/ls-optional-dependencies.json')))
    const byPath = licensesByPath(licenseReportSchema.parse(readFixture('pnpm-12/licenses-list-optional-dependencies.json')))
    expect(checkProductionLicenses(installed, byPath, allowed, [])).toEqual([])
  })

  it('违规：可选依赖的许可不在白名单里', () => {
    const { installed } = collectInstalled(lsOutputSchema.parse(readFixture('pnpm-12/ls-optional-dependencies.json')))
    const report = licenseReportSchema.parse(readFixture('pnpm-12/licenses-list-optional-dependencies.json'))
    const pgTypes = flattenLicenseReport(report).find(e => e.name === 'pg-types')!
    const byPath = licensesByPath({ ...report, 'GPL-3.0': [{ ...pgTypes, license: 'GPL-3.0' }] })
    expect(checkProductionLicenses(installed, byPath, allowed, []).map(v => `${v.rule} ${v.subject}`)).toEqual(['licenses/production pg-types@2.2.0'])
  })

  it('违规：许可清单里找不到某个安装实例', () => {
    const installed = [{ name: 'ghost', version: '1.0.0', path: '/repo/node_modules/.pnpm/ghost@1.0.0/node_modules/ghost' }]
    expect(checkProductionLicenses(installed, new Map(), allowed, []).map(v => v.rule)).toEqual(['licenses/not-listed'])
  })

  it.each(['GPL-3.0', 'MPL-2.0', 'CC-BY-4.0', 'Unknown', ''])('违规：生产依赖的许可 %s 不在白名单', (license) => {
    const item = entry('bad', license)
    const installed = [{ name: item.name, version: '1.0.0', path: item.paths[0]! }]
    expect(checkProductionLicenses(installed, new Map([[item.paths[0]!, item]]), allowed, []).map(v => v.rule)).toEqual(['licenses/production'])
  })

  it('合规：登记过的例外；许可与登记的不同时不放行', () => {
    const exceptions = [{ name: 'special', license: 'MPL-2.0', reason: '已评审' }]
    const good = entry('special', 'MPL-2.0')
    const bad = entry('special', 'GPL-3.0')
    const installed = [{ name: 'special', version: '1.0.0', path: good.paths[0]! }]
    expect(checkProductionLicenses(installed, new Map([[good.paths[0]!, good]]), allowed, exceptions)).toEqual([])
    expect(checkProductionLicenses(installed, new Map([[bad.paths[0]!, bad]]), allowed, exceptions).map(v => v.rule)).toEqual(['licenses/production'])
  })
})

describe('US-M1-11 A01 开发依赖的许可', () => {
  it('违规：pnpm 12 输出的 GPL 各种写法、Unknown 与 SEE LICENSE IN（真实输出）', () => {
    const entries = flattenLicenseReport(licenseReportSchema.parse(readFixture('pnpm-12/licenses-list.json')))
    const flagged = checkDevelopmentLicenses(entries, []).map(v => v.subject.split('@')[0]).sort()
    expect(flagged).toEqual(entries.map(e => e.name).sort())
    expect(new Set(entries.map(e => e.license))).toEqual(new Set(['AGPL-3.0', 'gpl-3.0', 'GPL-3.0', 'GPLv3', 'SEE LICENSE IN LICENSE.txt', 'Unknown']))
  })

  it('合规：宽松许可与弱 copyleft 都可以用在开发工具里', () => {
    expect(checkDevelopmentLicenses([entry('a', 'MIT'), entry('b', 'MPL-2.0'), entry('c', 'CC-BY-4.0'), entry('d', 'LGPL-3.0'), entry('e', 'BlueOak-1.0.0')], [])).toEqual([])
  })

  it.each(['GPL-3.0', 'GPLv3', 'gpl-2.0', 'GPL-2.0-only', 'AGPL-3.0', 'SSPL-1.0', 'Unknown', 'UNLICENSED', ''])('违规：开发依赖的许可 %s', (license) => {
    expect(checkDevelopmentLicenses([entry('bad', license)], []).map(v => v.rule)).toEqual(['licenses/development'])
  })

  it('合规：GPL 与宽松许可多选一', () => {
    expect(checkDevelopmentLicenses([entry('dual', '(GPL-2.0 OR MIT)')], [])).toEqual([])
  })
})
