import type { CommandKind, CommandRecord } from './command-record.ts'
import { describe, expect, it } from 'vitest'
import { classifyCommand, EXCLUDED_EXECUTION_OPTIONS, isDocumentChange } from './change-classifier.ts'

const config = { unitId: 'unit-1', excludedMutationIds: ['sheet.operation.clear-drawing-transformer'] }

function record(overrides: Partial<CommandRecord> & { kind?: CommandKind } = {}): CommandRecord {
  return { id: 'sheet.mutation.set-range-values', kind: 'mutation', params: { unitId: 'unit-1', subUnitId: 'sheet-1' }, options: undefined, ...overrides }
}

describe('变更检测的判定', () => {
  it('本文档的 mutation 是修改', () => {
    expect(classifyCommand(record(), config)).toBe('change')
    expect(isDocumentChange(record(), config)).toBe(true)
  })

  it.each(['command', 'operation'] as const)('只看 mutation：%s 不算（它们执行的 mutation 会各自送出）', (kind) => {
    expect(classifyCommand(record({ id: 'sheet.command.set-range-values', kind }), config)).toBe('not-mutation')
  })

  it('排除的执行选项正好是 onlyLocal、fromCollab、fromChangeset、fromFormula（syncOnly 的 mutation 不送给普通监听者）', () => {
    expect([...EXCLUDED_EXECUTION_OPTIONS]).toEqual(['onlyLocal', 'fromCollab', 'fromChangeset', 'fromFormula'])
  })

  it.each(EXCLUDED_EXECUTION_OPTIONS)('带 %s 标记的不算', (option) => {
    expect(classifyCommand(record({ options: { [option]: true } }), config)).toBe(`option:${option}`)
    expect(isDocumentChange(record({ options: { [option]: true } }), config)).toBe(false)
  })

  it('选项按真值取：值为 false 的不排除，其他无关的选项不影响', () => {
    expect(classifyCommand(record({ options: { onlyLocal: false, fromCollab: false } }), config)).toBe('change')
    expect(classifyCommand(record({ options: { trigger: 'x', applyFormulaCalculationResult: false } }), config)).toBe('change')
  })

  it('公式结果写回（onlyLocal + fromFormula + applyFormulaCalculationResult）与 Worker 同步回来的 mutation 不算', () => {
    expect(isDocumentChange(record({ options: { onlyLocal: true, fromFormula: true, applyFormulaCalculationResult: true } }), config)).toBe(false)
    expect(isDocumentChange(record({ options: { onlyLocal: true, fromSync: true } }), config)).toBe(false)
  })

  it('作用于其他单元的不算：单元格编辑器内部文档的 rich-text-editing 就是这一类（编辑中的单元格不算修改）', () => {
    const editing = record({ id: 'doc.mutation.rich-text-editing', params: { unitId: '__INTERNAL_EDITOR__DOCS_NORMAL', actions: [] } })
    expect(classifyCommand(editing, config)).toBe('other-unit')
  })

  it('参数里没有 unitId 的 mutation 按本文档算：宁可多保存一次', () => {
    expect(classifyCommand(record({ params: {} }), config)).toBe('change')
    expect(classifyCommand(record({ params: undefined }), config)).toBe('change')
    expect(classifyCommand(record({ params: { unitId: 42 } }), config)).toBe('change')
  })

  it('排除名单里的 mutation 不算', () => {
    expect(classifyCommand(record({ id: 'sheet.operation.clear-drawing-transformer', params: ['unit-1'] }), config)).toBe('excluded')
  })

  it('判定的先后：先看类型，再看选项，再看单元，最后看排除名单', () => {
    expect(classifyCommand(record({ kind: 'operation', options: { onlyLocal: true } }), config)).toBe('not-mutation')
    expect(classifyCommand(record({ options: { onlyLocal: true }, params: { unitId: 'other' } }), config)).toBe('option:onlyLocal')
    expect(classifyCommand(record({ id: 'sheet.operation.clear-drawing-transformer', params: { unitId: 'other' } }), config)).toBe('other-unit')
  })

  it('不排除自动行高（计划书 §7.3 更正 r2）', () => {
    expect(isDocumentChange(record({ id: 'sheet.mutation.set-worksheet-row-auto-height' }), config)).toBe(true)
  })
})
