import type { Univer } from '@univerjs/core'
import type { CommandRecord } from './command-record.ts'
import { CommandType } from '@univerjs/core'
import { describe, expect, it, vi } from 'vitest'
import { FORMULA_PROTOCOL, IActiveDirtyManagerService } from '../internal-api/index.ts'
import { createCalculationTriggerCheck, hasDirtyData } from './calculation-trigger.ts'

type Conversion = Parameters<IActiveDirtyManagerService['register']>[1]

/** 假的 Univer：注入器里可能还没有 IActiveDirtyManagerService（公式引擎插件启动之前） */
function fakeUniver(conversions: Record<string, Conversion>, available = { value: true }) {
  const manager = { get: (id: string) => conversions[id] }
  const has = vi.fn((id: unknown) => id === IActiveDirtyManagerService && available.value)
  const get = vi.fn((id: unknown) => {
    expect(id).toBe(IActiveDirtyManagerService)
    return manager
  })
  return { univer: { __getInjector: () => ({ has, get }) } as unknown as Univer, has, get }
}

const record = (id: string, options?: Record<string, unknown>): CommandRecord => ({ id, kind: 'mutation', params: { unitId: 'unit-1' }, options })

describe('脏区是否非空（与 SDK 触发服务的 hasDirtyData 同一口径）', () => {
  it('空的脏区', () => {
    expect(hasDirtyData({})).toBe(false)
    expect(hasDirtyData({ dirtyRanges: [], dirtyNameMap: {}, dirtyDefinedNameMap: { u: {} }, clearDependencyTreeCache: { u: { s: null } } } as never)).toBe(false)
  })

  it.each([
    ['forceCalculation', { forceCalculation: true }],
    ['dirtyRanges', { dirtyRanges: [{ unitId: 'u', sheetId: 's', range: {} }] }],
    ['dirtyNameMap', { dirtyNameMap: { u: { s: '1' } } }],
    ['dirtyDefinedNameMap', { dirtyDefinedNameMap: { u: { name: '1' } } }],
    ['dirtySuperTableMap', { dirtySuperTableMap: { u: { t: '1' } } }],
    ['dirtyUnitFeatureMap', { dirtyUnitFeatureMap: { u: { s: { f: true } } } }],
    ['dirtyUnitOtherFormulaMap', { dirtyUnitOtherFormulaMap: { u: { s: { f: true } } } }],
    ['clearDependencyTreeCache', { clearDependencyTreeCache: { u: { s: '1' } } }],
  ])('%s 非空就是有脏区', (_, dirty) => {
    expect(hasDirtyData(dirty as never)).toBe(true)
  })
})

describe('命令会不会触发新的一轮计算', () => {
  it('没有登记脏区转换的命令不会触发', () => {
    const { univer } = fakeUniver({})
    expect(createCalculationTriggerCheck(univer)(record('sheet.mutation.set-worksheet-name'))).toBeNull()
  })

  it('shouldTrigger 排除的不会触发；它拿到的命令带类型、参数与执行选项', () => {
    const shouldTrigger = vi.fn(() => false)
    const { univer } = fakeUniver({ 'sheet.mutation.set-range-values': { commandId: 'sheet.mutation.set-range-values', shouldTrigger, getDirtyData: () => ({ forceCalculation: true }) } })
    expect(createCalculationTriggerCheck(univer)(record('sheet.mutation.set-range-values', { onlyLocal: true }))).toBeNull()
    expect(shouldTrigger).toHaveBeenCalledWith({ id: 'sheet.mutation.set-range-values', type: CommandType.MUTATION, params: { unitId: 'unit-1' } }, { onlyLocal: true })
  })

  it('登记了转换：返回延后求值的判断，按脏区是否非空', () => {
    const getDirtyData = vi.fn(() => ({ dirtyRanges: [] }))
    const { univer } = fakeUniver({ 'sheet.mutation.insert-row': { commandId: 'sheet.mutation.insert-row', getDirtyData } })
    const candidate = createCalculationTriggerCheck(univer)(record('sheet.mutation.insert-row'))
    expect(getDirtyData).not.toHaveBeenCalled()
    expect(candidate?.()).toBe(false)
    expect(getDirtyData).toHaveBeenCalledTimes(1)
  })

  it('强制重算的触发命令一定开始新的一轮，不看脏区', () => {
    const id = FORMULA_PROTOCOL.forceTriggerMutationId
    const { univer } = fakeUniver({ [id]: { commandId: id, getDirtyData: () => ({}) } })
    expect(createCalculationTriggerCheck(univer)(record(id))?.()).toBe(true)
  })

  it('公式引擎的服务还没注册时不会触发，注册之后取一次并留着', () => {
    const available = { value: false }
    const { univer, get } = fakeUniver({ 'sheet.mutation.insert-row': { commandId: 'sheet.mutation.insert-row', getDirtyData: () => ({ forceCalculation: true }) } }, available)
    const check = createCalculationTriggerCheck(univer)
    expect(check(record('sheet.mutation.insert-row'))).toBeNull()
    available.value = true
    expect(check(record('sheet.mutation.insert-row'))?.()).toBe(true)
    expect(check(record('sheet.mutation.insert-row'))?.()).toBe(true)
    expect(get).toHaveBeenCalledTimes(1)
  })
})
