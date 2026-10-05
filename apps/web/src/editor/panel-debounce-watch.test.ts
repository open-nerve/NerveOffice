// 面板的防抖（M3-P4 设计 §3.4）：面板开着时的输入才等，等到 SDK 的防抖到点（含余量）；页头里的不算；销毁时放行
import { afterEach, describe, expect, it } from 'vitest'
import { PANEL_DEBOUNCES } from './internal-api/index.ts'
import { PANEL_SETTLE_MARGIN_MS, watchPanelDebounces } from './panel-debounce-watch.ts'

const NOTE_MS = PANEL_DEBOUNCES.find(debounce => debounce.panel === 'note')?.delayMs ?? Number.NaN
const DV_MS = PANEL_DEBOUNCES.find(debounce => debounce.panel === 'data-validation')?.delayMs ?? Number.NaN

/** 假的时钟：schedule 记下计时器，advance 到点执行 */
function fakeTime() {
  let now = 1_000
  const timers: { at: number, callback: () => void, cancelled: boolean }[] = []
  return {
    now: () => now,
    schedule: (callback: () => void, delayMs: number) => {
      const timer = { at: now + delayMs, callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    advance: async (ms: number) => {
      now += ms
      for (const timer of timers.filter(entry => !entry.cancelled && entry.at <= now)) {
        timer.cancelled = true
        timer.callback()
      }
      await new Promise(resolve => setTimeout(resolve, 0))
    },
    pending: () => timers.filter(entry => !entry.cancelled).length,
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

afterEach(() => {
  document.body.innerHTML = ''
})

describe('面板的防抖（M3-P4 设计 §3.4）', () => {
  it('登记的两种面板：批注浮层 300 ms、数据验证面板 1 秒（SDK 的时长）', () => {
    expect(PANEL_DEBOUNCES.map(debounce => [debounce.panel, debounce.selector, debounce.delayMs])).toEqual([
      ['note', 'textarea[data-u-comp="note-textarea"]', 300],
      ['data-validation', '[data-u-comp="data-validation-detail"]', 1000],
    ])
  })

  it('没有面板开着时的输入：不等', async () => {
    const time = fakeTime()
    const { surface } = page()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    surface.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))
    surface.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(watch.pendingUntil()).toBeUndefined()
    await watch.settled()
    expect(time.pending()).toBe(0)
    watch.dispose()
  })

  it('批注浮层开着时键入：等到 300 ms（加余量）之后，从最后一次输入算', async () => {
    const time = fakeTime()
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    note.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await time.advance(200)
    note.dispatchEvent(new InputEvent('input', { bubbles: true }))
    const last = time.now()
    expect(watch.pendingUntil()).toBe(last + NOTE_MS + PANEL_SETTLE_MARGIN_MS)
    const settled = settledFlag(watch.settled())
    await time.advance(NOTE_MS + PANEL_SETTLE_MARGIN_MS - 1)
    expect(settled.done()).toBe(false)
    await time.advance(1)
    expect(settled.done()).toBe(true)
    expect(watch.pendingUntil()).toBeUndefined()
    watch.dispose()
  })

  it('关闭面板之后（SDK 的计时器照样会到点）：在关闭之前的输入照样等', async () => {
    const time = fakeTime()
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    note.dispatchEvent(new InputEvent('input', { bubbles: true }))
    note.remove()
    const settled = settledFlag(watch.settled())
    await time.advance(NOTE_MS)
    expect(settled.done()).toBe(false)
    await time.advance(PANEL_SETTLE_MARGIN_MS)
    expect(settled.done()).toBe(true)
    watch.dispose()
  })

  it('数据验证面板开着时：目标不在面板里的输入（挂在 body 下的下拉框、在表格上选范围）同样算，等 1 秒', async () => {
    const time = fakeTime()
    const { openDataValidation, surface } = page()
    openDataValidation()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    surface.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    expect(watch.pendingUntil()).toBe(time.now() + DV_MS + PANEL_SETTLE_MARGIN_MS)
    watch.dispose()
  })

  it('两种面板都开着：按较长的那一种', () => {
    const time = fakeTime()
    const { openNote, openDataValidation } = page()
    const note = openNote()
    openDataValidation()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    note.dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(watch.pendingUntil()).toBe(time.now() + DV_MS + PANEL_SETTLE_MARGIN_MS)
    watch.dispose()
  })

  it('之前的输入定下的更晚的到点，不被之后较短的覆盖（数据验证面板关掉之后又在批注里键入）', async () => {
    const time = fakeTime()
    const { openNote, openDataValidation } = page()
    const panel = openDataValidation()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    panel.querySelector('input')?.dispatchEvent(new InputEvent('input', { bubbles: true }))
    const dvDue = time.now() + DV_MS + PANEL_SETTLE_MARGIN_MS
    panel.remove()
    await time.advance(100)
    openNote().dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(watch.pendingUntil()).toBe(dvDue)
    watch.dispose()
  })

  it.each(['input', 'change', 'keydown', 'pointerup', 'click', 'paste', 'cut', 'drop', 'compositionend'])('%s 算作面板里的改动', (type) => {
    const time = fakeTime()
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    note.dispatchEvent(new Event(type, { bubbles: true }))
    expect(watch.pendingUntil()).toBeDefined()
    watch.dispose()
  })

  it('目标在页头里的输入不算（按"保存""退出编辑"）', () => {
    const time = fakeTime()
    const { chrome, save, openNote } = page()
    openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule, ignoreWithin: chrome })
    save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    save.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    expect(watch.pendingUntil()).toBeUndefined()
    watch.dispose()
  })

  it('在捕获阶段收到：SDK 截住冒泡也照样记下', () => {
    const time = fakeTime()
    const { openNote } = page()
    const note = openNote()
    note.addEventListener('input', event => event.stopPropagation())
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    note.dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(watch.pendingUntil()).toBeDefined()
    watch.dispose()
  })

  it('销毁：在等的立即放行，之后的输入不再记', async () => {
    const time = fakeTime()
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document, { now: time.now, schedule: time.schedule })
    note.dispatchEvent(new InputEvent('input', { bubbles: true }))
    const settled = settledFlag(watch.settled())
    watch.dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled.done()).toBe(true)
    expect(time.pending()).toBe(0)
    await watch.settled()
  })

  it('默认用 performance.now 与 setTimeout：真的等到点', async () => {
    const { openNote } = page()
    const note = openNote()
    const watch = watchPanelDebounces(document)
    note.dispatchEvent(new InputEvent('input', { bubbles: true }))
    const started = performance.now()
    await watch.settled()
    expect(performance.now() - started).toBeGreaterThanOrEqual(NOTE_MS + PANEL_SETTLE_MARGIN_MS - 5)
    watch.dispose()
  })
})
