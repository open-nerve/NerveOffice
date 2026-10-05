import { describe, expect, it } from 'vitest'
import { compareOpenCheckFailures, errorNameOf, isProfileFailure, OPEN_CHECK_FAILURE_KINDS, OPEN_CHECK_FAILURES_MAX, openCheckFailureSchema, openCheckReportSchema, PROFILE_FAILURE_KINDS, RESOURCE_NAME_PATTERN, THROWN_FAILURE_KINDS } from './open-check.ts'
import { profileResourceNames } from './profile-resources.ts'

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

describe('打开自检的失败种类（M3-P4 设计 §3.11）', () => {
  it('八种，按设计的顺序；档案不全的两种、抛错的三种是其中的子集', () => {
    expect(OPEN_CHECK_FAILURE_KINDS).toEqual(['profile-missing-hook', 'profile-unexpected-hook', 'parse-threw', 'parse-swallowed', 'load-threw', 'serialize-threw', 'resource-missing', 'resource-emptied'])
    expect(OPEN_CHECK_FAILURE_KINDS.filter(isProfileFailure)).toEqual([...PROFILE_FAILURE_KINDS])
    expect(THROWN_FAILURE_KINDS.every(kind => OPEN_CHECK_FAILURE_KINDS.includes(kind))).toBe(true)
  })

  it('失败清单的顺序：种类、资源名、构造器名（没有的在前）', () => {
    const failures = [
      { kind: 'resource-emptied', resource: 'SHEET_NOTE_PLUGIN' },
      { kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'TypeError' },
      { kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN' },
      { kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'SyntaxError' },
      { kind: 'profile-missing-hook', resource: 'SHEET_NOTE_PLUGIN' },
      { kind: 'parse-threw', resource: 'SHEET_DATA_VALIDATION_PLUGIN' },
    ] as const
    expect([...failures].sort(compareOpenCheckFailures)).toEqual([
      failures[4],
      failures[5],
      failures[2],
      failures[3],
      failures[1],
      failures[0],
    ])
  })
})

describe('异常的构造器名（errorNameOf）：只取构造器名，不读 message', () => {
  it('内置与自定义的错误：构造器名；压缩之后的类名也是标识符', () => {
    expect(errorNameOf(new TypeError('x'))).toBe('TypeError')
    expect(errorNameOf(new SyntaxError('Unexpected token \'机\', "{"note": 机密}" is not valid JSON'))).toBe('SyntaxError')
    class Ce extends Error {}
    expect(errorNameOf(new Ce('机密'))).toBe('Ce')
    expect(errorNameOf({})).toBe('Object')
  })

  it('取不到或不合写法时没有：原始值、null、没有原型的对象、构造器名带空格或很长、取原型时抛错', () => {
    expect([undefined, null, 'TypeError: 机密', 5, true].map(errorNameOf)).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(errorNameOf(Object.create(null))).toBeUndefined()
    const spaced = Object.create({ constructor: { name: 'Bad Name: 机密' } }) as object
    expect(errorNameOf(spaced)).toBeUndefined()
    const long = Object.create({ constructor: { name: `E${'x'.repeat(64)}` } }) as object
    expect(errorNameOf(long)).toBeUndefined()
    const trap = new Proxy({}, { getPrototypeOf: () => {
      throw new Error('机密')
    } })
    expect(errorNameOf(trap)).toBeUndefined()
  })

  it('message 一律不进结果：构造器名之外什么都不带', () => {
    const error = new SyntaxError('Unexpected token \'机\', "{"note": 机密}" is not valid JSON')
    expect(JSON.stringify(errorNameOf(error))).not.toContain('机密')
  })
})

describe('资源名的写法（SDK 的 IResourceName）', () => {
  it('档案白名单里的全部名字、文字文档的资源名与带大小写的 SDK 资源名都认得', () => {
    for (const name of [...profileResourceNames('sheet@1'), 'DOC_DRAWING_PLUGIN', 'SHEET_AuthzIoMockService_PLUGIN', 'UNIVER_X_PLUGIN'])
      expect(RESOURCE_NAME_PATTERN.test(name), name).toBe(true)
  })

  it.each(['', 'SHEET_FILTER', 'FILTER_PLUGIN', 'SHEET__PLUGIN', 'sheet_filter_plugin', 'SHEET_FILTER_PLUGIN ', 'SHEET_FILTER-X_PLUGIN', 'SHEET_过滤_PLUGIN', `SHEET_${'X'.repeat(65)}_PLUGIN`, 'OTHER_FILTER_PLUGIN'])('认不出：%j', (name) => {
    expect(RESOURCE_NAME_PATTERN.test(name)).toBe(false)
  })
})

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
