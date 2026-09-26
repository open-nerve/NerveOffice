import { describe, expect, it } from 'vitest'
import { checkPnpmConfig } from './pnpm-config.ts'

const policy = { minimumReleaseAgeMinutes: 4320, trustPolicy: 'no-downgrade' } as const

const valid = `minimumReleaseAge: 4320
trustPolicy: no-downgrade
engineStrict: true
allowBuilds:
  # 只安装 git 钩子
  lefthook: false
  # 原生绑定由可选依赖提供
  unrs-resolver: false
minimumReleaseAgeExclude:
  # 紧急安全修复，见 GHSA-xxxx
  - foo@1.2.3
`

function rulesOf(text: string): string[] {
  return checkPnpmConfig(text, policy).map(v => v.rule)
}

describe('US-M1-11 A01 包管理配置', () => {
  it('合规：发布冷却期、可信度策略、引擎严格、安装脚本逐个决定并写明原因', () => {
    expect(rulesOf(valid)).toEqual([])
  })

  it.each([
    ['没有设置', valid.replace('minimumReleaseAge: 4320\n', '')],
    ['少于 3 天', valid.replace('minimumReleaseAge: 4320', 'minimumReleaseAge: 1440')],
    ['不是数字', valid.replace('minimumReleaseAge: 4320', 'minimumReleaseAge: "4320"')],
  ])('违规：发布冷却期%s', (_case, text) => {
    expect(rulesOf(text)).toEqual(['pnpm-config/minimum-release-age'])
  })

  it('违规：没有设置 trustPolicy', () => {
    expect(rulesOf(valid.replace('trustPolicy: no-downgrade\n', ''))).toEqual(['pnpm-config/trust-policy'])
  })

  it('违规：engineStrict 不是 true', () => {
    expect(rulesOf(valid.replace('engineStrict: true', 'engineStrict: false'))).toEqual(['pnpm-config/engine-strict'])
  })

  it('违规：安装脚本还没有明确的决定（pnpm 写入的占位）', () => {
    expect(rulesOf(valid.replace('lefthook: false', 'lefthook: set this to true or false'))).toEqual(['pnpm-config/allow-builds-decision'])
  })

  it.each([
    ['第一项', valid.replace('  # 只安装 git 钩子\n', '')],
    ['后面的一项', valid.replace('  # 原生绑定由可选依赖提供\n', '')],
  ])('违规：安装脚本的决定缺少原因（%s）', (_case, text) => {
    expect(rulesOf(text)).toEqual(['pnpm-config/allow-builds-reason'])
  })

  it('违规：发布冷却期的豁免缺少原因', () => {
    expect(rulesOf(valid.replace('  # 紧急安全修复，见 GHSA-xxxx\n', ''))).toEqual(['pnpm-config/release-age-exclude-reason'])
  })

  it('违规：文件无法解析', () => {
    expect(rulesOf('allowBuilds: [\n')).toEqual(['pnpm-config/parse'])
  })
})
