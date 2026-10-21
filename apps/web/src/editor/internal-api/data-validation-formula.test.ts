import type { IWorkbookData, Workbook } from '@univerjs/core'
import { CellValueType, DataValidationStatus, DataValidationType, ICommandService, ILogService, IUniverInstanceService, LifecycleService, Univer, UniverInstanceType } from '@univerjs/core'
import { DataValidationModel } from '@univerjs/data-validation'
import { OtherFormulaMarkDirty, RegisterOtherFormulaService, RemoveOtherFormulaMutation, SetFormulaCalculationResultMutation, SetOtherFormulaMutation } from '@univerjs/engine-formula'
import { SetRangeValuesMutation } from '@univerjs/sheets'
import { DataValidationCacheService, DataValidationCustomFormulaService, DataValidationFormulaService, SheetDataValidationModel, SheetsDataValidationValidatorService } from '@univerjs/sheets-data-validation'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { injectorOf } from './injector.ts'

const range = { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(dispose => dispose())
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function observe<T>(promise: Promise<T>) {
  const result: { value?: T, error?: unknown, settled: boolean } = { settled: false }
  void promise.then(
    value => Object.assign(result, { value, settled: true }),
    (error: unknown) => Object.assign(result, { error, settled: true }),
  )
  return result
}

function setup(kind: 'custom' | 'bound' = 'custom') {
  vi.useFakeTimers()
  const univer = new Univer()
  const injector = injectorOf(univer)
  const instances = injector.get(IUniverInstanceService)
  const commands = injector.get(ICommandService)
  for (const command of [SetRangeValuesMutation, SetOtherFormulaMutation, RemoveOtherFormulaMutation, SetFormulaCalculationResultMutation, OtherFormulaMarkDirty])
    commands.registerCommand(command)
  const workbook = univer.createUnit<IWorkbookData, Workbook>(UniverInstanceType.UNIVER_SHEET, {
    id: 'wb',
    sheetOrder: ['s1'],
    sheets: { s1: { id: 's1', name: 'Sheet1', rowCount: 10, columnCount: 10, cellData: { 0: { 0: { v: 4 } } } } },
  })
  const lifecycle = injector.get(LifecycleService)
  const data = new DataValidationModel(injector.get(ILogService))
  const cache = new DataValidationCacheService(commands, instances, data)
  // 计算输出来自受控的 Worker 边界；注册、结果回传、缓存及校验等待均为实际 SDK。
  const formulas = new RegisterOtherFormulaService(commands, { register() {} } as never, lifecycle)
  const calculate = vi.fn<() => Promise<boolean>>()
  const registry = { getValidatorItem: () => ({ offsetFormulaByRange: kind === 'custom', validator: calculate }) }
  const custom = new DataValidationCustomFormulaService(instances, formulas, data, cache, registry as never)
  const bound = new DataValidationFormulaService(instances, formulas, cache, data, registry as never, { markRuleDirty() {} } as never)
  calculate.mockImplementation(async () => {
    if (kind === 'custom')
      return Boolean((await custom.getCellFormulaValue('wb', 's1', 'rule', 0, 0))?.v)
    const result = await bound.getRuleFormulaResult('wb', 's1', 'rule')
    return Number(workbook.getActiveSheet().getCellRaw(0, 0)?.v) > Number(result?.[0]?.result?.[0]?.[0]?.[0]?.[0]?.v)
  })
  const model = new SheetDataValidationModel(data, instances, registry as never, cache, bound, custom, commands)
  const service = new SheetsDataValidationValidatorService(instances, model, cache, lifecycle)
  const events: unknown[] = []
  model.validStatusChange$.subscribe(event => events.push(event))
  data.addRule('wb', 's1', {
    uid: 'rule',
    type: kind === 'custom' ? DataValidationType.CUSTOM : DataValidationType.DECIMAL,
    formula1: kind === 'custom' ? '=A1>5' : '=B1',
    ranges: [range],
  }, 'patched')
  const formulaId = Object.keys(formulas.getFormulaDirtyMap('wb').s1!)[0]!
  expect(formulaId).toBeTruthy()
  const emit = (value: number) => commands.syncExecuteCommand(SetFormulaCalculationResultMutation.id, {
    unitData: {},
    unitOtherData: { wb: { s1: { [formulaId]: { 0: { 0: [[{ v: value, t: kind === 'custom' ? CellValueType.BOOLEAN : CellValueType.NUMBER }]] } } } } },
  })
  const flush = async () => vi.advanceTimersByTimeAsync(0)
  cleanups.push(() => {
    service.dispose()
    model.dispose()
    custom.dispose()
    bound.dispose()
    formulas.dispose()
    cache.dispose()
    data.dispose()
    univer.dispose()
  })
  return { service, model, cache, data, formulas, calculate, emit, flush, events, instances, commands }
}

describe('公式完成与输入失效是不同的校验边界', () => {
  it.each(['custom', 'bound'] as const)('实际 %s 公式结果唤醒等待，并向所有调用者返回最终非法结果', async (kind) => {
    const h = setup(kind)
    const first = observe(h.service.validatorCell('wb', 's1', 0, 0))
    const joined = observe(h.service.validatorCell('wb', 's1', 0, 0))
    await h.flush()
    expect(first.settled).toBe(false)
    expect(joined.settled).toBe(false)
    h.emit(kind === 'custom' ? 0 : 5)
    await h.flush()
    expect(first).toEqual({ settled: true, value: DataValidationStatus.INVALID })
    expect(joined).toEqual(first)
    expect(h.cache.getValue('wb', 's1', 0, 0)).toBe(DataValidationStatus.INVALID)
    expect(h.events).toEqual([expect.objectContaining({ status: DataValidationStatus.INVALID })])
  })

  it('实际公式合法结果返回 VALID，不能用取消或 VALIDATING 代替结论', async () => {
    const h = setup()
    const result = observe(h.service.validatorCell('wb', 's1', 0, 0))
    h.emit(1)
    await h.flush()
    expect(result).toEqual({ settled: true, value: DataValidationStatus.VALID })
    expect(h.cache.getValue('wb', 's1', 0, 0)).toBeUndefined()
  })

  it('已经读到的旧公式结果在完成前过期，只发布最新结果', async () => {
    const h = setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.calculate.mockImplementationOnce(async () => {
      await gate
      return true
    })
    const result = observe(h.service.validatorCell('wb', 's1', 0, 0))
    h.emit(0)
    release()
    await h.flush()
    expect(result).toEqual({ settled: true, value: DataValidationStatus.INVALID })
    expect(h.events).toEqual([expect.objectContaining({ status: DataValidationStatus.INVALID })])
  })

  it.each(['value', 'rule', 'workbook'] as const)('等待期间 %s 失效仍取消，迟到的公式结果不能复活任务', async (boundary) => {
    const h = setup()
    const result = observe(h.service.validatorCell('wb', 's1', 0, 0))
    const joined = observe(h.service.validatorCell('wb', 's1', 0, 0))
    if (boundary === 'value')
      h.commands.syncExecuteCommand(SetRangeValuesMutation.id, { unitId: 'wb', subUnitId: 's1', cellValue: { 0: { 0: { v: 8 } } } })
    else if (boundary === 'rule')
      h.data.removeRule('wb', 's1', 'rule', 'patched')
    else
      h.instances.disposeUnit('wb')
    await h.flush()
    for (const current of [result, joined]) {
      expect(current.settled).toBe(true)
      expect(current.error).toMatchObject({ name: 'DataValidationCancelledError' })
    }
    h.emit(0)
    await h.flush()
    expect(h.events).toEqual([])
  })

  it('共享计算的真实错误向每个等待者传递，清除缓存后允许重新计算', async () => {
    const h = setup()
    const failure = new Error('calculation failed')
    h.calculate.mockRejectedValueOnce(failure)
    const first = observe(h.service.validatorCell('wb', 's1', 0, 0))
    const joined = observe(h.service.validatorCell('wb', 's1', 0, 0))
    await h.flush()
    expect(first.error).toBe(failure)
    expect(joined.error).toBe(failure)
    expect(h.cache.getValue('wb', 's1', 0, 0)).toBeUndefined()
    const retry = observe(h.service.validatorCell('wb', 's1', 0, 0))
    h.emit(0)
    await h.flush()
    expect(retry.value).toBe(DataValidationStatus.INVALID)
  })
})
