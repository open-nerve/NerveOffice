import type { FormulaBarServices } from './formula-bar.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY, FOCUSING_FX_BAR_EDITOR } from '../internal-api/index.ts'
import { blockFormulaBarInput, releaseFormulaBarEditor } from './formula-bar.ts'

/** 按 sheets-ui 编辑栏的结构（FormulaBar.tsx）造一个：名称框、左边的按钮、编辑框（外层是 SDK 处理按下的元素） */
function formulaBar(): { readonly bar: HTMLElement, readonly nameBox: HTMLInputElement, readonly button: HTMLElement, readonly wrapper: HTMLElement, readonly input: HTMLElement } {
  const bar = document.createElement('div')
  bar.dataset.uComp = 'formula-bar'
  bar.innerHTML = [
    '<div data-u-comp="defined-name"><input value="A1"></div>',
    '<div data-u-comp="formula-bar-actions"><span class="fx">fx</span></div>',
    '<div class="wrapper"><div data-u-comp="formula-editor"><div class="input" contenteditable="true"></div></div></div>',
  ].join('')
  document.body.append(bar)
  const pick = <T extends Element>(selector: string): T => {
    const element = bar.querySelector<T>(selector)
    if (element === null)
      throw new Error(`编辑栏里没有 ${selector}`)
    return element
  }
  return { bar, nameBox: pick('input'), button: pick('.fx'), wrapper: pick('.wrapper'), input: pick('.input') }
}

function fire(target: Element, type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

let stop: () => void = () => {}

beforeEach(() => {
  stop = blockFormulaBarInput()
})

afterEach(() => {
  stop()
  document.body.replaceChildren()
})

describe('只读时编辑栏点不进去（SDK 的 DOM 标记 formula-bar、formula-editor、formula-bar-actions）', () => {
  it.each(['pointerdown', 'mousedown', 'click', 'dblclick'])('落在编辑框里的 %s：SDK 的处理（外层与编辑框自己的）收不到，默认行为（聚焦）被阻止', (type) => {
    const { wrapper, input } = formulaBar()
    const onWrapper = vi.fn()
    const onInput = vi.fn()
    wrapper.addEventListener(type, onWrapper)
    input.addEventListener(type, onInput)
    expect(fire(input, type).defaultPrevented).toBe(true)
    expect(onWrapper).not.toHaveBeenCalled()
    expect(onInput).not.toHaveBeenCalled()
  })

  it('左边的取消、确认、插入函数按钮同样收不到点击', () => {
    const { button } = formulaBar()
    const onButton = vi.fn()
    button.addEventListener('click', onButton)
    expect(fire(button, 'click').defaultPrevented).toBe(true)
    expect(onButton).not.toHaveBeenCalled()
  })

  it('名称框与编辑栏之外照常', () => {
    const { nameBox } = formulaBar()
    const elsewhere = document.createElement('canvas')
    document.body.append(elsewhere)
    const received = vi.fn()
    nameBox.addEventListener('pointerdown', received)
    elsewhere.addEventListener('pointerdown', received)
    expect(fire(nameBox, 'pointerdown').defaultPrevented).toBe(false)
    expect(fire(elsewhere, 'pointerdown').defaultPrevented).toBe(false)
    expect(received).toHaveBeenCalledTimes(2)
  })

  it('单元格编辑器里同样标记的 formula-editor（不在编辑栏里）照常：按编辑栏的根元素限定', () => {
    formulaBar()
    const cellEditor = document.createElement('div')
    cellEditor.innerHTML = '<div data-u-comp="formula-editor"><div class="input" contenteditable="true"></div></div>'
    document.body.append(cellEditor)
    const input = cellEditor.querySelector('.input')
    if (input === null)
      throw new Error('没有造出单元格编辑器的编辑框')
    const received = vi.fn()
    input.addEventListener('pointerdown', received)
    expect(fire(input, 'pointerdown').defaultPrevented).toBe(false)
    expect(received).toHaveBeenCalledOnce()
  })

  it('不拦松开：查找面板等拖动靠页面上的 mouseup 结束', () => {
    const { input } = formulaBar()
    const onDocument = vi.fn()
    document.addEventListener('mouseup', onDocument)
    expect(fire(input, 'mouseup').defaultPrevented).toBe(false)
    document.removeEventListener('mouseup', onDocument)
    expect(onDocument).toHaveBeenCalledOnce()
  })

  it('撤掉之后照常；可以重复撤掉', () => {
    const { input } = formulaBar()
    const onInput = vi.fn()
    input.addEventListener('pointerdown', onInput)
    stop()
    stop()
    expect(fire(input, 'pointerdown').defaultPrevented).toBe(false)
    expect(onInput).toHaveBeenCalledOnce()
  })
})

/** 假的编辑器管理服务：focus 与 SDK 一样先记下焦点、再送出 focus$；blur 清掉焦点（force 记下来） */
function fakeEditors(focused: string | null = null) {
  let focusId = focused
  const listeners = new Set<() => void>()
  const blur = vi.fn((_force?: boolean) => {
    focusId = null
  })
  const editors = {
    focus$: {
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return { unsubscribe: () => listeners.delete(listener) }
      },
    },
    getFocusId: () => focusId,
    blur,
  }
  const focus = (id: string): void => {
    focusId = id
    for (const listener of [...listeners])
      listener()
  }
  return { editors: editors as unknown as FormulaBarServices['editors'], focus, blur, subscribers: () => listeners.size, setFocusId: (id: string | null) => focusId = id }
}

function fakeContext() {
  const setContextValue = vi.fn<(key: string, value: boolean) => void>()
  return { context: { setContextValue } as FormulaBarServices['context'], setContextValue }
}

/** 等排队的微任务执行完 */
async function microtasks(): Promise<void> {
  await Promise.resolve()
}

describe('只读时编辑栏的编辑器一被聚焦就放开（P3 审查 A1：在别处按下、在编辑框上松开也会聚焦）', () => {
  it('焦点落到编辑栏的编辑器：当前的处理完之后（微任务里）blur(true)，复位 FOCUSING_FX_BAR_EDITOR', async () => {
    const editors = fakeEditors()
    const { context, setContextValue } = fakeContext()
    const stop = releaseFormulaBarEditor({ editors: editors.editors, context })
    editors.focus(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY)
    // SDK 在聚焦之后还要移 DOM 的焦点、设光标，组件渲染之后再置一次 EDITOR_ACTIVATED：同步的部分不放开
    expect(editors.blur).not.toHaveBeenCalled()
    await microtasks()
    expect(editors.blur).toHaveBeenCalledExactlyOnceWith(true)
    expect(setContextValue).toHaveBeenCalledExactlyOnceWith(FOCUSING_FX_BAR_EDITOR, false)
    stop()
  })

  it('别的编辑器被聚焦（单元格编辑器等）：不管', async () => {
    const editors = fakeEditors()
    const { context, setContextValue } = fakeContext()
    const stop = releaseFormulaBarEditor({ editors: editors.editors, context })
    editors.focus('__INTERNAL_EDITOR__DOCS_NORMAL')
    await microtasks()
    expect(editors.blur).not.toHaveBeenCalled()
    expect(setContextValue).not.toHaveBeenCalled()
    stop()
  })

  it('排队期间焦点已经离开编辑栏：不再 blur（免得放开之后聚焦的编辑器），上下文照样复位', async () => {
    const editors = fakeEditors()
    const { context, setContextValue } = fakeContext()
    const stop = releaseFormulaBarEditor({ editors: editors.editors, context })
    editors.focus(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY)
    editors.setFocusId('__INTERNAL_EDITOR__DOCS_NORMAL')
    await microtasks()
    expect(editors.blur).not.toHaveBeenCalled()
    expect(setContextValue).toHaveBeenCalledExactlyOnceWith(FOCUSING_FX_BAR_EDITOR, false)
    stop()
  })

  it('装上时已经聚焦在编辑栏（M3 的原地切换）：立即放开', () => {
    const editors = fakeEditors(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY)
    const { context, setContextValue } = fakeContext()
    const stop = releaseFormulaBarEditor({ editors: editors.editors, context })
    expect(editors.blur).toHaveBeenCalledExactlyOnceWith(true)
    expect(setContextValue).toHaveBeenCalledExactlyOnceWith(FOCUSING_FX_BAR_EDITOR, false)
    stop()
  })

  it('撤掉之后不再放开，已经排队的也不执行；可以重复撤掉', async () => {
    const editors = fakeEditors()
    const { context, setContextValue } = fakeContext()
    const stop = releaseFormulaBarEditor({ editors: editors.editors, context })
    editors.focus(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY)
    stop()
    stop()
    expect(editors.subscribers()).toBe(0)
    await microtasks()
    editors.setFocusId(null)
    editors.focus(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY)
    await microtasks()
    expect(editors.blur).not.toHaveBeenCalled()
    expect(setContextValue).not.toHaveBeenCalled()
  })
})
