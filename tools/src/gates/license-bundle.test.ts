import { describe, expect, it } from 'vitest'
import { checkLicenseBundle, parseLicenseMarkdown } from './license-bundle.ts'

const markdown = `# Licenses

The app bundles dependencies which contain the following licenses:

## react - 19.3.0 (MIT)

MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

## @univerjs/protocol - 1.0.0 (Apache-2.0)

## franc-min - 6.2.0 (MIT)

## scheduler - 0.28.0 (MIT)

MIT License
`

const allowed = ['MIT', 'Apache-2.0']

describe('parseLicenseMarkdown', () => {
  it('解析 Vite 的第三方许可清单：包名、版本、许可、是否带许可正文', () => {
    expect(parseLicenseMarkdown(markdown)).toEqual([
      { name: 'react', version: '19.3.0', license: 'MIT', hasText: true },
      { name: '@univerjs/protocol', version: '1.0.0', license: 'Apache-2.0', hasText: false },
      { name: 'franc-min', version: '6.2.0', license: 'MIT', hasText: false },
      { name: 'scheduler', version: '0.28.0', license: 'MIT', hasText: true },
    ])
  })
})

describe('US-M1-11 A01 第三方许可清单', () => {
  const sections = parseLicenseMarkdown(markdown)

  it('合规：缺少正文的包都由仓库补齐', () => {
    expect(checkLicenseBundle(sections, new Set(['@univerjs/protocol', 'franc-min']), allowed)).toEqual([])
  })

  it('违规：打进产物的包缺少许可正文，仓库也没有补齐', () => {
    const violations = checkLicenseBundle(sections, new Set(['@univerjs/protocol']), allowed)
    expect(violations.map(v => `${v.rule} ${v.subject}`)).toEqual(['license-bundle/missing-text franc-min@6.2.0'])
  })

  it('违规：打进产物的包的许可不在生产依赖的白名单里', () => {
    const violations = checkLicenseBundle([{ name: 'x', version: '1.0.0', license: 'GPL-3.0', hasText: true }], new Set(), allowed)
    expect(violations.map(v => v.rule)).toEqual(['license-bundle/license'])
  })

  it('违规：清单是空的（构建没有开启 build.license）', () => {
    expect(checkLicenseBundle(parseLicenseMarkdown('# Licenses\n'), new Set(), allowed).map(v => v.rule)).toEqual(['license-bundle/empty'])
  })
})
