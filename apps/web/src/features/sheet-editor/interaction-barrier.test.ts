import { afterEach, describe, expect, it, vi } from 'vitest'
import { blockInteractions } from './interaction-barrier.ts'

/** 编辑器页的样子：页头、编辑器的容器、Univer 挂在 body 下的浮层 */
function page() {
  const chrome = document.createElement('header')
  const chromeButton = document.createElement('button')
  chrome.append(chromeButton)
  const surface = document.createElement('div')
  const canvas = document.createElement('canvas')
  surface.append(canvas)
  const overlay = document.createElement('div')
  const overlayInput = document.createElement('textarea')
  overlay.append(overlayInput)
  document.body.append(chrome, surface, overlay)
  return { chrome, chromeButton, canvas, overlayInput }
}

/** 在 element 上派发一次事件：返回是否被拦下（默认行为取消、元素上的监听收不到） */
function dispatch(element: EventTarget, event: Event): { prevented: boolean, reached: boolean } {
  let reached = false
  const listener = (): void => {
    reached = true
  }
  element.addEventListener(event.type, listener)
  element.dispatchEvent(event)
  element.removeEventListener(event.type, listener)
  return { prevented: event.defaultPrevented, reached }
}

const BLOCKED = { prevented: true, reached: false }
const OPEN = { prevented: false, reached: true }

const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
const plain = (type: string): Event => new Event(type, { bubbles: true, cancelable: true })

afterEach(() => {
  document.body.replaceChildren()
})

describe('编辑器就绪之前的交互屏障（Codex 评审 CX1，独立复验 N1）', () => {
  it('编辑器的容器里与 body 下的浮层里的输入都拦下：默认行为取消，元素与之后挂在窗口上的监听（SDK 的快捷键）都收不到', () => {
    const { chrome, canvas, overlayInput } = page()
    const release = blockInteractions(chrome)
    const onWindowLater = vi.fn()
    window.addEventListener('keydown', onWindowLater, { capture: true })
    expect(dispatch(canvas, key({ key: 'a' }))).toEqual(BLOCKED)
    expect(dispatch(overlayInput, key({ key: 'a' }))).toEqual(BLOCKED)
    expect(dispatch(document.body, key({ key: 'Delete' }))).toEqual(BLOCKED)
    expect(onWindowLater).not.toHaveBeenCalled()
    window.removeEventListener('keydown', onWindowLater, { capture: true })
    release()
  })

  it.each([
    'pointerdown',
    'pointerup',
    'pointermove',
    'pointerover',
    'mousedown',
    'mouseup',
    'mousemove',
    'mouseover',
    'click',
    'dblclick',
    'contextmenu',
    'touchstart',
    'touchmove',
    'keypress',
    'keyup',
    'beforeinput',
    'input',
    'compositionstart',
    'compositionend',
    'paste',
    'cut',
    'dragstart',
    'dragover',
    'drop',
  ])('%s 同样拦下（悬停也拦：浮层不弹出来）', (type) => {
    const { chrome, canvas, overlayInput } = page()
    const release = blockInteractions(chrome)
    expect(dispatch(canvas, plain(type))).toEqual(BLOCKED)
    expect(dispatch(overlayInput, plain(type))).toEqual(BLOCKED)
    release()
  })

  it('页头里的输入照常', () => {
    const { chrome, chromeButton } = page()
    const release = blockInteractions(chrome)
    expect(dispatch(chromeButton, plain('click'))).toEqual(OPEN)
    expect(dispatch(chromeButton, key({ key: 'Enter' }))).toEqual(OPEN)
    release()
  })

  it.each([
    ['F5', { key: 'F5' }],
    ['Shift+F5', { key: 'F5', shiftKey: true }],
    ['Ctrl+F5', { key: 'F5', ctrlKey: true }],
    ['Ctrl+R', { key: 'r', ctrlKey: true }],
    ['Cmd+Shift+R', { key: 'R', metaKey: true, shiftKey: true }],
    ['Tab', { key: 'Tab' }],
    ['Shift+Tab', { key: 'Tab', shiftKey: true }],
  ])('%s 由浏览器照常处理（不取消默认行为），但不传给 SDK：它的快捷键里 Ctrl/Cmd+R 是向右填充、Tab 是选区右移（第二轮复验）', (_case, init) => {
    const { chrome, canvas } = page()
    const release = blockInteractions(chrome)
    const onWindowLater = vi.fn()
    window.addEventListener('keydown', onWindowLater, { capture: true })
    expect(dispatch(canvas, key(init))).toEqual({ prevented: false, reached: false })
    expect(onWindowLater).not.toHaveBeenCalled()
    window.removeEventListener('keydown', onWindowLater, { capture: true })
    release()
  })

  it('不带 Ctrl/Cmd 的 R、带 Alt 的组合、带 Ctrl 的 Tab 照样拦', () => {
    const { chrome, canvas } = page()
    const release = blockInteractions(chrome)
    expect(dispatch(canvas, key({ key: 'r' }))).toEqual(BLOCKED)
    expect(dispatch(canvas, key({ key: 'r', altKey: true, ctrlKey: true }))).toEqual(BLOCKED)
    expect(dispatch(canvas, key({ key: 'F5', altKey: true }))).toEqual(BLOCKED)
    expect(dispatch(canvas, key({ key: 'Tab', altKey: true }))).toEqual(BLOCKED)
    expect(dispatch(canvas, key({ key: 'Tab', ctrlKey: true }))).toEqual(BLOCKED)
    release()
  })

  it('滚轮与焦点不拦：不改内容；焦点事件拦了，SDK 会以为自己的输入框没有焦点', () => {
    const { chrome, canvas } = page()
    const release = blockInteractions(chrome)
    for (const type of ['wheel', 'focus', 'focusin', 'blur'])
      expect(dispatch(canvas, plain(type)), type).toEqual(OPEN)
    release()
  })

  it('撤掉之后照常；可以重复撤掉', () => {
    const { chrome, canvas } = page()
    const release = blockInteractions(chrome)
    release()
    release()
    expect(dispatch(canvas, key({ key: 'a' }))).toEqual(OPEN)
  })
})
