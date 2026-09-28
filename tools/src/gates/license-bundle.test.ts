import type { BundledPackages } from './license-bundle.ts'
import { describe, expect, it } from 'vitest'
import { bundledPackagesSchema, checkLicenseBundle, checkLicenseText, checkLicenseTextFile } from './license-bundle.ts'

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

describe('US-M1-11 A01 随产物分发的许可正文（Codex 评审 CX9）', () => {
  /** 与 web 构建的插件（apps/web/build/third-party-licenses.ts 的 renderLicenses）同样的写法 */
  function render(sections: readonly { name: string, version?: string, license: string, text: string }[]): string {
    return `# 第三方许可\n\n本产品的前端构建产物（含 Worker）包含以下第三方软件。\n\n${sections.map(s => `## ${s.name} ${s.version ?? '1.0.0'}（${s.license}）\n\n${s.text}\n`).join('\n')}`
  }
  const packages = [pkg('react', 'MIT'), pkg('@univerjs/protocol', 'Apache-2.0', 'supplement')]
  const text = render([
    { name: 'react', license: 'MIT', text: 'MIT License\n\n## 许可正文自己的 Markdown 标题不算一节\n\nCopyright (c) Meta' },
    { name: '@univerjs/protocol', license: 'Apache-2.0', text: 'Apache License 2.0' },
  ])

  it('合规：清单里的每个包都有一节，许可一致，有正文', () => {
    expect(checkLicenseText(packages, text)).toEqual([])
  })

  it('违规：产物里没有许可正文的文件，或者文件是空的', () => {
    expect(checkLicenseText(packages, undefined).map(v => v.rule)).toEqual(['license-bundle/missing-text-file'])
    expect(checkLicenseText(packages, '  \n').map(v => v.rule)).toEqual(['license-bundle/missing-text-file'])
    expect(checkLicenseTextFile(text)).toEqual([])
  })

  it('违规：清单里的包在正文里没有一节、许可不一致、说有正文却只有占位', () => {
    const outcome = checkLicenseText([...packages, pkg('scheduler', 'MIT')], render([
      { name: 'react', license: 'ISC', text: 'ISC License' },
      { name: '@univerjs/protocol', license: 'Apache-2.0', text: '（缺少许可正文）' },
    ]))
    expect(outcome.map(v => `${v.rule} ${v.subject}`)).toEqual([
      'license-bundle/text-mismatch THIRD-PARTY-LICENSES.md react@1.0.0',
      'license-bundle/text-mismatch THIRD-PARTY-LICENSES.md @univerjs/protocol@1.0.0',
      'license-bundle/text-mismatch THIRD-PARTY-LICENSES.md scheduler@1.0.0',
    ])
  })

  it('违规：正文里有清单之外的包（两份文件不是同一次构建写出的）；版本不同也算', () => {
    const outcome = checkLicenseText([pkg('react', 'MIT')], render([
      { name: 'react', version: '2.0.0', license: 'MIT', text: 'MIT License' },
    ]))
    expect(outcome.map(v => `${v.rule} ${v.subject}`)).toEqual([
      'license-bundle/text-mismatch THIRD-PARTY-LICENSES.md react@1.0.0',
      'license-bundle/text-mismatch THIRD-PARTY-LICENSES.md react@2.0.0',
    ])
  })

  it('没有许可正文的包（清单里 licenseTextSource 为 null）由清单的检查报出，正文里的占位不重复报', () => {
    expect(checkLicenseText([pkg('franc-min', 'MIT', null)], render([{ name: 'franc-min', license: 'MIT', text: '（缺少许可正文）' }]))).toEqual([])
  })
})
