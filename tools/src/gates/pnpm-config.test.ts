import { describe, expect, it } from 'vitest'
import { checkPnpmConfig, checkPnpmfiles } from './pnpm-config.ts'

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
overrides:
  # 去掉只在安装时用到的 gRPC 依赖（ADR）
  '@grpc/grpc-js': '-'
  # 修复漏洞
  minimist: 1.2.8
peerDependencyRules:
  allowedVersions:
    # peer 只声明到 ESLint 9，自测证明可用
    eslint-plugin-jsx-a11y>eslint: 10.11.0
`

function rulesOf(text: string): string[] {
  return checkPnpmConfig(text, policy).map(v => v.rule)
}

describe('US-M1-11 A01 包管理配置', () => {
  it('合规：发布冷却期、可信度策略、引擎严格；逐项的决定与豁免都写明原因', () => {
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

  it.each([
    'dangerouslyAllowAllBuilds: true',
    'minimumReleaseAgeStrict: false',
    'trustPolicyIgnoreAfter: 1440',
    'trustPolicyExclude:\n  - some-package',
    'auditConfig:\n  ignoreGhsas:\n    - GHSA-aaaa-bbbb-cccc',
  ])('违规：没有评审过、可能削弱策略的设置 %s', (setting) => {
    expect(rulesOf(`${valid}${setting}\n`)).toEqual(['pnpm-config/unreviewed-setting'])
  })

  it('违规：安装脚本还没有明确的决定（pnpm 写入的占位）', () => {
    expect(rulesOf(valid.replace('lefthook: false', 'lefthook: set this to true or false'))).toEqual(['pnpm-config/allow-builds-decision'])
  })

  it.each([
    ['安装脚本的第一项', valid.replace('  # 只安装 git 钩子\n', ''), 'pnpm-config/allow-builds-reason'],
    ['安装脚本的后面一项', valid.replace('  # 原生绑定由可选依赖提供\n', ''), 'pnpm-config/allow-builds-reason'],
    ['发布冷却期的豁免', valid.replace('  # 紧急安全修复，见 GHSA-xxxx\n', ''), 'pnpm-config/release-age-exclude-reason'],
    ['overrides', valid.replace('  # 修复漏洞\n', ''), 'pnpm-config/override-reason'],
    ['peer 规则', valid.replace('    # peer 只声明到 ESLint 9，自测证明可用\n', ''), 'pnpm-config/peer-rule-reason'],
  ])('违规：%s缺少原因', (_case, text, rule) => {
    expect(rulesOf(text)).toEqual([rule])
  })

  it.each(['*', 'foo', '@scope/*', 'foo@^1.2.3', 'foo@1.x'])('违规：冷却期豁免不是"包名@精确版本"：%s', (entry) => {
    expect(rulesOf(valid.replace('  - foo@1.2.3', `  - '${entry}'`))).toEqual(['pnpm-config/release-age-exclude-exact'])
  })

  it('合规：带作用域的包名@精确版本', () => {
    expect(rulesOf(valid.replace('  - foo@1.2.3', '  - \'@scope/pkg@2.0.0-rc.1\''))).toEqual([])
  })

  it.each(['^1.2.8', '1.x', 'latest'])('违规：overrides 不是精确版本 %s', (version) => {
    expect(rulesOf(valid.replace('minimist: 1.2.8', `minimist: '${version}'`))).toEqual(['pnpm-config/override-version'])
  })

  it('违规：文件无法解析', () => {
    expect(rulesOf('allowBuilds: [\n')).toEqual(['pnpm-config/parse'])
  })
})

describe('US-M1-11 A01 pnpmfile', () => {
  it('合规：仓库根目录没有 pnpmfile', () => {
    expect(checkPnpmfiles([])).toEqual([])
  })

  it('违规：出现 pnpmfile', () => {
    expect(checkPnpmfiles(['.pnpmfile.cjs', '.pnpmfile.mjs']).map(v => v.rule)).toEqual(['pnpm-config/pnpmfile', 'pnpm-config/pnpmfile'])
  })
})
