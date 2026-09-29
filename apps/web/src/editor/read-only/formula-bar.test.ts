import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blockFormulaBarInput } from './formula-bar.ts'

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
