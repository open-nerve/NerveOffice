import type { Page } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginListAutoFocusObservation, installListAutoFocusObserver } from './list-focus-observation.ts'

// 只替换 document/时钟与页面 handle 端口；执行的监听、上限、封存逻辑均为实际 helper。
function documentPort() {
  vi.useFakeTimers()
  let listener: ((event: FocusEvent) => void) | undefined
  const removeEventListener = vi.fn((_type: string, handler: (event: FocusEvent) => void) => {
    if (listener === handler)
      listener = undefined
  })
  const owner = {
    documentElement: { isConnected: true },
    addEventListener: vi.fn((_type: string, handler: (event: FocusEvent) => void) => { listener = handler }),
    removeEventListener,
  }
  vi.stubGlobal('document', owner)
  const target = { matches: vi.fn((selector: string) => selector === '[data-u-comp="sheets-dropdown-list"] input') }
  const emit = (list = true) => listener?.({ target: list ? target : null, isTrusted: false } as unknown as FocusEvent)
  return { owner, emit, target, hasListener: () => listener !== undefined }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('列表焦点被动观察的固定窗口', () => {
  it('实际安装后只记录列表搜索，程序 focus 也不因 isTrusted=false 排除', () => {
    const d = documentPort()
    const observation = installListAutoFocusObserver()
    d.emit(false)
    vi.advanceTimersByTime(12)
    d.emit()
    const result = observation.finish()
    expect(d.target.matches).toHaveBeenCalledWith('[data-u-comp="sheets-dropdown-list"] input')
    expect(result).toEqual({ started: true, sealed: true, elapsedMs: 12, events: [{ atMs: 12, target: 'list-search' }], overflow: false, expired: false })
    expect(d.hasListener()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('第 17 条触发 overflow，长事件流和封存后事件不能增长快照', () => {
    const d = documentPort()
    const observation = installListAutoFocusObserver()
    for (let i = 0; i < 17; i++)
      d.emit()
    for (let i = 0; i < 1000; i++)
      d.emit()
    const result = observation.finish()
    expect(result.events).toHaveLength(16)
    expect(result.overflow).toBe(true)
    expect(result.expired).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
    d.emit()
    expect(observation.finish()).toBe(result)
    expect(result.events).toHaveLength(16)
  })

  it('16 条仍可完整封存，不虚报 overflow', () => {
    const d = documentPort()
    const observation = installListAutoFocusObserver()
    for (let i = 0; i < 16; i++)
      d.emit()
    expect(observation.finish()).toMatchObject({ overflow: false, expired: false, events: Array.from({ length: 16 }, () => ({ atMs: 0, target: 'list-search' })) })
  })

  it('15,000 ms 到期自动移除监听并明确 expired，不能当空记录成功', () => {
    const d = documentPort()
    const observation = installListAutoFocusObserver()
    vi.advanceTimersByTime(14_999)
    expect(d.hasListener()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(d.hasListener()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    d.emit()
    expect(observation.finish()).toEqual({ started: true, sealed: true, elapsedMs: 15_000, events: [], overflow: false, expired: true })
  })

  it('事件循环尚未交付到期 timer 时，实际墙钟到界也必须 expired', () => {
    const d = documentPort()
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const observation = installListAutoFocusObserver()
    now.mockReturnValue(15_000)
    expect(observation.finish()).toMatchObject({ elapsedMs: 15_000, expired: true })
    expect(d.hasListener()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('finish 幂等，提前结束清 timer，后续时间和事件不能重写封存', () => {
    const d = documentPort()
    const observation = installListAutoFocusObserver()
    const result = observation.finish()
    d.emit()
    vi.advanceTimersByTime(15_001)
    expect(observation.finish()).toBe(result)
    expect(result).toMatchObject({ elapsedMs: 0, events: [], expired: false })
    expect(d.owner.removeEventListener).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['replacement', 'detached'] as const)('失效 document 拒绝封存且释放监听（%s）', (mode) => {
    const d = documentPort()
    const observation = installListAutoFocusObserver()
    if (mode === 'replacement')
      vi.stubGlobal('document', {})
    else
      d.owner.documentElement.isConnected = false
    expect(() => observation.finish()).toThrow('list-focus-document-invalid')
    expect(d.hasListener()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('实际页面 handle 的收尾', () => {
  it('一次安装，一次 evaluate/dispose，多次 finish 共用实际封存', async () => {
    const d = documentPort()
    const installed = installListAutoFocusObserver()
    const handle = { evaluate: vi.fn(async (callback: (value: typeof installed) => unknown) => callback(installed)), dispose: vi.fn(async () => {}) }
    const page = { evaluateHandle: vi.fn(async () => handle) }
    const observation = await beginListAutoFocusObservation(page as unknown as Page)
    d.emit()
    const one = observation.finish()
    const two = observation.finish()
    expect(await one).toBe(await two)
    expect(await one).toMatchObject({ started: true, sealed: true, events: [{ atMs: 0, target: 'list-search' }] })
    expect(page.evaluateHandle).toHaveBeenCalledExactlyOnceWith(installListAutoFocusObserver)
    expect(handle.evaluate).toHaveBeenCalledTimes(1)
    expect(handle.dispose).toHaveBeenCalledTimes(1)
    expect(d.hasListener()).toBe(false)
  })

  it('安装拒绝原样传播，不制造一个空的有效窗口', async () => {
    const failure = new Error('navigation-invalidated-install')
    const page = { evaluateHandle: vi.fn(async () => {
      throw failure
    }) }
    await expect(beginListAutoFocusObservation(page as unknown as Page)).rejects.toBe(failure)
  })

  it('封存拒绝仍 dispose，两个错误同时保留且不重复收尾', async () => {
    const evaluation = new Error('execution-context-destroyed')
    const disposal = new Error('handle-dispose-failed')
    const handle = { evaluate: vi.fn(async () => {
      throw evaluation
    }), dispose: vi.fn(async () => {
      throw disposal
    }) }
    const page = { evaluateHandle: vi.fn(async () => handle) }
    const observation = await beginListAutoFocusObservation(page as unknown as Page)
    const result = observation.finish()
    await expect(result).rejects.toMatchObject({ errors: [evaluation, disposal] })
    await expect(observation.finish()).rejects.toMatchObject({ errors: [evaluation, disposal] })
    expect(handle.dispose).toHaveBeenCalledTimes(1)
  })

  it('单个封存错误保持原身份，不被 dispose 覆盖或空 events 替代', async () => {
    const failure = new Error('execution-context-destroyed')
    const handle = { evaluate: vi.fn(async () => {
      throw failure
    }), dispose: vi.fn(async () => {}) }
    const observation = await beginListAutoFocusObservation({ evaluateHandle: async () => handle } as unknown as Page)
    await expect(observation.finish()).rejects.toBe(failure)
    expect(handle.dispose).toHaveBeenCalledTimes(1)
  })
})
