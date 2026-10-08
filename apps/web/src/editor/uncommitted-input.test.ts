// 还没写进模型的输入（Codex 评审 CX4，M3-P6 设计 §3.13）：单元格编辑器里的与面板防抖中的合成一个状态；pending 的开始与结束各通知一次，
// 只是打开、关上单元格编辑器不通知
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchUncommittedInput } from './uncommitted-input.ts'

/** 一样可以设、会通知的来源（单元格编辑器里的输入、面板里的输入） */
function source() {
  let value = false
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    onChange: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next: boolean): void {
      value = next
      for (const listener of [...listeners])
        listener()
    },
    listeners: () => listeners.size,
  }
}

function setup() {
  let open = false
  const cell = source()
  const panel = source()
  const watch = watchUncommittedInput({
    cellEditorOpen: () => open,
    cellInput: { hasPendingInput: cell.get, onChange: cell.onChange },
    panelInput: { pending: panel.get, onChange: panel.onChange },
  })
  const listener = vi.fn()
  watch.onChange(listener)
  return { watch, cell, panel, listener, setOpen: (next: boolean) => (open = next) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('还没写进模型的输入（Codex 评审 CX4）', () => {
  it('都没有：none；单元格编辑器只是打开：open，不通知', () => {
    const { watch, listener, setOpen } = setup()
    expect(watch.current()).toBe('none')
    setOpen(true)
    expect(watch.current()).toBe('open')
    expect(listener).not.toHaveBeenCalled()
  })

  it('单元格编辑器里改动了：pending（开着也是），开始与结束各通知一次', () => {
    const { watch, cell, listener, setOpen } = setup()
    setOpen(true)
    cell.set(true)
    expect(watch.current()).toBe('pending')
    expect(listener).toHaveBeenCalledOnce()
    cell.set(false)
    expect(watch.current()).toBe('open')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('面板里防抖中：pending，开始与到点各通知一次', () => {
    const { watch, panel, listener } = setup()
    panel.set(true)
    expect(watch.current()).toBe('pending')
    expect(listener).toHaveBeenCalledOnce()
    panel.set(false)
    expect(watch.current()).toBe('none')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('两样先后、重叠：合成一次——一样结束而另一样还在时仍是 pending、不通知，两样都结束才通知', () => {
    const { watch, cell, panel, listener } = setup()
    panel.set(true)
    cell.set(true)
    expect(listener).toHaveBeenCalledOnce()
    panel.set(false)
    expect(watch.current()).toBe('pending')
    expect(listener).toHaveBeenCalledOnce()
    cell.set(false)
    expect(watch.current()).toBe('none')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('来源通知了而合成的状态没变（例如重复的通知）：不通知', () => {
    const { cell, panel, listener } = setup()
    cell.set(false)
    panel.set(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('监听者抛出的异常交给浏览器的错误报告：不打断来源（SDK 的命令），排在它后面的监听者照样收到', () => {
    const report = vi.fn()
    vi.stubGlobal('reportError', report)
    const { watch, cell } = setup()
    const failure = new Error('页面出错')
    watch.onChange(() => {
      throw failure
    })
    const after = vi.fn()
    watch.onChange(after)
    expect(() => cell.set(true)).not.toThrow()
    expect(report).toHaveBeenCalledExactlyOnceWith(failure)
    expect(after).toHaveBeenCalledOnce()
  })

  it('销毁：退订两样来源，不再通知', () => {
    const { watch, cell, panel, listener } = setup()
    watch.dispose()
    expect([cell.listeners(), panel.listeners()]).toEqual([0, 0])
    cell.set(true)
    panel.set(true)
    expect(listener).not.toHaveBeenCalled()
  })
})
