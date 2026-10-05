import type { Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import { CommandType } from '@univerjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChangeTracker } from './change-tracker.ts'

interface FakeCommandEvent { id: string, type: CommandType, params?: unknown, options?: Record<string, unknown> }

/** 假的 Facade：记下 CommandExecuted 的订阅者，由测试模拟 SDK 在命令执行后同步派发 */
function fakeFacade() {
  const listeners = new Set<(event: FakeCommandEvent) => void>()
  const api = {
    Event: { CommandExecuted: 'CommandExecuted' },
    addEvent: vi.fn((name: string, listener: (event: FakeCommandEvent) => void) => {
      expect(name).toBe('CommandExecuted')
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    }),
  }
  // 公式引擎还没注册：触发判断一律不触发
  const univer = { __getInjector: () => ({ has: () => false }) } as unknown as Univer
  const fire = (event: FakeCommandEvent): void => listeners.forEach(listener => listener(event))
  return { api: api as unknown as FUniver, univer, fire, listenerCount: () => listeners.size }
}

const config = { unitId: 'unit-1', excludedMutationIds: ['sheet.operation.clear-drawing-transformer'] }
const userEdit: FakeCommandEvent = { id: 'sheet.mutation.set-range-values', type: CommandType.MUTATION, params: { unitId: 'unit-1', subUnitId: 'sheet-1' } }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('变更检测的订阅', () => {
  it('本文档的修改让本地修改序号加一并通知；其他命令不算', () => {
    const facade = fakeFacade()
    const tracker = createChangeTracker(facade.univer, facade.api, config)
    const listener = vi.fn()
    tracker.onChange(listener)
    facade.fire({ id: 'sheet.command.set-range-values', type: CommandType.COMMAND, params: { unitId: 'unit-1' } })
    facade.fire({ ...userEdit, options: { onlyLocal: true, fromFormula: true } })
    facade.fire({ id: 'doc.mutation.rich-text-editing', type: CommandType.MUTATION, params: { unitId: '__INTERNAL_EDITOR__DOCS_NORMAL' } })
    facade.fire({ id: 'sheet.operation.set-selections', type: CommandType.OPERATION, params: { unitId: 'unit-1' } })
    expect(tracker.changeSeq()).toBe(0)
    expect(listener).not.toHaveBeenCalled()
    facade.fire(userEdit)
    facade.fire(userEdit)
    expect(tracker.changeSeq()).toBe(2)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('取消订阅之后不再通知', () => {
    const facade = fakeFacade()
    const tracker = createChangeTracker(facade.univer, facade.api, config)
    const listener = vi.fn()
    const unsubscribe = tracker.onChange(listener)
    unsubscribe()
    facade.fire(userEdit)
    expect(tracker.changeSeq()).toBe(1)
    expect(listener).not.toHaveBeenCalled()
  })

  it('监听者抛出的异常不打断 SDK 的命令执行，也不影响别的监听者，交给浏览器的错误报告', () => {
    const reportError = vi.fn()
    vi.stubGlobal('reportError', reportError)
    const facade = fakeFacade()
    const tracker = createChangeTracker(facade.univer, facade.api, config)
    const failure = new Error('页面的监听出错')
    const after = vi.fn()
    tracker.onChange(() => {
      throw failure
    })
    tracker.onChange(after)
    expect(() => facade.fire(userEdit)).not.toThrow()
    expect(reportError).toHaveBeenCalledWith(failure)
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('公式收齐跟着同一个命令流：开始一轮之后没收齐，完成之后收齐', () => {
    const facade = fakeFacade()
    const tracker = createChangeTracker(facade.univer, facade.api, config)
    expect(tracker.formulasSettled()).toBe(true)
    facade.fire({ id: 'formula.mutation.set-formula-calculation-start', type: CommandType.MUTATION, params: {}, options: { onlyLocal: true } })
    expect(tracker.formulasSettled()).toBe(false)
    facade.fire({ id: 'formula.mutation.set-formula-calculation-notification', type: CommandType.MUTATION, params: { functionsExecutedState: 2 }, options: { onlyLocal: true } })
    expect(tracker.formulasSettled()).toBe(true)
    expect(tracker.changeSeq()).toBe(0)
  })

  it('公式的进度取自同一个跟踪器：轮数、开始、完成（M3-P4 设计 §3.10、§3.15）', () => {
    const facade = fakeFacade()
    const tracker = createChangeTracker(facade.univer, facade.api, config)
    expect(tracker.formulaProgress()).toEqual({ round: 0, started: false, stopped: false, completed: false, resultSheets: null, appliedSheets: [], queued: false })
    facade.fire({ id: 'formula.mutation.set-formula-calculation-start', type: CommandType.MUTATION, params: {}, options: { onlyLocal: true } })
    expect(tracker.formulaProgress()).toMatchObject({ round: 1, started: true, completed: false })
    facade.fire({ id: 'formula.mutation.set-formula-calculation-notification', type: CommandType.MUTATION, params: { functionsExecutedState: 2 }, options: { onlyLocal: true } })
    expect(tracker.formulaProgress()).toMatchObject({ round: 1, started: true, completed: true })
  })

  it('销毁之后不再订阅', () => {
    const facade = fakeFacade()
    const tracker = createChangeTracker(facade.univer, facade.api, config)
    expect(facade.listenerCount()).toBe(1)
    tracker.dispose()
    expect(facade.listenerCount()).toBe(0)
    facade.fire(userEdit)
    expect(tracker.changeSeq()).toBe(0)
  })
})
