// "改动被拦住"的比较口径（content-compare.ts）：E2E 与页面自检共用。内容的规范化、两份快照比较时不看键的顺序、
// 命令日志里"改文档的 mutation"的判定与编辑器的变更检测一致。
// content-compare.ts 不引用任何模块（E2E 也引用它，lint 规则 nerve/editor-testing-shared），用不了 contracts 的规范化内容
// （documents/content-canonical.ts，服务端"内容相同不递增"的口径）：这里核对两边对"内容相同"的判断一致
import type { LoggedCommand } from './content-compare.ts'
import { canonicalContentText } from '@nerve-office/contracts'
import { describe, expect, it, vi } from 'vitest'
import { EXCLUDED_EXECUTION_OPTIONS } from '../change-tracking/change-classifier.ts'
import { CHANGE_DETECTION_EXCLUDED_MUTATIONS } from '../profile/sheet-profile.ts'
import { canonicalJson, contentOf, documentChangeAttemptsIn, documentChangesIn, NOT_CHANGE_MUTATIONS, NOT_USER_CHANGE_FLAGS, sameContent } from './content-compare.ts'

vi.hoisted(() => {
  // jsdom 没有 Path2D：档案引用的数据验证的界面包在模块求值时就创建它。这里只读档案的排除名单，不运行 Univer
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

const UNIT = 'unit-1'

function snapshot(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: UNIT,
    sheetOrder: ['s1'],
    sheets: { s1: { name: '数据', zoomRatio: 1, scrollTop: 0, scrollLeft: 0, cellData: { 0: { 0: { v: 1 } } } } },
    resources: [
      { name: 'SHEET_FILTER_PLUGIN', data: '{"s1":{"ref":{"startRow":0}}}' },
      { name: 'SHEET_DATA_VALIDATION_PLUGIN', data: '{"s1":[]}' },
      { name: 'SHEET_RANGE_PROTECTION_PLUGIN', data: '' },
    ],
    ...overrides,
  })
}

function command(overrides: Partial<LoggedCommand> = {}): LoggedCommand {
  return { phase: 'executed', id: 'sheet.mutation.set-range-values', kind: 'mutation', canceled: false, unitId: UNIT, flags: [], ...overrides }
}

describe('快照的内容（比较的口径）', () => {
  it('资源 data 只在第一层（每张表一个键）去掉空值，更深的层级原样保留（与服务端的规范化内容同一个口径，审查 A5）', () => {
    const resources = [{ name: 'SHEET_FILTER_PLUGIN', data: '{"s1":{"ref":{"startRow":0},"cachedFilteredOut":[],"filterColumns":[{"colId":0,"filters":{}}]},"s2":{}}' }]
    expect((contentOf(snapshot({ resources })) as { resources: unknown }).resources).toEqual([
      { name: 'SHEET_FILTER_PLUGIN', data: { s1: { ref: { startRow: 0 }, cachedFilteredOut: [], filterColumns: [{ colId: 0, filters: {} }] } } },
    ])
  })

  it('去掉工作表的视图状态、取值为空的资源，资源按名称排序', () => {
    expect(contentOf(snapshot())).toEqual({
      id: UNIT,
      sheetOrder: ['s1'],
      sheets: { s1: { name: '数据', cellData: { 0: { 0: { v: 1 } } } } },
      resources: [{ name: 'SHEET_FILTER_PLUGIN', data: { s1: { ref: { startRow: 0 } } } }],
    })
  })

  it('滚动与缩放不同、补上的空规则表、对象键的顺序不同：内容相同', () => {
    const scrolled = snapshot({ sheets: { s1: { cellData: { 0: { 0: { v: 1 } } }, name: '数据', zoomRatio: 2, scrollTop: 300, scrollLeft: 10 } } })
    expect(sameContent(snapshot(), scrolled)).toBe(true)
  })

  it('单元格、工作表的顺序、资源里的规则不同：内容不同', () => {
    expect(sameContent(snapshot(), snapshot({ sheets: { s1: { name: '数据', cellData: { 0: { 0: { v: 2 } } } } } }))).toBe(false)
    expect(sameContent(snapshot(), snapshot({ sheetOrder: ['s1', 's2'] }))).toBe(false)
    expect(sameContent(snapshot(), snapshot({ resources: [{ name: 'SHEET_FILTER_PLUGIN', data: '{"s1":{"ref":{"startRow":1}}}' }] }))).toBe(false)
  })

  it('排好键的写法：键的顺序不影响，数组的顺序照旧', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}')
  })

  it('与服务端的规范化内容（contracts 的 canonicalContentText）判断一致：一样的算相同，不一样的算不同', () => {
    const filtered = (column: string) => ({ name: 'SHEET_FILTER_PLUGIN', data: `{"s1":{"ref":{"startRow":0},"filterColumns":[${column}]}}` })
    const variants = [
      snapshot(),
      snapshot({ sheets: { s1: { cellData: { 0: { 0: { v: 1 } } }, name: '数据', zoomRatio: 2, scrollTop: 300, scrollLeft: 10 } } }),
      // 资源 data 的第一层：补上的空规则表与"不在"等价
      snapshot({ resources: [{ name: 'SHEET_RANGE_PROTECTION_PLUGIN', data: '{"s1":[]}' }, { name: 'SHEET_FILTER_PLUGIN', data: '{"s1":{"ref":{"startRow":0}},"s2":{}}' }, { name: 'SHEET_DATA_VALIDATION_PLUGIN', data: '{"s1":[],"s2":[]}' }] }),
      // 更深的层级：空值是内容（审查 A5）
      snapshot({ resources: [{ name: 'SHEET_RANGE_PROTECTION_PLUGIN', data: '{"s1":[]}' }, { name: 'SHEET_FILTER_PLUGIN', data: '{"s1":{"ref":{"startRow":0},"filterColumns":[]}}' }] }),
      snapshot({ resources: [filtered('{"colId":0,"customFilters":{"customFilters":[{"val":""}]}}')] }),
      snapshot({ resources: [filtered('{"colId":0,"filters":{}}')] }),
      snapshot({ resources: [filtered('{"colId":0}')] }),
      snapshot({ resources: [{ name: 'SHEET_FILTER_PLUGIN', data: '{"s1":{"ref":{"startRow":1}}}' }] }),
      snapshot({ sheets: { s1: { name: '数据', cellData: { 0: { 0: { v: 2 } } } } } }),
      snapshot({ sheets: { s1: { name: '数据', cellData: { 0: { 0: { v: 1, m: '' } } } } } }),
      snapshot({ sheetOrder: ['s1', 's2'] }),
      snapshot({ resources: [] }),
    ]
    for (const a of variants) {
      for (const b of variants)
        expect(sameContent(a, b), `${a}\n${b}`).toBe(canonicalContentText(a) === canonicalContentText(b))
    }
  })
})

describe('命令日志里改文档的 mutation（与编辑器的变更检测同一个判定）', () => {
  it('排除的执行标记与排除名单与编辑器的变更检测相同（change-classifier.ts、档案的 CHANGE_DETECTION_EXCLUDED_MUTATIONS）', () => {
    expect(NOT_USER_CHANGE_FLAGS).toEqual([...EXCLUDED_EXECUTION_OPTIONS])
    expect(NOT_CHANGE_MUTATIONS).toEqual(CHANGE_DETECTION_EXCLUDED_MUTATIONS)
  })

  it('执行了的：本文档的、不带排除标记、不在排除名单里的 mutation；没有 unitId 的按本文档算', () => {
    const commands = [
      command({ id: 'change' }),
      command({ id: 'no-unit', unitId: undefined }),
      command({ id: 'other-unit', unitId: 'unit-2' }),
      command({ id: 'local', flags: ['onlyLocal'] }),
      command({ id: 'formula', flags: ['fromFormula'] }),
      command({ id: 'sheet.operation.clear-drawing-transformer' }),
      command({ id: 'operation', kind: 'operation' }),
      command({ id: 'before', phase: 'before', canceled: true }),
    ]
    expect(documentChangesIn(commands, UNIT).map(item => item.id)).toEqual(['change', 'no-unit'])
  })

  it('尝试过的：执行前的记录，被取消的也算', () => {
    const commands = [command({ id: 'tried', phase: 'before', canceled: true }), command({ id: 'done' }), command({ id: 'local', phase: 'before', flags: ['onlyLocal'] })]
    expect(documentChangeAttemptsIn(commands, UNIT).map(item => item.id)).toEqual(['tried'])
  })
})
