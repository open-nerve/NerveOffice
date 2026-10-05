// 打开自检的判定（M3-P4 设计 §3.11）：直接喂事实。场景按设计前的探索 B 在三个浏览器上实测到的（p4b-probe-summary.txt）
import type { OpenCheckFailure } from '@nerve-office/contracts'
import type { CapturedResources, CreatedFacts } from './open-check.ts'
import { profileResourceNames, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { checkCreated, failuresOf, hookSetFailures, openCheckOf, recheckReady } from './open-check.ts'

const ALL_HOOKS = profileResourceNames('sheet@1')

/** 只读样本的形状：六项内容资源非空，其余为空 */
const SAMPLE = [
  ...SHEET_TEMPLATE.resources.filter(item => !['SHEET_CONDITIONAL_FORMATTING_PLUGIN', 'SHEET_NOTE_PLUGIN', 'SHEET_FILTER_PLUGIN', 'SHEET_DATA_VALIDATION_PLUGIN', 'SHEET_DEFINED_NAME_PLUGIN', 'SHEET_DRAWING_PLUGIN'].includes(item.name)),
  { name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', data: '{"s1":[{"cfId":"c1","ranges":[{"startRow":0}]}]}' },
  { name: 'SHEET_NOTE_PLUGIN', data: '{"s1":{"0":{"7":{"note":"综合样本中的备注"}}}}' },
  { name: 'SHEET_FILTER_PLUGIN', data: '{"s2":{"ref":{"startRow":0,"endRow":19}}}' },
  { name: 'SHEET_DATA_VALIDATION_PLUGIN', data: '{"s1":[{"uid":"d1","type":"list"}]}' },
  { name: 'SHEET_DEFINED_NAME_PLUGIN', data: '{"n1":{"id":"n1","name":"数量合计区"}}' },
  { name: 'SHEET_DRAWING_PLUGIN', data: '{"s1":{"data":{"d1":{"drawingId":"d1"}},"order":["d1"]}}' },
]

type Resources = readonly { readonly name: string, readonly data: string }[]

/** 加载之后的捕获：给定的资源原样输出（模拟正常的加载） */
function capturedAs(resources: Resources, failures: readonly OpenCheckFailure[] = []): CapturedResources {
  return { outputs: resources.map(({ name, data }) => ({ name, data })), failures }
}

function replaced(resources: Resources, name: string, data: string): Resources {
  return resources.map(item => (item.name === name ? { name, data } : item))
}

function facts(overrides: Partial<CreatedFacts> = {}): CreatedFacts {
  return { profile: 'sheet@1', hookNames: ALL_HOOKS, loadFailures: [], resourcesBefore: SAMPLE, captured: capturedAs(SAMPLE), ...overrides }
}

describe('通过：模板、样本，加载之后原样（无误报）', () => {
  it('模板：十个 hook 都在，资源全空', () => {
    expect(checkCreated(facts({ resourcesBefore: SHEET_TEMPLATE.resources, captured: capturedAs(SHEET_TEMPLATE.resources) }))).toEqual({ ok: true })
  })

  it('样本：六项资源非空、加载之后都在；就绪之后再核对仍通过', () => {
    const created = checkCreated(facts())
    expect(created).toEqual({ ok: true })
    expect(recheckReady(created, { profile: 'sheet@1', hookNames: ALL_HOOKS, loadFailures: [] })).toEqual({ ok: true })
  })

  it('内容有变化（SDK 合法地补上字段）不算；原来为空的加载之后不在也不算', () => {
    const after = replaced(SAMPLE, 'SHEET_NOTE_PLUGIN', '{"s1":{"0":{"7":{"note":"综合样本中的备注","width":160}}}}').filter(item => item.name !== 'SHEET_RANGE_PROTECTION_PLUGIN')
    expect(checkCreated(facts({ captured: capturedAs(after) }))).toEqual({ ok: true })
  })
})

describe('档案完整性：表格的资源 hook 与白名单', () => {
  it('缺的（插件组没有注册）：profile-missing-hook；资源原来非空时另有 resource-missing（只读样本上的"没有备注组"）', () => {
    const hookNames = ALL_HOOKS.filter(name => name !== 'SHEET_NOTE_PLUGIN')
    const after = SAMPLE.filter(item => item.name !== 'SHEET_NOTE_PLUGIN')
    expect(checkCreated(facts({ hookNames, captured: capturedAs(after) }))).toEqual({ ok: false, failures: [
      { kind: 'profile-missing-hook', resource: 'SHEET_NOTE_PLUGIN' },
      { kind: 'resource-missing', resource: 'SHEET_NOTE_PLUGIN' },
    ] })
  })

  it('模板上缺一组（资源本来为空）：只有 profile-missing-hook——档案完整性必须独立于文档的内容', () => {
    const hookNames = ALL_HOOKS.filter(name => name !== 'SHEET_FILTER_PLUGIN')
    const after = SHEET_TEMPLATE.resources.filter(item => item.name !== 'SHEET_FILTER_PLUGIN')
    expect(checkCreated(facts({ hookNames, resourcesBefore: SHEET_TEMPLATE.resources, captured: capturedAs(after) }))).toEqual({ ok: false, failures: [
      { kind: 'profile-missing-hook', resource: 'SHEET_FILTER_PLUGIN' },
    ] })
  })

  it('多的（白名单之外的表格 hook）：profile-unexpected-hook；它的加载、序列化问题不另报（档案完整性已经报了）', () => {
    const hookNames = [...ALL_HOOKS, 'SHEET_AuthzIoMockService_PLUGIN']
    const failures = [{ kind: 'serialize-threw', resource: 'SHEET_AuthzIoMockService_PLUGIN', error: 'TypeError' }] as const
    const loadFailures = [{ kind: 'load-threw', resource: 'SHEET_AuthzIoMockService_PLUGIN' }] as const
    expect(checkCreated(facts({ hookNames, loadFailures, captured: capturedAs(SAMPLE, failures) }))).toEqual({ ok: false, failures: [
      { kind: 'profile-unexpected-hook', resource: 'SHEET_AuthzIoMockService_PLUGIN' },
    ] })
  })

  it('hookSetFailures：两个方向都列出', () => {
    expect(hookSetFailures('sheet@1', ['SHEET_NOTE_PLUGIN', 'SHEET_X_PLUGIN'])).toEqual([
      ...ALL_HOOKS.filter(name => name !== 'SHEET_NOTE_PLUGIN').map(resource => ({ kind: 'profile-missing-hook', resource })),
      { kind: 'profile-unexpected-hook', resource: 'SHEET_X_PLUGIN' },
    ])
  })
})

describe('数据载入不完整：守卫记下的、资源比较与序列化', () => {
  it('截断的筛选（裸 JSON.parse 抛错）：parse-threw 与构造器名，加上 resource-emptied', () => {
    const before = replaced(SAMPLE, 'SHEET_FILTER_PLUGIN', '{"s2":{"ref":{"sta')
    const after = replaced(SAMPLE, 'SHEET_FILTER_PLUGIN', '{}')
    const loadFailures = [{ kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'SyntaxError' }] as const
    expect(checkCreated(facts({ resourcesBefore: before, loadFailures, captured: capturedAs(after) }))).toEqual({ ok: false, failures: [
      { kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'SyntaxError' },
      { kind: 'resource-emptied', resource: 'SHEET_FILTER_PLUGIN' },
    ] })
  })

  it('截断的条件格式（插件吞成 {}）：parse-swallowed 与 resource-emptied', () => {
    const before = replaced(SAMPLE, 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', '{"s1":[{"cfId":"c1","ra')
    const after = replaced(SAMPLE, 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', '')
    const loadFailures = [{ kind: 'parse-swallowed', resource: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN' }] as const
    expect(checkCreated(facts({ resourcesBefore: before, loadFailures, captured: capturedAs(after) }))).toEqual({ ok: false, failures: [
      { kind: 'parse-swallowed', resource: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN' },
      { kind: 'resource-emptied', resource: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN' },
    ] })
  })

  it('{表:5} 的备注静默装不进（守卫没有记录）：只有资源比较认得出——resource-emptied', () => {
    const before = replaced(SAMPLE, 'SHEET_NOTE_PLUGIN', '{"s1":5}')
    const after = replaced(SAMPLE, 'SHEET_NOTE_PLUGIN', '{}')
    expect(checkCreated(facts({ resourcesBefore: before, captured: capturedAs(after) }))).toEqual({ ok: false, failures: [
      { kind: 'resource-emptied', resource: 'SHEET_NOTE_PLUGIN' },
    ] })
  })

  it('{表:5} 的筛选：加载不报错、toJson 抛错——serialize-threw；hook 在，不另报 resource-missing', () => {
    const before = replaced(SAMPLE, 'SHEET_FILTER_PLUGIN', '{"s2":5}')
    const after = SAMPLE.filter(item => item.name !== 'SHEET_FILTER_PLUGIN')
    const thrown = [{ kind: 'serialize-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'TypeError' }] as const
    expect(checkCreated(facts({ resourcesBefore: before, captured: capturedAs(after, thrown) }))).toEqual({ ok: false, failures: [
      { kind: 'serialize-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'TypeError' },
    ] })
  })

  it('白名单之外的名字的加载问题不算（例如快照里夹带的文字文档资源，SDK 的 loadResources 不按 business 过滤）', () => {
    const loadFailures = [{ kind: 'parse-threw', resource: 'DOC_DRAWING_PLUGIN', error: 'SyntaxError' }] as const
    expect(checkCreated(facts({ loadFailures }))).toEqual({ ok: true })
  })
})

describe('就绪之后的再核对', () => {
  it('创建时通过、就绪时少了一个 hook（SDK 把它撤掉了）：profile-missing-hook', () => {
    const created = checkCreated(facts())
    const ready = recheckReady(created, { profile: 'sheet@1', hookNames: ALL_HOOKS.filter(name => name !== 'SHEET_DRAWING_PLUGIN'), loadFailures: [] })
    expect(ready).toEqual({ ok: false, failures: [{ kind: 'profile-missing-hook', resource: 'SHEET_DRAWING_PLUGIN' }] })
  })

  it('创建时缺、就绪时补上了（SDK 把注册挪到更晚）：创建时的失败照样保留——升级时由无误报的回归先发现', () => {
    const created = checkCreated(facts({ hookNames: ALL_HOOKS.filter(name => name !== 'SHEET_FILTER_PLUGIN') }))
    const ready = recheckReady(created, { profile: 'sheet@1', hookNames: ALL_HOOKS, loadFailures: [] })
    expect(failuresOf(ready)).toEqual(failuresOf(created))
    expect(ready.ok).toBe(false)
  })

  it('白名单之外的名字的加载问题（审查 B3）：创建时与就绪时累计的清单里都有，就绪之后的再核对同样不算——仍然通过', () => {
    const loadFailures = [{ kind: 'parse-threw', resource: 'DOC_DRAWING_PLUGIN', error: 'SyntaxError' }] as const
    const created = checkCreated(facts({ loadFailures }))
    expect(created).toEqual({ ok: true })
    expect(recheckReady(created, { profile: 'sheet@1', hookNames: ALL_HOOKS, loadFailures: [...loadFailures, { kind: 'load-threw', resource: 'DOC_NOTE_PLUGIN', error: 'TypeError' }] })).toEqual({ ok: true })
  })

  it('就绪之前才记下的加载问题（晚注册的 hook）：合进结果；与创建时重复的只留一条', () => {
    const loadFailures = [{ kind: 'load-threw', resource: 'SHEET_DATA_VALIDATION_PLUGIN', error: 'TypeError' }] as const
    const created = checkCreated(facts({ loadFailures }))
    const ready = recheckReady(created, { profile: 'sheet@1', hookNames: ALL_HOOKS, loadFailures: [...loadFailures, { kind: 'parse-swallowed', resource: 'SHEET_NOTE_PLUGIN' }] })
    expect(ready).toEqual({ ok: false, failures: [
      { kind: 'parse-swallowed', resource: 'SHEET_NOTE_PLUGIN' },
      { kind: 'load-threw', resource: 'SHEET_DATA_VALIDATION_PLUGIN', error: 'TypeError' },
    ] })
  })
})

describe('失败清单合成结果（openCheckOf）', () => {
  it('空的是通过；去掉完全相同的，排好序', () => {
    expect(openCheckOf([])).toEqual({ ok: true })
    const failure = { kind: 'resource-missing', resource: 'SHEET_NOTE_PLUGIN' } as const
    expect(openCheckOf([failure, { kind: 'profile-missing-hook', resource: 'SHEET_NOTE_PLUGIN' }, { ...failure }])).toEqual({ ok: false, failures: [
      { kind: 'profile-missing-hook', resource: 'SHEET_NOTE_PLUGIN' },
      failure,
    ] })
  })

  it('构造器名不同的不算重复', () => {
    const check = openCheckOf([{ kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'SyntaxError' }, { kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN' }])
    expect(failuresOf(check)).toHaveLength(2)
  })
})
