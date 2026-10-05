import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CLIENT_BUILD_MAX_LENGTH, CLIENT_OUTDATED_REASONS, clientBuildSchema, clientFormatBodyShape, clientFormatQueryShape, clientFormatRequiredBodyShape, clientOutdatedDetailsSchema, compareVersions, parseVersion } from './client-format.ts'

describe('客户端构建与 SDK 版本的写法（x.y.z，可带 + 之后的诊断信息）', () => {
  it.each([
    ['0.1.0', [0, 1, 0]],
    ['1.0.1', [1, 0, 1]],
    ['10.20.30', [10, 20, 30]],
    ['999999999.0.0', [999_999_999, 0, 0]],
    ['0.1.0+abc1234', [0, 1, 0]],
    ['0.1.0+build.7-rc.A1', [0, 1, 0]],
  ])('认得 %s', (value, expected) => {
    expect(parseVersion(value)).toEqual(expected)
    expect(clientBuildSchema.safeParse(value).success).toBe(true)
  })

  it.each([
    '',
    '1',
    '1.0',
    '1.0.0.0',
    '01.0.0',
    '1.00.0',
    '1.0.01',
    '-1.0.0',
    '1.0.0-beta.1',
    '1.0.0+',
    '1.0.0+a..b',
    '1.0.0+a_b',
    ' 1.0.0',
    '1.0.0 ',
    'v1.0.0',
    '1000000000.0.0',
    '1.0.0+中',
  ])('认不出：%j', (value) => {
    expect(parseVersion(value)).toBeUndefined()
    expect(clientBuildSchema.safeParse(value).success).toBe(false)
  })

  it(`长度上限 ${CLIENT_BUILD_MAX_LENGTH}：诊断信息再长也不认`, () => {
    const atLimit = `0.1.0+${'a'.repeat(CLIENT_BUILD_MAX_LENGTH - 6)}`
    expect(parseVersion(atLimit)).toEqual([0, 1, 0])
    expect(parseVersion(`${atLimit}a`)).toBeUndefined()
    expect(clientBuildSchema.safeParse(`${atLimit}a`).success).toBe(false)
  })

  it('比较：按 x、y、z 的数值依次比较（不是字符串的顺序），+ 之后的诊断信息不比较', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.1.0+aaa', '0.1.0+bbb')).toBe(0)
    expect(compareVersions('0.1.9', '0.1.10')).toBeLessThan(0)
    expect(compareVersions('0.10.0', '0.9.99')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0)
  })

  it('任何一个认不出时为 undefined（调用方按不兼容处理）', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeUndefined()
    expect(compareVersions('1.0.0', 'latest')).toBeUndefined()
  })
})

describe('上报的字段：都可选（重放先于拦截旧客户端，旧页面不带它们）', () => {
  const body = z.strictObject(clientFormatBodyShape)
  const query = z.strictObject(clientFormatQueryShape)
  const reported = { clientBuild: '0.1.0+abc1234', univerVersion: '1.0.1', profile: 'sheet@1' }

  it('都不带也通过', () => {
    expect(body.parse({})).toEqual({})
    expect(query.parse({})).toEqual({})
  })

  it('请求体：格式版本是整数；查询参数：格式版本是不带前导零的十进制，转成整数', () => {
    expect(body.parse({ ...reported, formatVersion: 1 })).toEqual({ ...reported, formatVersion: 1 })
    expect(query.parse({ ...reported, formatVersion: '1' })).toEqual({ ...reported, formatVersion: 1 })
    for (const formatVersion of [0, -1, 1.5, '1', 1_000_000_000])
      expect(body.safeParse({ formatVersion }).success, String(formatVersion)).toBe(false)
    for (const formatVersion of ['0', '01', '1.0', '+1', '', '1000000000', 'x'])
      expect(query.safeParse({ formatVersion }).success, formatVersion).toBe(false)
  })

  it('Univer 版本与档案只限字符与长度，不按已知的取值校验：认不出的由服务端回答 CLIENT_OUTDATED，不是 400', () => {
    for (const value of ['1.1.0-beta.0', 'doc@1', 'sheet@2', 'x'])
      expect(body.parse({ univerVersion: value, profile: value })).toEqual({ univerVersion: value, profile: value })
    for (const value of ['', 'a b', 'a/b', '版本', 'x'.repeat(65)])
      expect(body.safeParse({ univerVersion: value }).success, value).toBe(false)
  })

  it('构建按写法校验', () => {
    expect(body.safeParse({ clientBuild: 'abc1234' }).success).toBe(false)
    expect(query.safeParse({ clientBuild: '0.1' }).success).toBe(false)
  })
})

describe('上报的字段都必填的写法（打开自检的上报，M3-P4 设计 §3.13）', () => {
  const required = z.strictObject(clientFormatRequiredBodyShape)
  const reported = { clientBuild: '0.1.0+abc1234', univerVersion: '1.0.1', profile: 'sheet@1', formatVersion: 1 }

  it('四项都带上才通过，每一项的写法与可选的那一份相同', () => {
    expect(required.parse(reported)).toEqual(reported)
    for (const field of Object.keys(reported)) {
      const { [field as keyof typeof reported]: _omitted, ...rest } = reported
      expect(required.safeParse(rest).success, field).toBe(false)
    }
    for (const [field, value] of [['clientBuild', 'abc1234'], ['univerVersion', 'a b'], ['profile', ''], ['formatVersion', '1']] as const)
      expect(required.safeParse({ ...reported, [field]: value }).success, field).toBe(false)
  })
})

describe('CLIENT_OUTDATED 的详情', () => {
  it('原因：format（数据格式不同或没有上报）、build（构建低于运维开关）', () => {
    expect(CLIENT_OUTDATED_REASONS).toEqual(['format', 'build'])
    expect(clientOutdatedDetailsSchema.parse({ reason: 'build' })).toEqual({ reason: 'build' })
  })

  it('响应宽松：不认识的原因、缺少原因解析成 undefined，页面照样说"需要刷新"', () => {
    for (const details of [{ reason: 'sdk' }, {}, { reason: 1 }])
      expect(clientOutdatedDetailsSchema.parse(details), JSON.stringify(details)).toEqual({ reason: undefined })
  })
})
