// 组合输入（M3-P4 设计 §3.6）：document 上捕获阶段的 compositionstart、compositionend；组字的元素失焦与页面隐藏时复位；页头里的不算
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchComposition } from './composition-watch.ts'

function compose(target: EventTarget, type: 'compositionstart' | 'compositionend'): void {
  target.dispatchEvent(new CompositionEvent(type, { bubbles: true }))
}

/** 页面：页头（里面有分享的输入框）与编辑器里的输入框（批注、单元格编辑器都是这样的元素） */
function page() {
  document.body.innerHTML = '<header id="chrome"><input id="share"></header><div id="surface"><textarea id="note"></textarea><div id="cell" contenteditable="true"></div></div>'
  const element = (id: string): HTMLElement => {
    const found = document.getElementById(id)
    if (found === null)
      throw new Error(`没有 #${id}`)
    return found
  }
  return { chrome: element('chrome'), share: element('share'), note: element('note'), cell: element('cell') }
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => {
  setVisibility('visible')
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('组合输入（M3-P4 设计 §3.6）', () => {
  it('开始到结束之间是组字中；开始与结束各通知一次', () => {
    const { note } = page()
    const watch = watchComposition(document)
    const listener = vi.fn()
    watch.onChange(listener)
    expect(watch.composing()).toBe(false)
    compose(note, 'compositionstart')
    expect(watch.composing()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    compose(note, 'compositionstart')
    expect(listener).toHaveBeenCalledTimes(1)
    compose(note, 'compositionend')
    expect(watch.composing()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
    watch.dispose()
  })

  it('在捕获阶段收到：SDK 在冒泡阶段截住事件（stopPropagation）也不影响', () => {
    const { cell } = page()
    cell.addEventListener('compositionstart', event => event.stopPropagation())
    const watch = watchComposition(document)
    compose(cell, 'compositionstart')
    expect(watch.composing()).toBe(true)
    watch.dispose()
  })

  it('页头里的组字不算（ignoreWithin），编辑器里的照样算', () => {
    const { chrome, share, note } = page()
    const watch = watchComposition(document, { ignoreWithin: chrome })
    compose(share, 'compositionstart')
    expect(watch.composing()).toBe(false)
    compose(note, 'compositionstart')
    expect(watch.composing()).toBe(true)
    // 页头里的结束不算编辑器里的结束
    compose(share, 'compositionend')
    expect(watch.composing()).toBe(true)
    compose(note, 'compositionend')
    expect(watch.composing()).toBe(false)
    watch.dispose()
  })

  it('组字的元素失焦：复位（浏览器不一定派发 compositionend），通知；别的元素失焦不算', () => {
    const { note, cell } = page()
    const watch = watchComposition(document)
    const listener = vi.fn()
    compose(note, 'compositionstart')
    watch.onChange(listener)
    cell.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    expect(watch.composing()).toBe(true)
    note.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    expect(watch.composing()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
    watch.dispose()
  })

  it('包着组字元素的元素失焦（焦点离开整块）也复位', () => {
    const { note } = page()
    const watch = watchComposition(document)
    compose(note, 'compositionstart')
    note.parentElement?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    expect(watch.composing()).toBe(false)
    watch.dispose()
  })

  it('页面隐藏：复位；回到前台不变', () => {
    const { note } = page()
    const watch = watchComposition(document)
    const listener = vi.fn()
    watch.onChange(listener)
    compose(note, 'compositionstart')
    setVisibility('hidden')
    expect(watch.composing()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
    setVisibility('visible')
    expect(watch.composing()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
    watch.dispose()
  })

  it('监听者抛出的异常交给浏览器的错误报告，不影响别的监听者', () => {
    const report = vi.fn()
    vi.stubGlobal('reportError', report)
    const { note } = page()
    const watch = watchComposition(document)
    const failure = new Error('监听者出错')
    const after = vi.fn()
    watch.onChange(() => {
      throw failure
    })
    watch.onChange(after)
    compose(note, 'compositionstart')
    expect(report).toHaveBeenCalledWith(failure)
    expect(after).toHaveBeenCalledOnce()
    watch.dispose()
  })

  it('销毁之后不再监听，也不再通知', () => {
    const { note } = page()
    const watch = watchComposition(document)
    const listener = vi.fn()
    watch.onChange(listener)
    compose(note, 'compositionstart')
    watch.dispose()
    expect(watch.composing()).toBe(false)
    compose(note, 'compositionend')
    compose(note, 'compositionstart')
    expect(watch.composing()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
