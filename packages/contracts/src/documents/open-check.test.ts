import { describe, expect, it } from 'vitest'
import { OPEN_CHECK_FAILURE_KINDS, OPEN_CHECK_FAILURES_MAX, THROWN_FAILURE_KINDS } from './open-check-failures.ts'
import { openCheckFailureSchema, openCheckReportSchema } from './open-check.ts'

/** 一次合法的上报：页面的构建与数据格式都带上 */
const REPORT = {
  revision: 3,
  access: 'read',
  trigger: 'open',
  failures: [{ kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'SyntaxError' }],
  clientBuild: '0.1.0+abc1234',
  univerVersion: '1.0.1',
  profile: 'sheet@1',
  formatVersion: 1,
} as const

function report(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...REPORT, ...overrides }
}

describe('一项失败（请求里，严格）', () => {
  it('合法：每一种都可以只有种类与资源名；抛错的三种可以带构造器名', () => {
    for (const kind of OPEN_CHECK_FAILURE_KINDS)
      expect(openCheckFailureSchema.safeParse({ kind, resource: 'SHEET_NOTE_PLUGIN' }).success, kind).toBe(true)
    for (const kind of THROWN_FAILURE_KINDS)
      expect(openCheckFailureSchema.parse({ kind, resource: 'SHEET_NOTE_PLUGIN', error: 'TypeError' })).toEqual({ kind, resource: 'SHEET_NOTE_PLUGIN', error: 'TypeError' })
  })

  it.each([
    ['不认识的种类', { kind: 'resource-changed', resource: 'SHEET_NOTE_PLUGIN' }],
    ['没有资源名', { kind: 'resource-missing' }],
    ['资源名不合写法', { kind: 'resource-missing', resource: 'note' }],
    ['构造器名带空格与冒号（message 的写法）', { kind: 'parse-threw', resource: 'SHEET_NOTE_PLUGIN', error: 'SyntaxError: Unexpected token' }],
    ['构造器名带引号', { kind: 'parse-threw', resource: 'SHEET_NOTE_PLUGIN', error: '"x"' }],
    ['构造器名超长', { kind: 'parse-threw', resource: 'SHEET_NOTE_PLUGIN', error: `E${'x'.repeat(64)}` }],
    ['不是抛错的种类带构造器名', { kind: 'resource-emptied', resource: 'SHEET_NOTE_PLUGIN', error: 'TypeError' }],
    ['多出的字段：message', { kind: 'parse-threw', resource: 'SHEET_NOTE_PLUGIN', message: '机密' }],
    ['多出的字段：data', { kind: 'resource-emptied', resource: 'SHEET_NOTE_PLUGIN', data: '{"s1":{}}' }],
  ])('不合法：%s', (_case, failure) => {
    expect(openCheckFailureSchema.safeParse(failure).success).toBe(false)
  })
})

describe('打开自检失败的上报（请求体，严格）', () => {
  it('合法的上报原样解析出来', () => {
    expect(openCheckReportSchema.parse(REPORT)).toEqual(REPORT)
  })

  it('打开方式与起因的枚举：每一种都合法', () => {
    for (const access of ['read', 'edit'])
      expect(openCheckReportSchema.safeParse(report({ access })).success, access).toBe(true)
    for (const trigger of ['open', 'enter', 'refresh', 'exit', 'lost', 'reload'])
      expect(openCheckReportSchema.safeParse(report({ trigger })).success, trigger).toBe(true)
  })

  it(`失败清单 1–${OPEN_CHECK_FAILURES_MAX} 项`, () => {
    const failure = { kind: 'resource-missing', resource: 'SHEET_NOTE_PLUGIN' }
    expect(openCheckReportSchema.safeParse(report({ failures: Array.from({ length: OPEN_CHECK_FAILURES_MAX }).fill(failure) })).success).toBe(true)
    expect(openCheckReportSchema.safeParse(report({ failures: Array.from({ length: OPEN_CHECK_FAILURES_MAX + 1 }).fill(failure) })).success).toBe(false)
    expect(openCheckReportSchema.safeParse(report({ failures: [] })).success).toBe(false)
  })

  it.each([
    ['修订号为 0', { revision: 0 }],
    ['修订号不是整数', { revision: 1.5 }],
    ['修订号超过数据库的 integer', { revision: 2_147_483_648 }],
    ['修订号是字符串', { revision: '3' }],
    ['不认识的打开方式', { access: 'write' }],
    ['不认识的起因', { trigger: 'save' }],
    ['构建不合写法', { clientBuild: 'abc1234' }],
    ['Univer 版本带空格', { univerVersion: '1.0 1' }],
    ['格式版本为 0', { formatVersion: 0 }],
    ['多出的字段：message', { message: 'Unexpected token' }],
    ['多出的字段：snapshot', { snapshot: '{"id":"u"}' }],
    ['失败清单不是数组', { failures: { kind: 'resource-missing', resource: 'SHEET_NOTE_PLUGIN' } }],
  ])('不合法：%s', (_case, overrides) => {
    expect(openCheckReportSchema.safeParse(report(overrides)).success).toBe(false)
  })

  it.each(['revision', 'access', 'trigger', 'failures', 'clientBuild', 'univerVersion', 'profile', 'formatVersion'])('缺 %s 不合法（版本四项必填：上报只作诊断，要分得出是哪个版本的页面报的）', (field) => {
    const { [field as keyof typeof REPORT]: _omitted, ...rest } = REPORT
    expect(openCheckReportSchema.safeParse(rest).success).toBe(false)
  })
})
