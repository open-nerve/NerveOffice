// 页面自检在页面上的操作（selftest-dom.ts）：合成的按键带上 SDK 换算绑定要的 keyCode 与按平台取的修饰键；点击与右键的事件顺序；
// 按角色与名称找元素（不用 SDK 的 DOM 标记）；关上之后透明的弹出层不算显示出来。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accessibleName, byExactText, byRole, clickAt, dialogTitled, isShown, keyboardTarget, pressKeys, rightClickAt, sheetTab, univerIsMac, waitFor } from './selftest-dom.ts'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/** 假装页面在这个平台上（Univer 按 navigator.appVersion 判断） */
function onPlatform(appVersion: string): void {
  vi.spyOn(navigator, 'appVersion', 'get').mockReturnValue(appVersion)
}

/** 记下元素收到的事件 */
function record(element: EventTarget, types: readonly string[]): Event[] {
  const events: Event[] = []
  for (const type of types)
    element.addEventListener(type, event => events.push(event))
  return events
}

/** jsdom 不做布局：让元素有一个布局的方框 */
function laidOut<T extends Element>(element: T): T {
  vi.spyOn(element as Element, 'getClientRects').mockReturnValue([{ x: 0, y: 0, width: 10, height: 10 }] as unknown as DOMRectList)
  return element
}

describe('合成的按键', () => {
  it('苹果的平台上主修饰键是 Meta，keyCode 与 which 是组合键的；按下再松开', () => {
    onPlatform('5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    expect(univerIsMac()).toBe(true)
    const target = document.createElement('div')
    const events = record(target, ['keydown', 'keyup']) as KeyboardEvent[]
    pressKeys(target, { key: 'P', code: 'KeyP', keyCode: 80, primary: true, shift: true })
    expect(events.map(event => [event.type, event.keyCode, event.which, event.metaKey, event.ctrlKey, event.shiftKey, event.altKey, event.bubbles]))
      .toEqual([['keydown', 80, 80, true, false, true, false, true], ['keyup', 80, 80, true, false, true, false, true]])
  })

  it('别的平台上主修饰键是 Control；ctrl 在两种平台上都是 Control 键本身', () => {
    onPlatform('5.0 (X11; Linux x86_64)')
    const target = document.createElement('div')
    const events = record(target, ['keydown']) as KeyboardEvent[]
    pressKeys(target, { key: 'z', code: 'KeyZ', keyCode: 90, primary: true })
    pressKeys(target, { key: 'h', code: 'KeyH', keyCode: 72, ctrl: true })
    expect(events.map(event => [event.metaKey, event.ctrlKey])).toEqual([[false, true], [false, true]])
  })

  it('目标：焦点在编辑器的容器里时是焦点所在的元素，否则是画布', () => {
    const surface = document.createElement('div')
    const canvas = document.createElement('canvas')
    canvas.id = 'univer-sheet-main-canvas_unit'
    const input = document.createElement('input')
    surface.append(canvas, input)
    const outside = document.createElement('input')
    document.body.append(surface, outside)
    outside.focus()
    expect(keyboardTarget(surface)).toBe(canvas)
    input.focus()
    expect(keyboardTarget(surface)).toBe(input)
  })
})

describe('合成的指针事件', () => {
  it('左键：pointerdown、mousedown、pointerup、mouseup、click，鼠标的指针（pointerId 1），坐标照给', () => {
    const target = document.createElement('div')
    const events = record(target, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'contextmenu']) as MouseEvent[]
    clickAt(target, 12, 34)
    expect(events.map(event => [event.type, event.button, event.buttons, event.clientX, event.clientY])).toEqual([
      ['pointerdown', 0, 1, 12, 34],
      ['mousedown', 0, 1, 12, 34],
      ['pointerup', 0, 0, 12, 34],
      ['mouseup', 0, 0, 12, 34],
      ['click', 0, 0, 12, 34],
    ])
    expect((events[0] as PointerEvent).pointerId).toBe(1)
    expect((events[0] as PointerEvent).pointerType).toBe('mouse')
  })

  it('右键：按下时就送出 contextmenu（苹果的平台上浏览器的顺序），不送 click', () => {
    const target = document.createElement('div')
    const events = record(target, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'contextmenu']) as MouseEvent[]
    rightClickAt(target, 5, 6)
    expect(events.map(event => [event.type, event.button])).toEqual([['pointerdown', 2], ['mousedown', 2], ['contextmenu', 2], ['pointerup', 2], ['mouseup', 2]])
  })
})

describe('按角色与名称找元素', () => {
  it('可访问的名称：aria-labelledby、aria-label、文字、title 依次', () => {
    document.body.innerHTML = '<h2 id="t">查找</h2><div id="a" aria-labelledby="t">x</div><button id="b" aria-label="Close">×</button><button id="c"> 确定 </button><button id="d" title="切换网格线"></button>'
    expect(['a', 'b', 'c', 'd'].map(id => accessibleName(document.getElementById(id) as Element))).toEqual(['查找', 'Close', '确定', '切换网格线'])
  })

  it('对话框按自己的名称或里面的标题找；按钮按名称完全相同找；文字取最里层', () => {
    document.body.innerHTML = '<div role="dialog" aria-labelledby="h"><h3 id="h">查找</h3><button aria-label="Close"></button></div><div role="dialog"><h1>提示</h1><p><span>这份文档只能查看，不能修改。</span></p><button>确定</button></div>'
    expect(dialogTitled('查找')?.getAttribute('aria-labelledby')).toBe('h')
    const alert = dialogTitled('提示')
    expect(alert).toBeDefined()
    expect(byRole('button', { name: '确定', root: alert })).toHaveLength(1)
    expect(byRole('button', { name: '确', root: alert })).toHaveLength(0)
    expect(byExactText('这份文档只能查看，不能修改。').map(element => element.tagName)).toEqual(['SPAN'])
    expect(dialogTitled('搜索功能')).toBeUndefined()
  })

  it('工作表标签按标签栏的可访问名称（"工作表标签页"）找，功能区的标签页不算', () => {
    document.body.innerHTML = '<div role="tablist" aria-label="功能区"><div role="tab">数据</div></div><div role="tablist" aria-label="工作表标签页"><div role="tab" id="sheet">数据</div></div>'
    expect(sheetTab('数据')?.id).toBe('sheet')
    expect(sheetTab('汇总')).toBeUndefined()
  })

  it('显示出来：看得见、而且它与上层都不是完全透明的（关上的弹出层留在页面上、透明度为 0）', () => {
    document.body.innerHTML = '<section id="popup"><button id="item">重命名</button></section>'
    const popup = document.getElementById('popup') as HTMLElement
    const item = laidOut(document.getElementById('item') as HTMLElement)
    expect(isShown(item)).toBe(true)
    popup.style.opacity = '0'
    expect(isShown(item)).toBe(false)
    popup.style.opacity = '1'
    item.style.visibility = 'hidden'
    expect(isShown(item)).toBe(false)
    expect(isShown(document.createElement('button'))).toBe(false)
  })
})

describe('等待', () => {
  it('条件成立就返回真；到时限还不成立返回假', async () => {
    let ready = false
    setTimeout(() => {
      ready = true
    }, 20)
    expect(await waitFor(() => ready, 1_000, 5)).toBe(true)
    expect(await waitFor(() => false, 30, 5)).toBe(false)
  })
})
