import type { BundledPackages } from './license-bundle.ts'
import { describe, expect, it } from 'vitest'
import { bundledPackagesSchema, checkLicenseBundle } from './license-bundle.ts'

const allowed = ['MIT', 'Apache-2.0']

function pkg(name: string, license: string, licenseTextSource: 'package' | 'supplement' | null = 'package'): BundledPackages[number] {
  return { name, version: '1.0.0', license, licenseTextSource }
}

describe('US-M1-11 A01 第三方许可清单', () => {
  it('合规：每个包都有许可正文（自带或仓库补齐），许可在白名单里', () => {
    expect(checkLicenseBundle([pkg('react', 'MIT'), pkg('@univerjs/protocol', 'Apache-2.0', 'supplement')], allowed, [])).toEqual([])
  })

  it('违规：打进产物的包缺少许可正文，仓库也没有补齐', () => {
    expect(checkLicenseBundle([pkg('franc-min', 'MIT', null)], allowed, []).map(v => `${v.rule} ${v.subject}`)).toEqual(['license-bundle/missing-text franc-min@1.0.0'])
  })

  it.each(['GPL-3.0', 'Unknown'])('违规：打进产物的包的许可 %s 不在白名单里', (license) => {
    expect(checkLicenseBundle([pkg('x', license)], allowed, []).map(v => v.rule)).toEqual(['license-bundle/license'])
  })

  it('合规：登记过的许可例外，与依赖许可检查同一口径', () => {
    expect(checkLicenseBundle([pkg('special', 'MPL-2.0')], allowed, [{ name: 'special', license: 'MPL-2.0', reason: '已评审' }])).toEqual([])
  })

  it('违规：清单是空的（构建没有挂上收集插件）', () => {
    expect(checkLicenseBundle([], allowed, []).map(v => v.rule)).toEqual(['license-bundle/empty'])
  })

  it('拒绝结构不对的清单', () => {
    expect(() => bundledPackagesSchema.parse([{ name: 'x', version: '1', license: 'MIT', licenseTextSource: 'guess' }])).toThrow()
  })
})
