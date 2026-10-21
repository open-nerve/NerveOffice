import { DocSelectionRenderService } from '@univerjs/docs-ui'
import { afterEach, describe, expect, it } from 'vitest'

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

function setup(owner = document) {
  const input = owner.createElement('div')
  input.contentEditable = 'true'
  input.tabIndex = -1
  input.textContent = '输入中'
  const outside = owner.createElement('span')
  outside.textContent = '旧表名'
  owner.body.append(input, outside)
  input.focus()
  // 仅注入 DOM 和 IME 状态，不模拟待测 focus 或 Selection；浏览器用例覆盖实际控制器生命周期。
  const service = Object.create(DocSelectionRenderService.prototype) as DocSelectionRenderService
  Object.assign(service, {
    _input: input,
    _container: input,
    _isIMEInputApply: false,
  })
  const selection = owner.getSelection()!
  const select = (node: Node, start = 0, end = start) => {
    selection.setBaseAndExtent(node, start, node, end)
  }
  return { input, outside, service, selection, select }
}

describe('实际 SDK 的输入焦点恢复', () => {
  it('已聚焦但原生光标还在旧改名控件时，下一次聚焦恢复文字接收位置', () => {
    const h = setup()
    h.select(h.outside.firstChild!, 1)
    expect(document.activeElement).toBe(h.input)
    h.service.focus()
    expect(h.input.contains(h.selection.anchorNode)).toBe(true)
    expect(h.input.contains(h.selection.focusNode)).toBe(true)
    expect(h.selection.isCollapsed).toBe(true)
    expect(h.input.textContent).toBe('输入中')
  })

  it('无原生选区时重新建立可接收文字的位置', () => {
    const h = setup()
    h.selection.removeAllRanges()
    h.service.focus()
    expect(h.input.contains(h.selection.anchorNode)).toBe(true)
    expect(h.selection.rangeCount).toBe(1)
  })

  it('两个端点均在输入框内时保留选中文字及方向', () => {
    const h = setup()
    h.select(h.input.firstChild!, 2, 1)
    h.service.focus()
    expect(h.selection.anchorNode).toBe(h.input.firstChild)
    expect(h.selection.focusNode).toBe(h.input.firstChild)
    expect([h.selection.anchorOffset, h.selection.focusOffset]).toEqual([2, 1])
  })

  it('跨出输入框的原生选区不能被误认为有效输入位置', () => {
    const h = setup()
    h.selection.setBaseAndExtent(h.input.firstChild!, 1, h.outside.firstChild!, 1)
    h.service.focus()
    expect(h.input.contains(h.selection.focusNode)).toBe(true)
    expect(h.selection.isCollapsed).toBe(true)
  })

  it('组合输入期间不重定位浏览器选区或修改草稿', () => {
    const h = setup()
    h.select(h.outside.firstChild!, 1, 2)
    Reflect.set(h.service, '_isIMEInputApply', true)
    h.service.focus()
    expect(h.selection.anchorNode).toBe(h.outside.firstChild)
    expect([h.selection.anchorOffset, h.selection.focusOffset]).toEqual([1, 2])
    expect(h.input.textContent).toBe('输入中')
  })

  it('焦点回调已转移到别的控件时不重新夺取原生光标', () => {
    const h = setup()
    const button = document.createElement('button')
    button.textContent = '下一步'
    document.body.append(button)
    h.input.blur()
    h.input.addEventListener('focus', () => {
      button.focus()
      h.select(button.firstChild!, 1)
    })
    h.service.focus()
    expect(document.activeElement).toBe(button)
    expect(h.selection.anchorNode).toBe(button.firstChild)
    expect(h.selection.anchorOffset).toBe(1)
  })

  it('使用编辑器所属文档，不移动宿主页面的选区', () => {
    const host = setup()
    host.select(host.outside.firstChild!, 1)
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const child = setup(frame.contentDocument!)
    child.select(child.outside.firstChild!, 1)
    child.service.focus()
    expect(child.input.contains(child.selection.anchorNode)).toBe(true)
    expect(host.selection.anchorNode).toBe(host.outside.firstChild)
    expect(host.selection.anchorOffset).toBe(1)
  })
})
