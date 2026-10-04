import { describe, expect, it } from 'vitest'
import { DOCUMENT_PROFILES } from './documents.ts'
import { checkResources, isDeepEmpty, PROFILE_RESOURCES, profileResourceNames, shrunkResources } from './profile-resources.ts'
import { SHEET_TEMPLATE } from './sheet-template.ts'

/** 全部 10 项都在、都为空的资源（模板的写法） */
const TEMPLATE_RESOURCES = SHEET_TEMPLATE.resources.map(resource => ({ ...resource }))

function withResource(name: string, data: string): { name: string, data: string }[] {
  return TEMPLATE_RESOURCES.map(resource => (resource.name === name ? { name, data } : resource))
}

describe('sheet@1 的资源白名单（插件档案 v1 §3，00 号计划书 §8.2）', () => {
  it('每个档案都有规则；sheet@1 是 10 项，没有 M1-P4 去掉的本地授权服务的资源', () => {
    expect(Object.keys(PROFILE_RESOURCES).sort()).toEqual([...DOCUMENT_PROFILES].sort())
    expect(profileResourceNames('sheet@1')).toEqual([
      'SHEET_CONDITIONAL_FORMATTING_PLUGIN',
      'SHEET_DATA_VALIDATION_PLUGIN',
      'SHEET_DEFINED_NAME_PLUGIN',
      'SHEET_DRAWING_PLUGIN',
      'SHEET_FILTER_PLUGIN',
      'SHEET_NOTE_PLUGIN',
      'SHEET_RANGE_PROTECTION_PLUGIN',
      'SHEET_RANGE_THEME_MODEL_PLUGIN',
      'SHEET_WORKSHEET_PROTECTION_PLUGIN',
      'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN',
    ])
  })

  it('必须为空的 4 项：区域保护、工作表保护、保护点、区域主题', () => {
    const mustBeEmpty = Object.entries(PROFILE_RESOURCES['sheet@1']).filter(([, rule]) => rule.mustBeEmpty).map(([name]) => name).sort()
    expect(mustBeEmpty).toEqual(['SHEET_RANGE_PROTECTION_PLUGIN', 'SHEET_RANGE_THEME_MODEL_PLUGIN', 'SHEET_WORKSHEET_PROTECTION_PLUGIN', 'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN'])
  })

  it('每个键下的值的种类出自各插件的 toJson：条件格式、数据验证与三种保护是规则表（数组），其余是对象', () => {
    const arrays = Object.entries(PROFILE_RESOURCES['sheet@1']).filter(([, rule]) => rule.entries === 'array').map(([name]) => name).sort()
    expect(arrays).toEqual(['SHEET_CONDITIONAL_FORMATTING_PLUGIN', 'SHEET_DATA_VALIDATION_PLUGIN', 'SHEET_RANGE_PROTECTION_PLUGIN', 'SHEET_WORKSHEET_PROTECTION_PLUGIN', 'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN'])
  })

  it('模板的 10 项正好是白名单', () => {
    expect(TEMPLATE_RESOURCES.map(resource => resource.name).sort()).toEqual(profileResourceNames('sheet@1'))
  })
})

describe('深层为空', () => {
  it.each([null, undefined, '', [], {}, [[]], [{}, [null, '']], { 'sheet-1': [] }, { a: { b: [{}, { c: null }] } }])('为空：%j', (value) => {
    expect(isDeepEmpty(value)).toBe(true)
  })

  it.each([0, false, 'x', ' ', [0], { a: false }, { 'sheet-1': [{ id: 'r1' }] }, [[], [[1]]], { a: { b: { c: 'deep' } } }])('不为空：%j', (value) => {
    expect(isDeepEmpty(value)).toBe(false)
  })

  it('逐层迭代，几十万层也不爆栈', () => {
    const depth = 300_000
    expect(isDeepEmpty(JSON.parse(`${'['.repeat(depth)}${']'.repeat(depth)}`))).toBe(true)
    expect(isDeepEmpty(JSON.parse(`${'['.repeat(depth)}0${']'.repeat(depth)}`))).toBe(false)
  })
})

describe('资源检查（checkResources）', () => {
  it('模板通过：10 项都在、都为空', () => {
    expect(checkResources(TEMPLATE_RESOURCES, 'sheet@1')).toEqual({ ok: true, present: profileResourceNames('sheet@1'), nonEmpty: [] })
  })

  it('没有 resources（undefined）按没有资源处理；空数组同样通过', () => {
    expect(checkResources(undefined, 'sheet@1')).toEqual({ ok: true, present: [], nonEmpty: [] })
    expect(checkResources([], 'sheet@1')).toEqual({ ok: true, present: [], nonEmpty: [] })
  })

  it('非空的资源名按名称排序给出；变空不算非空', () => {
    const resources = [
      { name: 'SHEET_NOTE_PLUGIN', data: '{"s1":{"0":{"0":{"note":"备注"}}}}' },
      { name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', data: '{"s1":[{"cfId":"c1"}]}' },
      { name: 'SHEET_FILTER_PLUGIN', data: '{"s1":{}}' },
    ]
    expect(checkResources(resources, 'sheet@1')).toEqual({ ok: true, present: ['SHEET_CONDITIONAL_FORMATTING_PLUGIN', 'SHEET_FILTER_PLUGIN', 'SHEET_NOTE_PLUGIN'], nonEmpty: ['SHEET_CONDITIONAL_FORMATTING_PLUGIN', 'SHEET_NOTE_PLUGIN'] })
  })

  it.each([
    ['不是数组', { SHEET_NOTE_PLUGIN: '{}' }],
    ['null', null],
    ['某一项不是对象', [...TEMPLATE_RESOURCES, 'SHEET_NOTE_PLUGIN']],
    ['某一项是数组', [['SHEET_NOTE_PLUGIN', '{}']]],
    ['data 不是字符串（SDK 的 toJson 只写字符串）', [{ name: 'SHEET_NOTE_PLUGIN', data: {} }]],
    ['data 是 null', [{ name: 'SHEET_NOTE_PLUGIN', data: null }]],
    ['没有 data', [{ name: 'SHEET_NOTE_PLUGIN' }]],
    ['名称不是字符串', [{ name: 1, data: '{}' }]],
  ])('resources 的结构：%s', (_case, resources) => {
    expect(checkResources(resources, 'sheet@1')).toMatchObject({ ok: false, rule: 'resources' })
  })

  it('名称重复（SDK 只取第一条，重复的条目能让伪造的数据生效），哪怕两条都为空', () => {
    expect(checkResources([...TEMPLATE_RESOURCES, { name: 'SHEET_FILTER_PLUGIN', data: '{}' }], 'sheet@1')).toEqual({ ok: false, rule: 'resource-duplicate', resource: 'SHEET_FILTER_PLUGIN' })
  })

  it.each(['SHEET_AuthzIoMockService_PLUGIN', 'SHEET_TABLE_PLUGIN', 'DOC_DRAWING_PLUGIN', '', '__proto__', 'constructor', 'sheet_filter_plugin'])('名称不在白名单里：%j', (name) => {
    expect(checkResources([...TEMPLATE_RESOURCES, { name, data: '' }], 'sheet@1')).toEqual({ ok: false, rule: 'resource-unknown', resource: name })
  })

  it.each([
    ['不是 JSON', 'SHEET_NOTE_PLUGIN', 'not json'],
    ['顶层是数组（深层为空也不行：SDK 按对象读）', 'SHEET_NOTE_PLUGIN', '[]'],
    ['顶层是 null', 'SHEET_FILTER_PLUGIN', 'null'],
    ['顶层是字符串', 'SHEET_DEFINED_NAME_PLUGIN', '"x"'],
    ['顶层是数', 'SHEET_DRAWING_PLUGIN', '0'],
    ['规则表的位置是对象（条件格式展开它时抛错）', 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', '{"s1":{}}'],
    ['规则表的位置是 null', 'SHEET_DATA_VALIDATION_PLUGIN', '{"s1":null}'],
    ['对象的位置是数组', 'SHEET_FILTER_PLUGIN', '{"s1":[]}'],
    ['对象的位置是字符串', 'SHEET_NOTE_PLUGIN', '{"s1":"x"}'],
    ['必须为空的区域保护：规则表的位置是对象', 'SHEET_RANGE_PROTECTION_PLUGIN', '{"s1":{}}'],
    ['必须为空的区域主题：顶层是数组', 'SHEET_RANGE_THEME_MODEL_PLUGIN', '[]'],
  ])('已知资源的最小结构：%s', (_case, name, data) => {
    expect(checkResources(withResource(name, data), 'sheet@1')).toEqual({ ok: false, rule: 'resource-data', resource: name })
  })

  it.each([
    ['空串', ''],
    ['空对象', '{}'],
    ['每个键下是空的规则表（规则删光之后的区域保护）', '{"sheet-1":[],"sheet-2":[]}'],
    ['规则表里只有空的项', '{"sheet-1":[{},{"ranges":[]}]}'],
  ])('必须为空的资源"深层为空"就通过：%s', (_case, data) => {
    expect(checkResources(withResource('SHEET_RANGE_PROTECTION_PLUGIN', data), 'sheet@1')).toMatchObject({ ok: true })
    expect(checkResources(withResource('SHEET_WORKSHEET_PROTECTION_PLUGIN', data), 'sheet@1')).toMatchObject({ ok: true })
  })

  it.each([
    ['SHEET_RANGE_PROTECTION_PLUGIN', '{"sheet-1":[{"id":"r1","ranges":[{"startRow":0}]}]}'],
    ['SHEET_WORKSHEET_PROTECTION_PLUGIN', '{"unit-1":[{"subUnitId":"sheet-1"}]}'],
    ['SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN', '{"unit-1":[{"subUnitId":"sheet-1","permissionId":"p"}]}'],
    ['SHEET_RANGE_THEME_MODEL_PLUGIN', '{"rangeThemeStyleRuleMap":{"t1":{"themeName":"default"}},"rangeThemeStyleMapJson":{}}'],
  ])('必须为空的资源不为空：%s', (name, data) => {
    expect(checkResources(withResource(name, data), 'sheet@1')).toEqual({ ok: false, rule: 'resource-not-empty', resource: name })
  })

  it('按规则的先后给出第一条：结构先于重复、重复先于白名单、白名单先于结构的种类、种类先于必须为空', () => {
    const notEmpty = { name: 'SHEET_RANGE_PROTECTION_PLUGIN', data: '{"s":[{"id":"r"}]}' }
    const badData = { name: 'SHEET_NOTE_PLUGIN', data: 'x' }
    const unknown = { name: 'X', data: '' }
    const duplicate = { name: 'SHEET_FILTER_PLUGIN', data: '' }
    expect(checkResources([notEmpty, badData, unknown, duplicate, duplicate, 'bad'], 'sheet@1')).toMatchObject({ rule: 'resources' })
    expect(checkResources([notEmpty, badData, unknown, duplicate, duplicate], 'sheet@1')).toMatchObject({ rule: 'resource-duplicate' })
    expect(checkResources([notEmpty, badData, unknown, duplicate], 'sheet@1')).toMatchObject({ rule: 'resource-unknown' })
    expect(checkResources([notEmpty, badData, duplicate], 'sheet@1')).toMatchObject({ rule: 'resource-data' })
    expect(checkResources([notEmpty, duplicate], 'sheet@1')).toMatchObject({ rule: 'resource-not-empty' })
  })

  it('多出的键不看（SDK 的类型另允许 id）；data 里的字符串不再当 JSON 解析', () => {
    expect(checkResources([{ name: 'SHEET_NOTE_PLUGIN', data: '{"s1":{"0":{"0":{"note":"[]"}}}}', id: 'x' }], 'sheet@1')).toMatchObject({ ok: true, nonEmpty: ['SHEET_NOTE_PLUGIN'] })
  })

  it('任何输入都不抛出：很深的 data、各种奇怪的值', () => {
    const deep = `{"s1":${'['.repeat(100_000)}${']'.repeat(100_000)}}`
    expect(checkResources([{ name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', data: deep }], 'sheet@1')).toMatchObject({ ok: true, nonEmpty: [] })
    for (const value of [0, 'x', true, {}, [null], [undefined], [[]], [{ name: '__proto__', data: '{}' }]])
      expect(() => checkResources(value, 'sheet@1')).not.toThrow()
  })
})

describe('不缩水（shrunkResources）', () => {
  it('上一版非空的资源这一版不在了：给出它们；变空（在而为空）不算', () => {
    expect(shrunkResources(['SHEET_NOTE_PLUGIN', 'SHEET_FILTER_PLUGIN'], ['SHEET_FILTER_PLUGIN'], 'sheet@1')).toEqual(['SHEET_NOTE_PLUGIN'])
    expect(shrunkResources(['SHEET_NOTE_PLUGIN'], ['SHEET_NOTE_PLUGIN'], 'sheet@1')).toEqual([])
  })

  it('白名单之外的（例如 M1-P4 去掉的本地授权服务的资源）不算缩水', () => {
    expect(shrunkResources(['SHEET_AuthzIoMockService_PLUGIN', 'SHEET_DRAWING_PLUGIN', 'SHEET_NOTE_PLUGIN'], [], 'sheet@1')).toEqual(['SHEET_DRAWING_PLUGIN', 'SHEET_NOTE_PLUGIN'])
  })

  it('上一版没有非空的资源：不会缩水', () => {
    expect(shrunkResources([], [], 'sheet@1')).toEqual([])
  })
})
