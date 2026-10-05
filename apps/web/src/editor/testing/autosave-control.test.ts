// 测试构建的自动保存控制（M3-P4 设计 §3.14）：打开时是否暂停按 sessionStorage；hold、release、setLimits 通知调度；flush 调当前的调度；日志
import type { AutosaveControl, AutosaveControlLimits, AutosaveLogEntry } from './autosave-control.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTOSAVE_CONTROL_GLOBAL, AUTOSAVE_HELD, AUTOSAVE_HOLD_STORAGE_KEY, installAutosaveControl } from './autosave-control.ts'

const DEFAULTS: AutosaveControlLimits = { captureQuietMs: 1000, captureMaxMs: 3000, captureSpacingFactor: 10, uploadQuietMs: 2000, uploadMaxMs: 15_000, retryInitialMs: 2000, retryMaxMs: 60_000 }

function onWindow(): AutosaveControl {
  return (window as unknown as Record<string, AutosaveControl>)[AUTOSAVE_CONTROL_GLOBAL] as AutosaveControl
}

afterEach(() => {
  sessionStorage.clear()
  delete (window as unknown as Record<string, unknown>)[AUTOSAVE_CONTROL_GLOBAL]
  vi.restoreAllMocks()
})

describe('测试构建的自动保存控制（M3-P4 设计 §3.14）', () => {
  it('挂在 window 上；打开时是否暂停按 sessionStorage（E2E 经 addInitScript 写入），默认不暂停', () => {
    expect(installAutosaveControl(window, DEFAULTS).tuning.held()).toBe(false)
    expect(onWindow().held()).toBe(false)
    sessionStorage.setItem(AUTOSAVE_HOLD_STORAGE_KEY, AUTOSAVE_HELD)
    const installed = installAutosaveControl(window, DEFAULTS)
    expect(installed.tuning.held()).toBe(true)
    expect(onWindow()).toBe(installed.control)
  })

  it('sessionStorage 读不了（隐私模式等）：不暂停', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(installAutosaveControl(window, DEFAULTS).tuning.held()).toBe(false)
  })

  it('hold、release、setLimits、resetLimits：调度经 tuning 读到，并收到通知', () => {
    const installed = installAutosaveControl(window, DEFAULTS)
    const changed = vi.fn()
    installed.tuning.onChange(changed)
    const control = onWindow()
    control.hold()
    expect(installed.tuning.held()).toBe(true)
    control.release()
    expect(installed.tuning.held()).toBe(false)
    control.setLimits({ captureMaxMs: 50 })
    expect(installed.tuning.limits()).toEqual({ ...DEFAULTS, captureMaxMs: 50 })
    expect(control.limits().captureMaxMs).toBe(50)
    control.resetLimits()
    expect(installed.tuning.limits()).toEqual(DEFAULTS)
    expect(changed).toHaveBeenCalledTimes(4)
  })

  it('flush 调当前的调度的 flush("control")；没有当前的调度（不在编辑）时交回 undefined', async () => {
    const installed = installAutosaveControl(window, DEFAULTS)
    const control = onWindow()
    await expect(control.flush()).resolves.toBeUndefined()
    expect(control.attached()).toBe(false)
    const flush = vi.fn(async () => ({ edits: true, formulas: true, outcome: { kind: 'saved', requestId: 'r-1' } }))
    installed.attach({ flush })
    expect(control.attached()).toBe(true)
    await expect(control.flush()).resolves.toEqual({ edits: true, formulas: true, outcome: { kind: 'saved', requestId: 'r-1' } })
    expect(flush).toHaveBeenCalledExactlyOnceWith('control')
    installed.attach(undefined)
    await expect(control.flush()).resolves.toBeUndefined()
  })

  it('日志：每次捕获与上传各一条，交出的是拷贝；clearLog 清空；至多留 2000 条（最新的）', () => {
    const installed = installAutosaveControl(window, DEFAULTS)
    const control = onWindow()
    const outcome = { kind: 'saved', requestId: 'r-1' }
    const capture: AutosaveLogEntry = { kind: 'capture', trigger: 'quiet', at: 10, seq: 1, formulasPending: false, bytes: 20, durationMs: 1 }
    const upload: AutosaveLogEntry = { kind: 'upload', trigger: 'quiet', startedAt: 11, at: 30, seq: 1, outcome }
    installed.observe(capture)
    installed.observe(upload)
    const log = control.log()
    expect(log).toEqual([capture, upload])
    expect(log[1]).not.toBe(upload)
    control.clearLog()
    expect(control.log()).toEqual([])
    for (let index = 0; index < 2005; index += 1)
      installed.observe({ kind: 'capture-failed', trigger: 'cap', at: index })
    const kept = control.log()
    expect(kept).toHaveLength(2000)
    expect(kept[0]).toMatchObject({ at: 5 })
  })
})
