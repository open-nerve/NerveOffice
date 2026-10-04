import type { FUniver } from '@univerjs/core/facade'
import { describe, expect, it, vi } from 'vitest'
import { GUARDED_COMMANDS, HYPERLINK_GUARDED_COMMANDS, IMAGE_GUARDED_COMMANDS, IMAGE_PASTE_COMMAND, installEntryGuards, isGuardedCommand } from './entry-guards.ts'

interface FakeEvent { id: string, params?: unknown, cancel?: boolean }

/** 只实现 addEvent 与 Event.BeforeCommandExecute 的假 Facade：记下订阅者，由测试模拟 SDK 派发事件 */
function fakeFacade() {
  const listeners = new Set<(event: FakeEvent) => void>()
  const dispose = vi.fn()
  const api = {
    Event: { BeforeCommandExecute: 'BeforeCommandExecute' },
    addEvent: vi.fn((name: string, listener: (event: FakeEvent) => void) => {
      expect(name).toBe('BeforeCommandExecute')
      listeners.add(listener)
      return { dispose: () => {
        listeners.delete(listener)
        dispose()
      } }
    }),
  }
  const fire = (id: string, params?: unknown): FakeEvent => {
    const event: FakeEvent = { id, params }
    for (const listener of listeners)
      listener(event)
    return event
  }
  return { api: api as unknown as FUniver, fire, dispose }
}

describe('M5 之前的入口：命令守卫', () => {
  it('图片：插入浮动与单元格图片（粘贴图片文件也走它）、底层的插入、工作表背景图片', () => {
    expect(IMAGE_GUARDED_COMMANDS.map(command => command.id)).toEqual([
      'sheet.command.insert-float-image',
      'sheet.command.insert-cell-image',
      'sheet.command.insert-sheet-image',
      'sheet.command.add-worksheet-background-image',
    ])
  })

  it('超链接：工具栏（Ctrl/Cmd+K）、右键、编辑面板与四条写入命令；取消链接不拦', () => {
    expect(HYPERLINK_GUARDED_COMMANDS.map(command => command.id)).toEqual([
      'sheet.operation.insert-hyper-link-toolbar',
      'sheet.operation.insert-hyper-link',
      'sheet.operation.open-hyper-link-edit-panel',
      'sheets.command.add-hyper-link',
      'sheets.command.add-rich-hyper-link',
      'sheets.command.update-hyper-link',
      'sheets.command.update-rich-hyper-link',
    ])
    expect(isGuardedCommand('sheets.command.cancel-hyper-link')).toBe(false)
  })

  it('每一项写明出处，没有重复', () => {
    expect(GUARDED_COMMANDS.filter(command => command.source.trim() === '')).toEqual([])
    expect(new Set(GUARDED_COMMANDS.map(command => command.id)).size).toBe(GUARDED_COMMANDS.length)
  })

  it('守卫取消清单里的命令，别的命令照常执行', () => {
    const facade = fakeFacade()
    installEntryGuards(facade.api)
    for (const command of GUARDED_COMMANDS)
      expect(facade.fire(command.id).cancel, command.id).toBe(true)
    for (const id of ['sheet.command.set-range-values', 'sheet.command.insert-sheet', 'sheets.command.cancel-hyper-link', 'sheet.command.delete-drawing'])
      expect(facade.fire(id).cancel, id).toBeUndefined()
  })

  it('带图片的粘贴（DEF-035 的旁支）：要贴的内容有 drawings 或图片的锚点就取消；纯文字照常；看不懂的参数按带图片算', () => {
    const facade = fakeFacade()
    installEntryGuards(facade.api)
    const paste = (doc: unknown): boolean | undefined => facade.fire(IMAGE_PASTE_COMMAND.id, { unitId: '__INTERNAL_EDITOR__DOCS_FORMULA_BAR', doc, textRanges: [] }).cancel
    const image = { drawingId: 'd1', source: 'data:image/png;base64,AAAA', imageSourceType: 'BASE64' }
    expect(paste({ body: { dataStream: '\b', customBlocks: [{ startIndex: 0, blockId: 'd1' }] }, drawings: { d1: image } })).toBe(true)
    expect(paste({ body: { dataStream: 'x' }, drawings: { d1: image } })).toBe(true)
    expect(paste({ body: { dataStream: '\b', customBlocks: [{ startIndex: 0, blockId: 'd1' }] } })).toBe(true)
    expect(paste({ body: { dataStream: 'x' }, drawings: 'broken' })).toBe(true)
    expect(facade.fire(IMAGE_PASTE_COMMAND.id, undefined).cancel).toBe(true)
    expect(facade.fire(IMAGE_PASTE_COMMAND.id, { doc: null }).cancel).toBe(true)
    // 纯文字（单元格编辑器的粘贴、空的 drawings、空的锚点）照常
    expect(paste({ body: { dataStream: 'x\r\n' } })).toBeUndefined()
    expect(paste({ body: { dataStream: 'x', customBlocks: [] }, drawings: {} })).toBeUndefined()
    expect(isGuardedCommand(IMAGE_PASTE_COMMAND.id, { doc: { body: { dataStream: 'x' } } })).toBe(false)
    expect(IMAGE_PASTE_COMMAND.source.trim()).not.toBe('')
  })

  it('卸下之后不再取消', () => {
    const facade = fakeFacade()
    const guards = installEntryGuards(facade.api)
    guards.dispose()
    expect(facade.dispose).toHaveBeenCalledTimes(1)
    expect(facade.fire('sheet.command.insert-float-image').cancel).toBeUndefined()
  })
})
