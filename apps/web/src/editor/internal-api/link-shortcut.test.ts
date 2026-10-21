import type { IShortcutItem } from '@univerjs/ui'
import { DOCS_NORMAL_EDITOR_UNIT_ID_KEY, EDITOR_ACTIVATED, FOCUSING_FX_BAR_EDITOR, FOCUSING_SHEET, IContextService, Univer } from '@univerjs/core'
import { DocSelectionManagerService } from '@univerjs/docs'
import { IEditorService } from '@univerjs/docs-ui'
import { IRenderManagerService } from '@univerjs/engine-render'
import { IShortcutService } from '@univerjs/ui'
import { afterEach, describe, expect, it } from 'vitest'
import { injectorOf } from './injector.ts'
import { installRichLinkShortcut } from './link-shortcut.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()))

function setup() {
  const univer = new Univer()
  cleanup.push(() => univer.dispose())
  const injector = injectorOf(univer)
  const context = injector.get(IContextService)
  context.setContextValue(FOCUSING_SHEET, true)
  context.setContextValue(EDITOR_ACTIVATED, true)
  const editorDOM = document.createElement('div')
  const input = document.createElement('input')
  const outside = document.createElement('input')
  // SDK 的键盘输入实际是画布容器旁的隐藏编辑器，不是 editorDOM 的后代。
  document.body.append(editorDOM, input, outside)
  cleanup.push(() => {
    editorDOM.remove()
    input.remove()
    outside.remove()
  })
  const state = { available: true, focus: DOCS_NORMAL_EDITOR_UNIT_ID_KEY, ranges: [{ startOffset: 0, endOffset: 5, collapsed: false }], otherRanges: undefined as { startOffset: number, endOffset: number, collapsed: boolean }[] | undefined }
  const shortcuts = new Set<IShortcutItem>()
  injector.add([IShortcutService, { useValue: { registerShortcut: (item: IShortcutItem) => {
    shortcuts.add(item)
    return { dispose: () => {
      shortcuts.delete(item)
    } }
  } } as IShortcutService }])
  injector.add([IEditorService, { useValue: { getFocusId: () => state.focus } as IEditorService }])
  injector.add([DocSelectionManagerService, { useValue: { getTextRanges: (scope?: { unitId: string, subUnitId: string }) => scope === undefined ? state.otherRanges ?? state.ranges : scope.unitId === DOCS_NORMAL_EDITOR_UNIT_ID_KEY && scope.subUnitId === DOCS_NORMAL_EDITOR_UNIT_ID_KEY ? state.ranges : undefined } as DocSelectionManagerService }])
  injector.add([IRenderManagerService, { useValue: { getRenderUnitById: () => ({ with: () => ({ get isFocusing() {
    return document.activeElement === input
  } }) }) } as unknown as IRenderManagerService }])
  const installed = installRichLinkShortcut(univer, () => state.available)
  cleanup.push(() => installed.dispose())
  const matches = (target: HTMLElement = input, isComposing = false): string[] => {
    target.focus()
    const result: string[] = []
    target.addEventListener('keydown', (event) => {
      for (const item of shortcuts) {
        if ((item.preconditions?.(context) ?? true) && (item.eventPreconditions?.(event) ?? true))
          result.push(item.id)
      }
    }, { once: true })
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, isComposing, bubbles: true }))
    return result
  }
  return { context, state, input, outside, matches, installed }
}

describe('富文本链接快捷键的实例和焦点边界', () => {
  it('仅当前普通单元格的非空富文本选区路由到已有工具栏命令，退役后无效', () => {
    const s = setup()
    expect(s.matches()).toEqual(['sheet.operation.insert-hyper-link-toolbar'])
    s.installed.dispose()
    expect(s.matches()).toEqual([])
  })

  it.each([FOCUSING_SHEET, EDITOR_ACTIVATED])('没有所需编辑上下文时不响应：%s', (key) => {
    const s = setup()
    s.context.setContextValue(key, false)
    expect(s.matches()).toEqual([])
  })

  it('只读或策略退役、公式栏、弹窗输入和输入法均不抢键', () => {
    const s = setup()
    s.state.available = false
    expect(s.matches()).toEqual([])
    s.state.available = true
    s.context.setContextValue(FOCUSING_FX_BAR_EDITOR, true)
    expect(s.matches()).toEqual([])
    s.context.setContextValue(FOCUSING_FX_BAR_EDITOR, false)
    s.state.focus = 'another-editor'
    expect(s.matches()).toEqual([])
    s.state.focus = DOCS_NORMAL_EDITOR_UNIT_ID_KEY
    expect(s.matches(s.outside)).toEqual([])
    expect(s.matches(s.input, true)).toEqual([])
    expect(s.matches()).toEqual(['sheet.operation.insert-hyper-link-toolbar'])
  })

  it('其他文档残留选区不能冒充当前单元格选区', () => {
    const s = setup()
    s.state.ranges = []
    s.state.otherRanges = [{ startOffset: 0, endOffset: 5, collapsed: false }]
    expect(s.matches()).toEqual([])
  })

  it('无选区或仅插入光标时不打开表单', () => {
    const s = setup()
    s.state.ranges = []
    expect(s.matches()).toEqual([])
    s.state.ranges = [{ startOffset: 0, endOffset: 0, collapsed: true }]
    expect(s.matches()).toEqual([])
  })
})
