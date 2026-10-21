// eslint-disable-next-line no-restricted-imports -- 仅测试以原文读取固定发布包的未导出函数；ADR-010/UR-040 登记，不作为宿主 SDK 接线。
import cjs from '@univerjs/sheets-ui/lib/cjs/index.js?raw'
// eslint-disable-next-line no-restricted-imports -- 与 CJS 同一边界，核对实际 ES 发布实现；测试文件不进入生产产物。
import es from '@univerjs/sheets-ui/lib/es/index.js?raw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 该内部函数没有发布导出。执行固定发布包的唯一真实声明，不复制它或新增生产测试接点。
function publishedSelectAll(source: string): (input: HTMLElement) => void {
  const prefix = 'function keepTextSelected(inputHtml) {'
  if (source.split(prefix).length !== 2)
    throw new Error('发布包表名全选函数不再唯一，必须重新核对 SDK 边界')
  const start = source.indexOf(prefix)
  const end = source.indexOf('\n}', start)
  if (end === -1)
    throw new Error('发布包表名全选函数边界变化')
  // eslint-disable-next-line no-new-func, ts/no-implied-eval -- 仅执行已界定的固定包纯 DOM 函数，以验证真实定时任务；无外部输入，也不复制 SDK 实现。
  const load = new Function(`${source.slice(start, end + 2)}\nreturn keepTextSelected`) as () => (input: HTMLElement) => void
  return load()
}

function setup(owner = document) {
  const input = owner.createElement('span')
  input.setAttribute('contenteditable', 'true')
  input.tabIndex = -1
  input.textContent = '数据'
  const outside = owner.createElement('button')
  outside.textContent = '其他控件'
  owner.body.append(input, outside)
  input.focus()
  const selection = owner.getSelection()!
  const caret = (node: Node, offset: number) => selection.setBaseAndExtent(node, offset, node, offset)
  caret(input.firstChild!, 1)
  return { input, outside, selection, caret }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe.each([['ES', es], ['CJS', cjs]])('实际 %s SDK 的延后表名全选', (_format, source) => {
  const selectAll = publishedSelectAll(source)

  it('尚未发生后续操作时照常全选初始表名', () => {
    const h = setup()
    selectAll(h.input)
    vi.runAllTimers()
    expect(h.selection.toString()).toBe('数据')
    expect(h.input.textContent).toBe('数据')
  })

  it('已经输入首字时保留原生光标，后续字符不会覆盖首字', () => {
    const h = setup()
    selectAll(h.input)
    h.input.textContent = '源'
    h.caret(h.input.firstChild!, 1)
    h.input.dispatchEvent(new InputEvent('input', { data: '源', bubbles: true }))
    vi.runAllTimers()
    expect(h.selection.isCollapsed).toBe(true)
    expect(h.selection.anchorNode).toBe(h.input.firstChild)
    expect(h.selection.anchorOffset).toBe(1)
  })

  it.each(['keydown', 'beforeinput', 'compositionstart', 'pointerdown'])('后续 %s 即使尚未改字，也不能被旧全选重设光标', (type) => {
    const h = setup()
    selectAll(h.input)
    h.input.dispatchEvent(new Event(type, { bubbles: true }))
    vi.runAllTimers()
    expect(h.selection.isCollapsed).toBe(true)
    expect(h.selection.anchorNode).toBe(h.input.firstChild)
    expect(h.selection.anchorOffset).toBe(1)
  })

  it('外部更新正文后旧任务也不再选中新正文', () => {
    const h = setup()
    selectAll(h.input)
    h.input.textContent = '已更新'
    h.caret(h.input.firstChild!, 2)
    vi.runAllTimers()
    expect(h.selection.isCollapsed).toBe(true)
    expect(h.selection.anchorOffset).toBe(2)
  })

  it('改名已结束，旧任务不能改变别处的原生选区', () => {
    const h = setup()
    selectAll(h.input)
    h.input.removeAttribute('contenteditable')
    h.caret(h.outside.firstChild!, 2)
    vi.runAllTimers()
    expect(h.selection.anchorNode).toBe(h.outside.firstChild)
    expect(h.selection.anchorOffset).toBe(2)
  })

  it('原控件已移除，旧任务不能把选区移到脱离页面的节点', () => {
    const h = setup()
    selectAll(h.input)
    h.input.remove()
    h.caret(h.outside.firstChild!, 1)
    vi.runAllTimers()
    expect(h.selection.anchorNode).toBe(h.outside.firstChild)
    expect(h.selection.anchorOffset).toBe(1)
  })

  it('失焦后同一个控件重新开始编辑，前一次任务不能覆盖新光标', () => {
    const h = setup()
    selectAll(h.input)
    h.input.blur()
    h.input.focus()
    h.caret(h.input.firstChild!, 1)
    vi.runAllTimers()
    expect(h.selection.isCollapsed).toBe(true)
    expect(h.selection.anchorOffset).toBe(1)
  })

  it('只操作原控件所属 document 的选区', () => {
    const main = setup()
    main.caret(main.outside.firstChild!, 2)
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const h = setup(frame.contentDocument!)
    selectAll(h.input)
    vi.runAllTimers()
    expect(h.selection.toString()).toBe('数据')
    expect(main.selection.anchorNode).toBe(main.outside.firstChild)
    expect(main.selection.anchorOffset).toBe(2)
  })
})
