import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPageGuards, isApplePlatform, isSaveShortcut } from './page-guards.ts'

const key = (init: Partial<Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>>) => ({ key: 's', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...init })

describe('保存的快捷键', () => {
  it('苹果的平台是 Cmd+S，其他平台是 Ctrl+S', () => {
    expect(isSaveShortcut(key({ metaKey: true }), true)).toBe(true)
    expect(isSaveShortcut(key({ ctrlKey: true }), true)).toBe(false)
    expect(isSaveShortcut(key({ ctrlKey: true }), false)).toBe(true)
    expect(isSaveShortcut(key({ metaKey: true }), false)).toBe(false)
    expect(isSaveShortcut(key({ ctrlKey: true, key: 'S' }), false)).toBe(true)
  })

  it('带别的修饰键、输入法组字、别的键：不算', () => {
    expect(isSaveShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false)
    expect(isSaveShortcut(key({ ctrlKey: true, altKey: true }), false)).toBe(false)
    expect(isSaveShortcut(key({ ctrlKey: true, metaKey: true }), false)).toBe(false)
    expect(isSaveShortcut(key({ ctrlKey: true, isComposing: true }), false)).toBe(false)
    expect(isSaveShortcut(key({ ctrlKey: true, key: 'k' }), false)).toBe(false)
    expect(isSaveShortcut(key({}), false)).toBe(false)
  })

  it('按平台的标识判断', () => {
    for (const platform of ['MacIntel', 'iPhone', 'iPad'])
      expect(isApplePlatform(platform), platform).toBe(true)
    for (const platform of ['Win32', 'Linux x86_64', ''])
      expect(isApplePlatform(platform), platform).toBe(false)
  })
})

describe('快捷键与离开提示的监听', () => {
  const uninstalls: (() => void)[] = []
  afterEach(() => uninstalls.splice(0).forEach(uninstall => uninstall()))

  function install(unsaved = false) {
    const page = { save: vi.fn(async () => {}), hasUnsavedWork: vi.fn(() => unsaved) }
    uninstalls.push(installPageGuards(window, page, false))
    return page
  }

  it('捕获阶段收到 Ctrl+S：阻止浏览器的默认行为（另存网页），保存一次', () => {
    const page = install()
    const input = document.createElement('div')
    input.addEventListener('keydown', event => event.stopPropagation())
    document.body.append(input)
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    input.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(page.save).toHaveBeenCalledOnce()
    input.remove()
  })

  it('别的按键不管', () => {
    const page = install()
    const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(page.save).not.toHaveBeenCalled()
  })

  it('有未保存的修改：离开时由浏览器提示；没有时不提示', () => {
    install(true)
    const leaving = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leaving)
    expect(leaving.defaultPrevented).toBe(true)
    uninstalls.splice(0).forEach(uninstall => uninstall())

    install(false)
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
  })

  it('撤销之后不再监听', () => {
    const page = install(true)
    uninstalls.splice(0).forEach(uninstall => uninstall())
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }))
    expect(page.save).not.toHaveBeenCalled()
  })
})
