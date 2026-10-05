import { describe, expect, it } from 'vitest'
import { compareOpenCheckFailures, errorNameOf, isProfileFailure, OPEN_CHECK_FAILURE_KINDS, PROFILE_FAILURE_KINDS, RESOURCE_NAME_PATTERN, THROWN_FAILURE_KINDS } from './open-check-failures.ts'
import { profileResourceNames } from './profile-resources.ts'

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
    // 写法不区分大小写：压缩之后的类名常是小写开头（M3-P4 审查 B6）
    const minified = Object.create({ constructor: { name: 'e' } }) as object
    expect(errorNameOf(minified)).toBe('e')
    const minifiedLonger = Object.create({ constructor: { name: 'tA$1' } }) as object
    expect(errorNameOf(minifiedLonger)).toBe('tA$1')
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
