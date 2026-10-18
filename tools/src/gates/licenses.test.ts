import type { LicenseEntry } from './pnpm-outputs.ts'
import { describe, expect, it } from 'vitest'
import { collectInstalled } from './dependency-graph.ts'
import { readFixture } from './fixtures.ts'
import { checkDevelopmentLicenses, checkProductionLicenses, flattenLicenseReport, isAllowedIn, licensesByPath, satisfies } from './licenses.ts'
import { licenseReportSchema, lsOutputSchema } from './pnpm-outputs.ts'

const allowed = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', '0BSD']
const isAllowed = isAllowedIn(allowed)
const everywhere = (): boolean => true

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
  it('有版本限制的例外仅接受审核的安装版本，不因报告合并版本或其他平台而扩大', () => {
    const name = '@img/sharp-libvips-linux-x64'
    const license = 'LGPL-3.0-or-later'
    const exceptions = [{ name, version: '1.3.4', license, reason: 'ADR-021 的明确版本' }]
    const item = { ...entry(name, license), versions: ['1.3.4', '1.3.5'] }
    const path = item.paths[0]!
    const byPath = new Map([[path, item]])
    expect(checkProductionLicenses([{ name, version: '1.3.4', path }], byPath, allowed, exceptions, everywhere)).toEqual([])
    expect(checkProductionLicenses([{ name, version: '1.3.5', path }], byPath, allowed, exceptions, everywhere).map(v => v.rule)).toEqual(['licenses/production'])
    const anotherPlatform = { ...entry('@img/sharp-libvips-linuxmusl-x64', license), versions: ['1.3.4'] }
    expect(checkProductionLicenses([{ name: anotherPlatform.name, version: '1.3.4', path }], new Map([[path, anotherPlatform]]), allowed, exceptions, everywhere).map(v => v.rule)).toEqual(['licenses/production'])
    expect(checkProductionLicenses([{ name, version: '1.3.4', path }], new Map([[path, { ...item, license: 'GPL-3.0-only' }]]), allowed, exceptions, everywhere).map(v => v.rule)).toEqual(['licenses/production'])
  })

  it('合规：生产依赖图里的每个安装实例（含可选依赖）都能在许可清单里查到，并且在白名单里（真实输出）', () => {
    const { installed } = collectInstalled(lsOutputSchema.parse(readFixture('pnpm-12/ls-optional-dependencies.json')))
    const byPath = licensesByPath(licenseReportSchema.parse(readFixture('pnpm-12/licenses-list-optional-dependencies.json')))
    expect(checkProductionLicenses(installed, byPath, allowed, [], everywhere)).toEqual([])
  })

  it('违规：可选依赖的许可不在白名单里', () => {
    const { installed } = collectInstalled(lsOutputSchema.parse(readFixture('pnpm-12/ls-optional-dependencies.json')))
    const report = licenseReportSchema.parse(readFixture('pnpm-12/licenses-list-optional-dependencies.json'))
    const pgTypes = flattenLicenseReport(report).find(e => e.name === 'pg-types')!
    const byPath = licensesByPath({ ...report, 'GPL-3.0': [{ ...pgTypes, license: 'GPL-3.0' }] })
    expect(checkProductionLicenses(installed, byPath, allowed, [], everywhere).map(v => `${v.rule} ${v.subject}`)).toEqual(['licenses/production pg-types@2.2.0'])
  })

  it('平台专属的可选依赖：本机没装的跳过，装了的照常检查（真实输出：sharp 在 macOS arm64 上）', () => {
    const { installed } = collectInstalled(lsOutputSchema.parse(readFixture('pnpm-12/ls-platform-optional.json')))
    const byPath = licensesByPath(licenseReportSchema.parse(readFixture('pnpm-12/licenses-list-platform-optional.json')))
    const onThisMachine = new Set(readFixture('pnpm-12/ls-platform-optional.installed-paths.json') as string[])
    const violations = checkProductionLicenses(installed, byPath, allowed, [], path => onThisMachine.has(path))
    expect(installed.length).toBeGreaterThan(onThisMachine.size)
    expect(violations.map(v => `${v.rule} ${v.subject}`)).toEqual(['licenses/production @img/sharp-libvips-darwin-arm64@1.2.3'])
  })

  it('违规：许可清单里找不到某个安装实例', () => {
    const installed = [{ name: 'ghost', version: '1.0.0', path: '/repo/node_modules/.pnpm/ghost@1.0.0/node_modules/ghost' }]
    expect(checkProductionLicenses(installed, new Map(), allowed, [], everywhere).map(v => v.rule)).toEqual(['licenses/not-listed'])
  })

  it.each(['GPL-3.0', 'MPL-2.0', 'CC-BY-4.0', 'Unknown', ''])('违规：生产依赖的许可 %s 不在白名单', (license) => {
    const item = entry('bad', license)
    const installed = [{ name: item.name, version: '1.0.0', path: item.paths[0]! }]
    expect(checkProductionLicenses(installed, new Map([[item.paths[0]!, item]]), allowed, [], everywhere).map(v => v.rule)).toEqual(['licenses/production'])
  })

  it('合规：登记过的例外；许可与登记的不同时不放行', () => {
    const exceptions = [{ name: 'special', license: 'MPL-2.0', reason: '已评审' }]
    const good = entry('special', 'MPL-2.0')
    const bad = entry('special', 'GPL-3.0')
    const installed = [{ name: 'special', version: '1.0.0', path: good.paths[0]! }]
    expect(checkProductionLicenses(installed, new Map([[good.paths[0]!, good]]), allowed, exceptions, everywhere)).toEqual([])
    expect(checkProductionLicenses(installed, new Map([[bad.paths[0]!, bad]]), allowed, exceptions, everywhere).map(v => v.rule)).toEqual(['licenses/production'])
  })
})

describe('US-M1-11 A01 开发依赖的许可', () => {
  it('开发报告合并多个版本时，未审核的版本不能借用已审核版本的例外', () => {
    const item = { ...entry('versioned-tool', 'GPL-3.0-only'), versions: ['1.0.0'] }
    const exceptions = [{ name: item.name, version: '1.0.0', license: item.license, reason: '测试限定版本语义' }]
    expect(checkDevelopmentLicenses([item], exceptions)).toEqual([])
    expect(checkDevelopmentLicenses([{ ...item, versions: ['1.0.0', '1.0.1'] }], exceptions).map(v => v.rule)).toEqual(['licenses/development'])
    expect(checkDevelopmentLicenses([{ ...item, versions: [] }], exceptions).map(v => v.rule)).toEqual(['licenses/development'])
  })

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
