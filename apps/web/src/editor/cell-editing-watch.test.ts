import type { FUniver } from '@univerjs/core/facade'
import { DeviceInputEventType } from '@univerjs/engine-render'
import { KeyCode } from '@univerjs/ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchCellEditing } from './cell-editing-watch.ts'

const UNIT = 'unit-cx6'

type EventName = 'SheetEditStarted' | 'SheetEditChanging' | 'SheetEditEnded'

/** 假的 Facade：记下订阅，由测试触发编辑事件 */
function fakeUniverAPI() {
  const handlers = new Map<EventName, Set<(params: unknown) => void>>()
  const api = {
    Event: { SheetEditStarted: 'SheetEditStarted', SheetEditChanging: 'SheetEditChanging', SheetEditEnded: 'SheetEditEnded' },
    addEvent(name: EventName, handler: (params: unknown) => void) {
      const set = handlers.get(name) ?? new Set()
      set.add(handler)
      handlers.set(name, set)
      return { dispose: () => set.delete(handler) }
    },
  }
  const workbook = (unitId: string) => ({ getId: () => unitId })
  const fire = (name: EventName, params: Record<string, unknown>, unitId = UNIT): void => {
    for (const handler of handlers.get(name) ?? [])
      handler({ workbook: workbook(unitId), ...params })
  }
  return {
    univerAPI: api as unknown as FUniver,
    started: (eventType: DeviceInputEventType, keycode?: KeyCode, unitId?: string) => fire('SheetEditStarted', { eventType, keycode }, unitId),
    changing: (unitId?: string) => fire('SheetEditChanging', {}, unitId),
    ended: (isConfirm: boolean) => fire('SheetEditEnded', { isConfirm }),
    subscriptions: () => [...handlers.values()].reduce((count, set) => count + set.size, 0),
  }
}

describe('单元格编辑器里还没提交的输入（Codex 评审 CX6）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('键入字符开始编辑：已经是输入；按 Esc 放弃立即没有', () => {
    const fake = fakeUniverAPI()
    const watch = watchCellEditing(fake.univerAPI, UNIT)
    const listener = vi.fn()
    watch.onChange(listener)
    fake.started(DeviceInputEventType.Keyboard, KeyCode.A)
    expect(watch.hasPendingInput()).toBe(true)
    fake.ended(false)
    expect(watch.hasPendingInput()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('退格开始编辑（内容被清空）也是输入', () => {
    const fake = fakeUniverAPI()
    const watch = watchCellEditing(fake.univerAPI, UNIT)
    fake.started(DeviceInputEventType.Keyboard, KeyCode.BACKSPACE)
    expect(watch.hasPendingInput()).toBe(true)
  })

  it.each([
    ['双击', DeviceInputEventType.Dblclick, undefined],
    ['F2', DeviceInputEventType.Keyboard, KeyCode.F2],
    ['点编辑栏', DeviceInputEventType.PointerDown, undefined],
  ])('%s开始编辑：只是打开，编辑中的内容改动之后才算', (_case, eventType, keycode) => {
    const fake = fakeUniverAPI()
    const watch = watchCellEditing(fake.univerAPI, UNIT)
    fake.started(eventType, keycode)
    expect(watch.hasPendingInput()).toBe(false)
    fake.changing()
    expect(watch.hasPendingInput()).toBe(true)
  })

  it('回车提交：再过一个宏任务才清掉（跨工作表的提交是异步写入的，页头不闪"已保存到云端"）', () => {
    const fake = fakeUniverAPI()
    const watch = watchCellEditing(fake.univerAPI, UNIT)
    const listener = vi.fn()
    watch.onChange(listener)
    fake.started(DeviceInputEventType.Keyboard, KeyCode.A)
    fake.ended(true)
    expect(watch.hasPendingInput()).toBe(true)
    vi.runAllTimers()
    expect(watch.hasPendingInput()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('提交之后、清掉之前又开始编辑：以新的一次为准', () => {
    const fake = fakeUniverAPI()
    const watch = watchCellEditing(fake.univerAPI, UNIT)
    fake.started(DeviceInputEventType.Keyboard, KeyCode.A)
    fake.ended(true)
    fake.started(DeviceInputEventType.Keyboard, KeyCode.B)
    vi.runAllTimers()
    expect(watch.hasPendingInput()).toBe(true)
  })

  it('没有输入就提交：不等，也不通知', () => {
    const fake = fakeUniverAPI()
    const watch = watchCellEditing(fake.univerAPI, UNIT)
    const listener = vi.fn()
    watch.onChange(listener)
    fake.started(DeviceInputEventType.Dblclick)
    fake.ended(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(listener).not.toHaveBeenCalled()
  })

  it('别的工作簿的编辑不算', () => {
    const fake = fakeUniverAPI()
    const watch = watchCellEditing(fake.univerAPI, UNIT)
    fake.started(DeviceInputEventType.Keyboard, KeyCode.A, 'another-unit')
    fake.changing('another-unit')
    expect(watch.hasPendingInput()).toBe(false)
  })

  it('监听者抛出的异常交给浏览器的错误报告，不打断 SDK 的命令', () => {
    const report = vi.fn()
    vi.stubGlobal('reportError', report)
    const fake = fakeUniverAPI()
    const watch = watchCellEditing(fake.univerAPI, UNIT)
    const failure = new Error('页面出错')
    watch.onChange(() => {
      throw failure
    })
    expect(() => fake.started(DeviceInputEventType.Keyboard, KeyCode.A)).not.toThrow()
    expect(report).toHaveBeenCalledExactlyOnceWith(failure)
    vi.unstubAllGlobals()
  })

  it('销毁：取消订阅与等待中的清除，不再通知', () => {
    const fake = fakeUniverAPI()
    const watch = watchCellEditing(fake.univerAPI, UNIT)
    const listener = vi.fn()
    watch.onChange(listener)
    fake.started(DeviceInputEventType.Keyboard, KeyCode.A)
    fake.ended(true)
    watch.dispose()
    expect(fake.subscriptions()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(listener).toHaveBeenCalledOnce()
  })
})
