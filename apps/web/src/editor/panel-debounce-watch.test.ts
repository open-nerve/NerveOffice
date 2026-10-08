// 面板的防抖（M3-P4 设计 §3.4；Codex 评审 CX4，M3-P6 设计 §3.13）：面板开着时的输入才算，到 SDK 的防抖到点（含余量）之前是"防抖中"，
// 开始与到点各通知一次；settled 等调用时的到点；页头里的不算；销毁时放行、不再通知
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PANEL_DEBOUNCES } from './internal-api/index.ts'
import { PANEL_SETTLE_MARGIN_MS, watchPanelDebounces } from './panel-debounce-watch.ts'

const NOTE_MS = PANEL_DEBOUNCES.find(debounce => debounce.panel === 'note')?.delayMs ?? Number.NaN
const DV_MS = PANEL_DEBOUNCES.find(debounce => debounce.panel === 'data-validation')?.delayMs ?? Number.NaN

/**
 * 假的时钟：schedule 记下计时器，advance 到点执行；early 让计时器比它排定的时刻早 early 毫秒执行（时钟与计时器有出入）。
 * fired 是执行过的计时器个数（用例据此核对自己的前提：计时器确实早到执行过）
 */
function fakeTime(early = 0) {
  let now = 1_000
  let fired = 0
  const timers: { at: number, callback: () => void, cancelled: boolean }[] = []
  return {
    now: () => now,
    schedule: (callback: () => void, delayMs: number) => {
      const timer = { at: now + delayMs - early, callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    advance: async (ms: number) => {
      now += ms
      for (const timer of timers.filter(entry => !entry.cancelled && entry.at <= now)) {
        timer.cancelled = true
        fired += 1
        timer.callback()
      }
      await new Promise(resolve => setTimeout(resolve, 0))
    },
    pending: () => timers.filter(entry => !entry.cancelled).length,
    fired: () => fired,
  }
}

/** 页面：页头、表格的容器，以及按需打开的批注浮层与数据验证面板（SDK 的 DOM 标记） */
function page() {
  document.body.innerHTML = '<header id="chrome"><button id="save">保存</button></header><div id="surface"></div>'
  const byId = (id: string): HTMLElement => document.getElementById(id) ?? document.body
  return {
    chrome: byId('chrome'),
    save: byId('save'),
    surface: byId('surface'),
    openNote: (): HTMLTextAreaElement => {
      const note = document.createElement('textarea')
      note.dataset.uComp = 'note-textarea'
      document.body.append(note)
      return note
    },
    openDataValidation: (): HTMLElement => {
      const panel = document.createElement('div')
      panel.dataset.uComp = 'data-validation-detail'
      panel.innerHTML = '<input id="dv-input">'
      document.body.append(panel)
      return panel
    },
  }
}

function settledFlag(promise: Promise<void>): { readonly done: () => boolean } {
  let done = false
  void promise.then(() => {
    done = true
  })
  return { done: () => done }
}

function typeInto(element: Element): void {
  element.dispatchEvent(new InputEvent('input', { bubbles: true }))
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('面板的防抖（M3-P4 设计 §3.4）', () => {
  it('登记的两种面板：批注浮层 300 ms、数据验证面板 1 秒（SDK 的时长）', () => {
    expect(PANEL_DEBOUNCES.map(debounce => [debounce.panel, debounce.selector, debounce.delayMs])).toEqual([
      ['note', 'textarea[data-u-comp="note-textarea"]', 300],
      ['data-validation', '[data-u-comp="data-validation-detail"]', 1000],
    ])
  })

  it('没有面板开着时的输入：不算防抖中，不等也不通知', async () => {
    const time = fakeTime()
    const { surface } = page()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    const listener = vi.fn()
    watch.onChange(listener)
    surface.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))
    surface.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(watch.pending()).toBe(false)
    await watch.settled()
    expect(time.pending()).toBe(0)
    expect(listener).not.toHaveBeenCalled()
    watch.dispose()
  })

  it('批注浮层开着时键入：防抖中，到 300 ms（加余量）才到点，从最后一次输入算；settled 同时兑现', async () => {
    const time = fakeTime()
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    typeInto(note)
    await time.advance(200)
    typeInto(note)
    const settled = settledFlag(watch.settled())
    await time.advance(NOTE_MS + PANEL_SETTLE_MARGIN_MS - 1)
    expect(watch.pending()).toBe(true)
    expect(settled.done()).toBe(false)
    await time.advance(1)
    expect(watch.pending()).toBe(false)
    expect(settled.done()).toBe(true)
    expect(time.pending()).toBe(0)
    watch.dispose()
  })

  it('关闭面板之后（SDK 的计时器照样会到点）：在关闭之前的输入照样算到点', async () => {
    const time = fakeTime()
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    typeInto(note)
    note.remove()
    const settled = settledFlag(watch.settled())
    await time.advance(NOTE_MS)
    expect(watch.pending()).toBe(true)
    expect(settled.done()).toBe(false)
    await time.advance(PANEL_SETTLE_MARGIN_MS)
    expect(watch.pending()).toBe(false)
    expect(settled.done()).toBe(true)
    watch.dispose()
  })

  it('数据验证面板开着时：目标不在面板里的输入（挂在 body 下的下拉框、在表格上选范围）同样算，到 1 秒（加余量）才到点', async () => {
    const time = fakeTime()
    const { openDataValidation, surface } = page()
    openDataValidation()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    surface.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    await time.advance(DV_MS + PANEL_SETTLE_MARGIN_MS - 1)
    expect(watch.pending()).toBe(true)
    await time.advance(1)
    expect(watch.pending()).toBe(false)
    watch.dispose()
  })

  it('两种面板都开着：按较长的那一种', async () => {
    const time = fakeTime()
    const { openNote, openDataValidation } = page()
    const note = openNote()
    openDataValidation()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    typeInto(note)
    await time.advance(NOTE_MS + PANEL_SETTLE_MARGIN_MS)
    expect(watch.pending()).toBe(true)
    await time.advance(DV_MS - NOTE_MS)
    expect(watch.pending()).toBe(false)
    watch.dispose()
  })

  it('之前的输入定下的更晚的到点，不被之后较短的覆盖（数据验证面板关掉之后又在批注里键入）', async () => {
    const time = fakeTime()
    const { openNote, openDataValidation } = page()
    const panel = openDataValidation()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    typeInto(panel.querySelector('input') ?? panel)
    panel.remove()
    await time.advance(100)
    typeInto(openNote())
    await time.advance(DV_MS + PANEL_SETTLE_MARGIN_MS - 101)
    expect(watch.pending()).toBe(true)
    await time.advance(1)
    expect(watch.pending()).toBe(false)
    watch.dispose()
  })

  it.each(['input', 'change', 'keydown', 'pointerup', 'click', 'paste', 'cut', 'drop', 'compositionend'])('%s 算作面板里的改动', (type) => {
    const time = fakeTime()
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    note.dispatchEvent(new Event(type, { bubbles: true }))
    expect(watch.pending()).toBe(true)
    watch.dispose()
  })

  it('目标在页头里的输入不算（按"保存""退出编辑"）', () => {
    const time = fakeTime()
    const { chrome, save, openNote } = page()
    openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule, ignoreWithin: chrome })
    save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    save.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    expect(watch.pending()).toBe(false)
    expect(time.pending()).toBe(0)
    watch.dispose()
  })

  it('在捕获阶段收到：SDK 截住冒泡也照样记下', () => {
    const time = fakeTime()
    const { openNote } = page()
    const note = openNote()
    note.addEventListener('input', event => event.stopPropagation())
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    typeInto(note)
    expect(watch.pending()).toBe(true)
    watch.dispose()
  })

  it('默认用 performance.now 与 setTimeout：真的等到点', async () => {
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document)
    typeInto(note)
    const started = performance.now()
    await watch.settled()
    expect(performance.now() - started).toBeGreaterThanOrEqual(NOTE_MS + PANEL_SETTLE_MARGIN_MS - 5)
    expect(watch.pending()).toBe(false)
    watch.dispose()
  })
})

describe('防抖中的状态与通知（Codex 评审 CX4）：开始与到点各通知一次', () => {
  it('第一次输入通知一次（防抖开始）；期间再输入只把到点往后推、不通知；到点通知一次（防抖结束）', async () => {
    const time = fakeTime()
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    const seen: boolean[] = []
    watch.onChange(() => seen.push(watch.pending()))
    typeInto(note)
    expect(seen).toEqual([true])
    await time.advance(100)
    typeInto(note)
    await time.advance(100)
    typeInto(note)
    expect(seen).toEqual([true])
    await time.advance(NOTE_MS + PANEL_SETTLE_MARGIN_MS)
    expect(seen).toEqual([true, false])
    // 到点之后再输入：又一次开始
    typeInto(note)
    expect(seen).toEqual([true, false, true])
    watch.dispose()
  })

  it('到点之前先通知、再放行在等的 settled：它们的后续看到的已经是到点之后的状态', async () => {
    const time = fakeTime()
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    const order: string[] = []
    watch.onChange(() => order.push(`通知：${String(watch.pending())}`))
    typeInto(note)
    const settled = watch.settled().then(() => order.push(`放行：${String(watch.pending())}`))
    await time.advance(NOTE_MS + PANEL_SETTLE_MARGIN_MS)
    await settled
    expect(order).toEqual(['通知：true', '通知：false', '放行：false'])
    watch.dispose()
  })

  it('计时器早到（时钟与计时器有出入）：没到点就接着等剩下的，不提前说写进了模型', async () => {
    const time = fakeTime(5)
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    const listener = vi.fn()
    watch.onChange(listener)
    typeInto(note)
    const settled = settledFlag(watch.settled())
    await time.advance(NOTE_MS + PANEL_SETTLE_MARGIN_MS - 5)
    // 前提：计时器确实在到点之前执行过一次（之后接着等剩下的）
    expect(time.fired()).toBe(1)
    expect(watch.pending()).toBe(true)
    expect(settled.done()).toBe(false)
    expect(listener).toHaveBeenCalledOnce()
    await time.advance(5)
    expect(watch.pending()).toBe(false)
    expect(settled.done()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
    watch.dispose()
  })

  it('settled 等的是调用时的到点：之后的输入把到点往后推，它照样在原来的到点兑现，防抖中的状态留到新的到点', async () => {
    const time = fakeTime()
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    typeInto(note)
    const settled = settledFlag(watch.settled())
    await time.advance(200)
    typeInto(note)
    await time.advance(NOTE_MS + PANEL_SETTLE_MARGIN_MS - 200)
    expect(settled.done()).toBe(true)
    expect(watch.pending()).toBe(true)
    await time.advance(200)
    expect(watch.pending()).toBe(false)
    watch.dispose()
  })

  it('监听者抛出的异常交给浏览器的错误报告：照样到点、别的监听者照样收到，在等的照样放行', async () => {
    const report = vi.fn()
    vi.stubGlobal('reportError', report)
    const time = fakeTime()
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    const failure = new Error('页面出错')
    watch.onChange(() => {
      throw failure
    })
    const other = vi.fn()
    watch.onChange(other)
    typeInto(note)
    const settled = settledFlag(watch.settled())
    await time.advance(NOTE_MS + PANEL_SETTLE_MARGIN_MS)
    expect(watch.pending()).toBe(false)
    expect(settled.done()).toBe(true)
    expect(other).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenCalledWith(failure)
    watch.dispose()
  })

  it('退订之后不再通知', async () => {
    const time = fakeTime()
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    const listener = vi.fn()
    const unsubscribe = watch.onChange(listener)
    unsubscribe()
    typeInto(note)
    await time.advance(NOTE_MS + PANEL_SETTLE_MARGIN_MS)
    expect(listener).not.toHaveBeenCalled()
    watch.dispose()
  })

  it('销毁：防抖中的清掉、不通知，在等的立即放行，计时器撤掉，之后的输入不再记', async () => {
    const time = fakeTime()
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    const listener = vi.fn()
    watch.onChange(listener)
    typeInto(note)
    const settled = settledFlag(watch.settled())
    watch.dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled.done()).toBe(true)
    expect(watch.pending()).toBe(false)
    expect(time.pending()).toBe(0)
    typeInto(note)
    await time.advance(NOTE_MS + PANEL_SETTLE_MARGIN_MS)
    expect(watch.pending()).toBe(false)
    expect(listener).toHaveBeenCalledOnce()
    await watch.settled()
  })
})
