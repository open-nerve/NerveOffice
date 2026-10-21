import type { IWorkbookData, Workbook } from '@univerjs/core'
import { DataValidationOperator, DataValidationStatus, DataValidationType, ICommandService, ILogService, IUniverInstanceService, LifecycleService, LifecycleStages, Univer, UniverInstanceType } from '@univerjs/core'
import { DataValidationModel } from '@univerjs/data-validation'
import { RemoveSheetMutation, SetRangeValuesMutation } from '@univerjs/sheets'
import { DataValidationCacheService, SheetDataValidationModel, SheetsDataValidationValidatorService } from '@univerjs/sheets-data-validation'
import { Observable } from 'rxjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { injectorOf } from './injector.ts'

const range = { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }
const rule = { uid: 'dv1', type: DataValidationType.DECIMAL, operator: DataValidationOperator.BETWEEN, formula1: '1', formula2: '10', ranges: [range] }
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(dispose => dispose())
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function deferred() {
  let resolve!: (value: boolean) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<boolean>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function observe<T>(promise: Promise<T>) {
  const result: { value?: T, error?: unknown, settled: boolean } = { settled: false }
  void promise.then((value) => {
    Object.assign(result, { value, settled: true })
  }, (error: unknown) => {
    Object.assign(result, { error, settled: true })
  })
  return result
}

function setup(calculate: () => Promise<boolean> = async () => true) {
  vi.useFakeTimers()
  const callbacks = new Map<number, IdleRequestCallback>()
  const pending = new Set<number>()
  let id = 0
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    callbacks.set(++id, callback)
    pending.add(id)
    return id
  })
  vi.stubGlobal('cancelIdleCallback', (handle: number) => pending.delete(handle))
  const univer = new Univer()
  const injector = injectorOf(univer)
  const instances = injector.get(IUniverInstanceService)
  const commands = injector.get(ICommandService)
  commands.registerCommand(RemoveSheetMutation)
  commands.registerCommand(SetRangeValuesMutation)
  const lifecycle = injector.get(LifecycleService)
  const createWorkbook = () => univer.createUnit<IWorkbookData, Workbook>(UniverInstanceType.UNIVER_SHEET, {
    id: 'wb',
    sheetOrder: ['s1', 's2'],
    sheets: {
      s1: { id: 's1', name: '当前表', rowCount: 10, columnCount: 10, cellData: { 0: { 0: { v: 5 } } } },
      s2: { id: 's2', name: '其他表', rowCount: 10, columnCount: 10, cellData: { 0: { 0: { v: 5 } } } },
    },
  })
  const workbook = createWorkbook()
  const data = new DataValidationModel(injector.get(ILogService))
  const cache = new DataValidationCacheService(commands, instances, data)
  let dirtySubscriptions = 0
  const dirtySource = cache.dirtyRanges$
  Object.defineProperty(cache, 'dirtyRanges$', { value: new Observable((subscriber) => {
    dirtySubscriptions++
    const subscription = dirtySource.subscribe(subscriber)
    return () => {
      dirtySubscriptions--
      subscription.unsubscribe()
    }
  }) })
  // 规则矩阵、缓存、实例和被测模型均为实际 SDK；这里只控制公式计算的完成时机。
  const calculateCell = vi.fn(calculate)
  const model = new SheetDataValidationModel(data, instances, {
    getValidatorItem: () => ({ validator: calculateCell }),
  } as never, cache, { addRule() {}, removeRule() {} } as never, {
    addRule() {},
    deleteByRuleId() {},
  } as never, commands)
  const service = new SheetsDataValidationValidatorService(instances, model, cache, lifecycle)
  const dispose = () => {
    service.dispose()
    model.dispose()
    cache.dispose()
    data.dispose()
    univer.dispose()
  }
  cleanups.push(dispose)
  const addRule = (sheet = 's2') => data.addRule('wb', sheet, rule, 'patched')
  const flush = async () => vi.advanceTimersByTimeAsync(21)
  const runIdle = (handle: number) => {
    pending.delete(handle)
    callbacks.get(handle)!({ didTimeout: false, timeRemaining: () => 10 })
  }
  const retireWorkbook = () => {
    instances.disposeUnit('wb')
    // 实际资源卸载由插件负责；本夹具显式完成规则卸载，保留真实 unitDisposed$。
    data.deleteUnitRules('wb')
  }
  return { univer, instances, commands, lifecycle, workbook, createWorkbook, data, cache, model, service, pending, callbacks, runIdle, flush, addRule, retireWorkbook, calculateCell, dispose, dirtySubscriptions: () => dirtySubscriptions }
}

describe('DEF-056：真实数据验证的空闲任务归属', () => {
  it('Rendered 后初始缓冲订阅终止，不持续持有后续工作簿的脏区', () => {
    const h = setup()
    expect(h.dirtySubscriptions()).toBe(3)
    h.lifecycle.stage = LifecycleStages.Rendered
    expect(h.dirtySubscriptions()).toBe(2)
    h.service.dispose()
    expect(h.dirtySubscriptions()).toBe(1)
    h.model.dispose()
    expect(h.dirtySubscriptions()).toBe(0)
  })
  it.each([false, true])('当前表及时校验，非当前表空闲后校验（初始加载：%s）', async (initial) => {
    const h = setup(async () => false)
    if (!initial)
      h.lifecycle.stage = LifecycleStages.Rendered
    h.addRule('s1')
    h.addRule('s2')
    if (initial)
      h.lifecycle.stage = LifecycleStages.Rendered
    await h.flush()
    expect(h.cache.getValue('wb', 's1', 0, 0)).toBe(DataValidationStatus.INVALID)
    expect(h.cache.getValue('wb', 's2', 0, 0)).toBeUndefined()
    expect(h.pending.size).toBe(1)
    h.runIdle([...h.pending][0]!)
    await h.flush()
    expect(h.cache.getValue('wb', 's2', 0, 0)).toBe(DataValidationStatus.INVALID)
  })

  it.each(['service', 'workbook'] as const)('退役取消已排队任务：%s', async (target) => {
    const h = setup()
    h.addRule()
    h.lifecycle.stage = LifecycleStages.Rendered
    await h.flush()
    expect(h.pending.size).toBe(1)
    if (target === 'service')
      h.service.dispose()
    else
      h.retireWorkbook()
    expect(h.pending.size).toBe(0)
  })

  it('已取消的回调仍迟到时，退役服务不再执行校验', async () => {
    const h = setup(async () => false)
    h.addRule()
    h.lifecycle.stage = LifecycleStages.Rendered
    await h.flush()
    const handle = [...h.pending][0]!
    h.service.dispose()
    h.runIdle(handle)
    await h.flush()
    expect(h.cache.getValue('wb', 's2', 0, 0)).toBeUndefined()
    expect(h.calculateCell).not.toHaveBeenCalled()
  })

  it.each([false, true])('旧回调即使迟到也不校验同 id 新表（初始加载：%s）', async (initial) => {
    const h = setup(async () => false)
    if (!initial)
      h.lifecycle.stage = LifecycleStages.Rendered
    h.addRule()
    if (initial)
      h.lifecycle.stage = LifecycleStages.Rendered
    await h.flush()
    const handle = [...h.pending][0]!
    h.retireWorkbook()
    h.createWorkbook()
    h.addRule()
    h.runIdle(handle)
    await h.flush()
    expect(h.cache.getValue('wb', 's2', 0, 0)).toBeUndefined()
    expect(h.calculateCell).not.toHaveBeenCalled()
    for (const next of [...h.pending])
      h.runIdle(next)
    await h.flush()
    expect(h.cache.getValue('wb', 's2', 0, 0)).toBe(DataValidationStatus.INVALID)
  })

  it('合批前的旧脏区不能在同 id 新表上排队', async () => {
    const h = setup()
    h.lifecycle.stage = LifecycleStages.Rendered
    h.addRule()
    h.retireWorkbook()
    h.createWorkbook()
    await h.flush()
    expect(h.pending.size).toBe(0)
    expect(h.calculateCell).not.toHaveBeenCalled()
  })
})

describe('DEF-056：已开始的模型计算与服务等待', () => {
  it.each(['model', 'workbook', 'sheet'] as const)('退役终结等待，迟到结果不发布事件或写缓存：%s', async (target) => {
    const gate = deferred()
    const h = setup(async () => gate.promise)
    h.addRule()
    const events: unknown[] = []
    h.model.validStatusChange$.subscribe(event => events.push(event))
    const originalCache = h.cache.ensureCache('wb', 's2')
    const write = vi.spyOn(originalCache, 'setValue')
    const result = observe(h.service.validatorCell('wb', 's2', 0, 0))
    expect(h.calculateCell).toHaveBeenCalledOnce()
    if (target === 'model')
      h.model.dispose()
    else if (target === 'workbook')
      h.retireWorkbook()
    else
      h.commands.syncExecuteCommand(RemoveSheetMutation.id, { unitId: 'wb', subUnitId: 's2' })
    write.mockClear()
    await h.flush()
    const settledOnRetirement = result.settled
    gate.resolve(false)
    await h.flush()
    expect(settledOnRetirement).toBe(true)
    expect(result.error).toMatchObject({ name: 'DataValidationCancelledError' })
    expect(result.value).toBeUndefined()
    expect(events).toEqual([])
    expect(write).not.toHaveBeenCalled()
  })

  it('validatorWorksheet 不将旧表的结果替换为同 id 新表缓存', async () => {
    const gate = deferred()
    const h = setup(async () => gate.promise)
    h.addRule()
    const result = observe(h.service.validatorWorksheet('wb', 's2'))
    h.retireWorkbook()
    h.createWorkbook()
    const replacement = h.cache.ensureCache('wb', 's2')
    replacement.setValue(0, 0, DataValidationStatus.INVALID)
    gate.resolve(true)
    await h.flush()
    expect(result.error).toMatchObject({ name: 'DataValidationCancelledError' })
    expect(result.value).toBeUndefined()
    expect(replacement.getValue(0, 0)).toBe(DataValidationStatus.INVALID)
  })

  it('服务自身退役也及时终结已经开始的公开等待', async () => {
    const gate = deferred()
    const h = setup(async () => gate.promise)
    h.addRule()
    const result = observe(h.service.validatorCell('wb', 's2', 0, 0))
    h.service.dispose()
    await h.flush()
    const settledOnRetirement = result.settled
    gate.resolve(true)
    await h.flush()
    expect(settledOnRetirement).toBe(true)
    expect(result.error).toMatchObject({ name: 'DataValidationCancelledError' })
  })

  it.each(['range', 'worksheet'] as const)('await 之前已算出的结果也不能在退役之后返回新缓存：%s', async (scope) => {
    const h = setup()
    h.addRule()
    h.cache.ensureCache('wb', 's2').setValue(0, 0, DataValidationStatus.INVALID)
    const result = observe<unknown>(scope === 'range' ? h.service.validatorRanges('wb', 's2', [range]) : h.service.validatorWorksheet('wb', 's2'))
    h.retireWorkbook()
    h.createWorkbook()
    await h.flush()
    expect(result.error).toMatchObject({ name: 'DataValidationCancelledError' })
    expect(result.value).toBeUndefined()
  })

  it('工作簿还在时，同 id 新工作表也不能接收旧 await 的结果', async () => {
    const h = setup()
    h.addRule()
    h.cache.ensureCache('wb', 's2').setValue(0, 0, DataValidationStatus.INVALID)
    const result = observe(h.service.validatorWorksheet('wb', 's2'))
    h.commands.syncExecuteCommand(RemoveSheetMutation.id, { unitId: 'wb', subUnitId: 's2' })
    h.workbook.addWorksheet('s2', 1, { id: 's2', name: '新表', rowCount: 10, columnCount: 10 })
    await h.flush()
    expect(result.error).toMatchObject({ name: 'DataValidationCancelledError' })
    expect(result.value).toBeUndefined()
  })

  it.each([true, false])('合并区域等待完成后各格保持同一真实状态：%s', async (valid) => {
    const h = setup(async () => valid)
    const mergedRange = { ...range, endColumn: 1 }
    h.workbook.getSheetBySheetId('s2')!.setMergeData([mergedRange])
    h.data.addRule('wb', 's2', { ...rule, ranges: [mergedRange] }, 'patched')
    const status = valid ? DataValidationStatus.VALID : DataValidationStatus.INVALID
    expect(await h.service.validatorRanges('wb', 's2', [mergedRange])).toEqual([[status, status]])
  })

  it.each([true, false])('正常单格、范围、工作表与工作簿结果保持：%s', async (valid) => {
    const h = setup(async () => valid)
    h.addRule()
    const status = valid ? DataValidationStatus.VALID : DataValidationStatus.INVALID
    expect(await h.service.validatorCell('wb', 's2', 0, 0)).toBe(status)
    expect(await h.service.validatorRanges('wb', 's2', [range])).toEqual([[status]])
    expect((await h.service.validatorWorksheet('wb', 's2')).getValue(0, 0) ?? DataValidationStatus.VALID).toBe(status)
    expect((await h.service.validatorWorkbook('wb')).s2!.getValue(0, 0) ?? DataValidationStatus.VALID).toBe(status)
  })

  it.each([false, true])('真实错误传回调用方，失败不永久卡住下次校验（同步异常：%s）', async (sync) => {
    const failure = new Error('test validation failed')
    const h = setup(async () => {
      if (sync)
        throw failure
      return Promise.reject(failure)
    })
    h.addRule()
    const result = observe(h.service.validatorCell('wb', 's2', 0, 0))
    await h.flush()
    expect(result).toMatchObject({ error: failure, settled: true })
    h.calculateCell.mockResolvedValue(true)
    expect(await h.service.validatorCell('wb', 's2', 0, 0)).toBe(DataValidationStatus.VALID)
  })

  it.each(['active', 'idle', 'model'] as const)('后台与原三参数模型调用保留真实错误的诊断：%s', async (source) => {
    const failure = new Error('background validation failed')
    const h = setup(async () => {
      throw failure
    })
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sheet = source === 'active' ? 's1' : 's2'
    h.addRule(sheet)
    if (source === 'model') {
      h.model.validator(rule, {
        unitId: 'wb',
        subUnitId: 's2',
        row: 0,
        col: 0,
        workbook: h.workbook,
        worksheet: h.workbook.getSheetBySheetId('s2')!,
      })
    }
    else {
      h.lifecycle.stage = LifecycleStages.Rendered
      await h.flush()
      for (const handle of [...h.pending])
        h.runIdle(handle)
    }
    await h.flush()
    expect(reported).toHaveBeenCalledExactlyOnceWith(failure)
    expect(h.cache.getValue('wb', sheet, 0, 0)).toBeUndefined()
    reported.mockRestore()
  })
})

describe('DEF-056：同格失效代次与迟到真实错误', () => {
  it.each(['success', 'failure'] as const)('新值已经无效时，旧计算不能删除或覆盖新状态：%s', async (outcome) => {
    const gate = deferred()
    const h = setup(async () => gate.promise)
    h.addRule()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const events: unknown[] = []
    h.model.validStatusChange$.subscribe(event => events.push(event))
    const old = observe(h.service.validatorCell('wb', 's2', 0, 0))
    expect(h.commands.syncExecuteCommand(SetRangeValuesMutation.id, {
      unitId: 'wb',
      subUnitId: 's2',
      cellValue: { 0: { 0: { v: 20 } } },
    })).toBe(true)
    h.calculateCell.mockResolvedValue(false)
    expect(await h.service.validatorCell('wb', 's2', 0, 0)).toBe(DataValidationStatus.INVALID)
    const failure = new Error('old value calculation failed')
    if (outcome === 'success')
      gate.resolve(true)
    else
      gate.reject(failure)
    await h.flush()
    expect(old).toMatchObject({ settled: true, error: { name: 'DataValidationCancelledError' } })
    expect(h.cache.getValue('wb', 's2', 0, 0)).toBe(DataValidationStatus.INVALID)
    expect(events).toEqual([expect.objectContaining({ status: DataValidationStatus.INVALID })])
    expect(reported.mock.calls).toEqual(outcome === 'failure' ? [[failure]] : [])
    reported.mockRestore()
  })

  it('新计算尚未完成时，旧失败不能清掉 VALIDATING 并启动第三次计算', async () => {
    const first = deferred()
    const second = deferred()
    const h = setup(async () => first.promise)
    h.addRule()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const old = observe(h.service.validatorCell('wb', 's2', 0, 0))
    h.commands.syncExecuteCommand(SetRangeValuesMutation.id, {
      unitId: 'wb',
      subUnitId: 's2',
      cellValue: { 0: { 0: { v: 20 } } },
    })
    h.calculateCell.mockImplementation(async () => second.promise)
    const next = observe(h.service.validatorCell('wb', 's2', 0, 0))
    const failure = new Error('superseded validation failure')
    first.reject(failure)
    await h.flush()
    expect(old.error).toMatchObject({ name: 'DataValidationCancelledError' })
    expect(next.settled).toBe(false)
    expect(h.cache.getValue('wb', 's2', 0, 0)).toBe(DataValidationStatus.VALIDATING)
    const joined = observe(h.service.validatorCell('wb', 's2', 0, 0))
    await h.flush()
    expect(joined.settled).toBe(false)
    expect(h.calculateCell).toHaveBeenCalledTimes(2)
    second.resolve(false)
    await h.flush()
    expect(next.value).toBe(DataValidationStatus.INVALID)
    expect(joined.value).toBe(DataValidationStatus.INVALID)
    expect(reported).toHaveBeenCalledExactlyOnceWith(failure)
    reported.mockRestore()
  })

  it('改值立即废弃旧计算，20 ms 合批尚未开始也不能回填旧缓存', async () => {
    const gate = deferred()
    const h = setup(async () => gate.promise)
    const events: unknown[] = []
    h.model.validStatusChange$.subscribe(event => events.push(event))
    h.lifecycle.stage = LifecycleStages.Rendered
    h.addRule('s1')
    await h.flush()
    expect(h.calculateCell).toHaveBeenCalledOnce()
    h.commands.syncExecuteCommand(SetRangeValuesMutation.id, {
      unitId: 'wb',
      subUnitId: 's1',
      cellValue: { 0: { 0: { v: 6 } } },
    })
    gate.resolve(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calculateCell).toHaveBeenCalledOnce()
    expect(h.cache.getValue('wb', 's1', 0, 0)).toBeUndefined()
    expect(events).toEqual([])
    h.calculateCell.mockResolvedValue(true)
    await h.flush()
    expect(h.calculateCell).toHaveBeenCalledTimes(2)
    expect(h.calculateCell).toHaveBeenLastCalledWith(expect.objectContaining({ value: 6 }), rule)
    expect(events).toEqual([expect.objectContaining({ status: DataValidationStatus.VALID })])
  })

  it('删除规则立即取消旧计算，迟到无效结果不能恢复已删除规则的状态', async () => {
    const gate = deferred()
    const h = setup(async () => gate.promise)
    h.addRule()
    const events: unknown[] = []
    h.model.validStatusChange$.subscribe(event => events.push(event))
    const old = observe(h.service.validatorCell('wb', 's2', 0, 0))
    h.data.removeRule('wb', 's2', rule.uid, 'patched')
    gate.resolve(false)
    await h.flush()
    expect(old).toMatchObject({ settled: true, error: { name: 'DataValidationCancelledError' } })
    expect(h.cache.getValue('wb', 's2', 0, 0)).toBeUndefined()
    expect(events).toEqual([])
    expect(await h.service.validatorCell('wb', 's2', 0, 0)).toBe(DataValidationStatus.VALID)
  })

  it('单格失效只取消覆盖该格的计算，邻格继续返回并发布真实结果', async () => {
    const first = deferred()
    const second = deferred()
    const h = setup(async () => first.promise)
    h.data.addRule('wb', 's2', { ...rule, ranges: [{ ...range, endColumn: 1 }] }, 'patched')
    const old = observe(h.service.validatorCell('wb', 's2', 0, 0))
    h.calculateCell.mockImplementation(async () => second.promise)
    const neighbor = observe(h.service.validatorCell('wb', 's2', 0, 1))
    h.commands.syncExecuteCommand(SetRangeValuesMutation.id, {
      unitId: 'wb',
      subUnitId: 's2',
      cellValue: { 0: { 0: { v: 20 } } },
    })
    await h.flush()
    expect(old).toMatchObject({ settled: true, error: { name: 'DataValidationCancelledError' } })
    expect(neighbor.settled).toBe(false)
    second.resolve(false)
    first.resolve(true)
    await h.flush()
    expect(neighbor).toMatchObject({ settled: true, value: DataValidationStatus.INVALID })
    expect(h.cache.getValue('wb', 's2', 0, 1)).toBe(DataValidationStatus.INVALID)
  })

  it.each([
    { target: 'model', before: true },
    { target: 'model', before: false },
    { target: 'workbook', before: true },
    { target: 'workbook', before: false },
    { target: 'service', before: true },
    { target: 'service', before: false },
  ] as const)('真实拒绝在退役竞态中仍报告一次：$target，拒绝先发生=$before', async ({ target, before }) => {
    const gate = deferred()
    const failure = new Error('late real validation failure')
    const h = setup(async () => gate.promise)
    h.addRule()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const events: unknown[] = []
    h.model.validStatusChange$.subscribe(event => events.push(event))
    const cache = h.cache.ensureCache('wb', 's2')
    const write = vi.spyOn(cache, 'setValue')
    const remove = vi.spyOn(cache, 'realDeleteValue')
    const result = observe(h.service.validatorCell('wb', 's2', 0, 0))
    if (before)
      gate.reject(failure)
    if (target === 'model')
      h.model.dispose()
    else if (target === 'workbook')
      h.retireWorkbook()
    else
      h.service.dispose()
    write.mockClear()
    remove.mockClear()
    if (!before)
      gate.reject(failure)
    await h.flush()
    expect(result).toMatchObject({ settled: true, error: { name: 'DataValidationCancelledError' } })
    expect(reported).toHaveBeenCalledExactlyOnceWith(failure)
    expect(events).toEqual([])
    expect(write).not.toHaveBeenCalled()
    // 只取消 service 的等待不退役共享模型；模型仍负责清除当前失败的 VALIDATING。
    expect(remove).toHaveBeenCalledTimes(target === 'service' ? 1 : 0)
    reported.mockRestore()
  })

  it('实际取消错误迟到时保持安静，不伪造状态或恢复已经取消的等待', async () => {
    const gate = deferred()
    const h = setup(async () => gate.promise)
    h.addRule()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = observe(h.service.validatorCell('wb', 's2', 0, 0))
    h.model.dispose()
    await h.flush()
    expect(result.error).toMatchObject({ name: 'DataValidationCancelledError' })
    gate.reject(result.error)
    await h.flush()
    expect(result.value).toBeUndefined()
    expect(reported).not.toHaveBeenCalled()
    reported.mockRestore()
  })
})
