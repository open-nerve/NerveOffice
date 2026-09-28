import { afterEach, describe, expect, it, vi } from 'vitest'
import { blockInteractions } from './interaction-barrier.ts'

function surfaceWithChild(): { surface: HTMLElement, child: HTMLElement } {
  const surface = document.createElement('div')
  const child = document.createElement('div')
  surface.append(child)
  document.body.append(surface)
  return { surface, child }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('编辑器就绪之前的交互屏障（Codex 评审 CX1）', () => {
  it('容器里的输入：取消默认行为，元素与之后挂在窗口上的监听（SDK 的快捷键）都收不到', () => {
    const { surface, child } = surfaceWithChild()
    const release = blockInteractions(surface)
    const onChild = vi.fn()
    const onWindowLater = vi.fn()
    child.addEventListener('keydown', onChild)
    window.addEventListener('keydown', onWindowLater, { capture: true })
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    child.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(onChild).not.toHaveBeenCalled()
    expect(onWindowLater).not.toHaveBeenCalled()
    window.removeEventListener('keydown', onWindowLater, { capture: true })
    release()
  })

  it.each(['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu', 'touchstart', 'keypress', 'keyup', 'beforeinput', 'input', 'compositionstart', 'compositionend', 'paste', 'cut', 'dragover', 'drop'])('%s 同样拦下', (type) => {
    const { surface, child } = surfaceWithChild()
    const release = blockInteractions(surface)
    const onChild = vi.fn()
    child.addEventListener(type, onChild)
    const event = new Event(type, { bubbles: true, cancelable: true })
    child.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(onChild).not.toHaveBeenCalled()
    release()
  })

  it('悬停与滚轮不改内容：不拦', () => {
    const { surface, child } = surfaceWithChild()
    const release = blockInteractions(surface)
    for (const type of ['pointermove', 'wheel', 'focus']) {
      const onChild = vi.fn()
      child.addEventListener(type, onChild)
      child.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))
      expect(onChild, type).toHaveBeenCalledOnce()
    }
    release()
  })

  it('容器之外不拦', () => {
    const { surface } = surfaceWithChild()
    const outside = document.createElement('button')
    document.body.append(outside)
    const release = blockInteractions(surface)
    const onOutside = vi.fn()
    outside.addEventListener('keydown', onOutside)
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    outside.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(onOutside).toHaveBeenCalledOnce()
    release()
  })

  it('撤掉之后照常；可以重复撤掉', () => {
    const { surface, child } = surfaceWithChild()
    const release = blockInteractions(surface)
    release()
    release()
    const onChild = vi.fn()
    child.addEventListener('keydown', onChild)
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    child.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(onChild).toHaveBeenCalledOnce()
  })
})
