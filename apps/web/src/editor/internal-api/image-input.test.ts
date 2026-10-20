import type { IMultiCommand, Workbook } from '@univerjs/core'
import type { ImageInputCommands } from './image-input.ts'
import { CommandType, CustomCommandExecutionError, DOCS_NORMAL_EDITOR_UNIT_ID_KEY, DrawingTypeEnum, EDITOR_ACTIVATED, FOCUSING_FX_BAR_EDITOR, FOCUSING_SHEET, ICommandService, IContextService, ImageSourceType, IPermissionService, IUndoRedoService, IUniverInstanceService, LocaleType, RedoCommand, UndoCommand, Univer, UniverInstanceType } from '@univerjs/core'
import { IDrawingManagerService, UniverDrawingPlugin } from '@univerjs/drawing'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { SetRangeValuesCommand, SheetPermissionCheckController, SheetsSelectionsService, UniverSheetsPlugin, WorkbookCopyPermission, WorkbookEditablePermission, WorksheetEditExtraObjectPermission, WorksheetSetCellStylePermission } from '@univerjs/sheets'
import { ISheetDrawingService, UniverSheetsDrawingPlugin } from '@univerjs/sheets-drawing'
import { ISheetClipboardService, SheetCopyCommand, SheetCutCommand, SheetPasteCommand, SheetPasteShortKeyCommand } from '@univerjs/sheets-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../async-tools.ts'
import { editorIdentityOverride } from '../identity/editor-authz-io.service.ts'
import { SHEET_ZH_CN } from '../profile/locale.ts'
import { createImageInputBridge } from './image-input.ts'
import { injectorOf } from './injector.ts'

const SOURCE = '/api/assets/11111111-1111-4111-8111-111111111111'
const BOOK = 'input-book'
const SHEET = 'one'
const cleanup: (() => void)[] = []

/** 只替换命令所调用的系统剪贴板端口；未列出的服务调用立即报错。 */
function clipboardPort(methods: Partial<ISheetClipboardService>): ISheetClipboardService {
  return new Proxy(methods, { get: (target, key) => {
    if (key === 'dispose')
      return undefined
    if (!Object.hasOwn(target, key))
      throw new Error(`未声明的剪贴板测试依赖：${String(key)}`)
    return Reflect.get(target, key) as unknown
  } }) as ISheetClipboardService
}

function setup() {
  const univer = new Univer({ locale: LocaleType.ZH_CN, locales: { [LocaleType.ZH_CN]: SHEET_ZH_CN }, override: editorIdentityOverride('edit') })
  univer.registerPlugin(UniverRenderEnginePlugin)
  univer.registerPlugin(UniverSheetsPlugin)
  univer.registerPlugin(UniverDrawingPlugin)
  univer.registerPlugin(UniverSheetsDrawingPlugin)
  const workbook = univer.createUnit<unknown, Workbook>(UniverInstanceType.UNIVER_SHEET, {
    id: BOOK,
    sheetOrder: [SHEET, 'two'],
    sheets: { one: { id: SHEET, name: 'One', rowCount: 20, columnCount: 10 }, two: { id: 'two', name: 'Two', rowCount: 20, columnCount: 10 } },
  })
  const injector = injectorOf(univer)
  const instances = injector.get(IUniverInstanceService)
  instances.focusUnit(BOOK)
  const selections = injector.get(SheetsSelectionsService)
  const select = (row = 0, column = 0, endRow = row) => selections.setSelections(BOOK, workbook.getActiveSheet().getSheetId(), [{
    range: { startRow: row, endRow, startColumn: column, endColumn: column },
    primary: { startRow: row, endRow: row, startColumn: column, endColumn: column, actualRow: row, actualColumn: column, isMerged: false, isMergedMainCell: false },
    style: null,
  }])
  select()
  const context = injector.get(IContextService)
  context.setContextValue(FOCUSING_SHEET, true)
  const container = document.createElement('div')
  document.body.append(container)
  let allowed = true
  const listeners = new Set<() => void>()
  const bridge = createImageInputBridge(univer, container, {
    unitId: BOOK,
    origin: 'https://app.test',
    available: () => allowed,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  const commands = injector.get(ICommandService)
  const copy = vi.fn<ImageInputCommands['copy']>(async () => true)
  const paste = vi.fn<ImageInputCommands['paste']>(async () => true)
  const rejected = vi.fn()
  const insert = vi.fn(async (_kind: 'float' | 'cell', _files?: readonly File[]) => true)
  const oldInsert = vi.fn(() => true)
  for (const id of ['sheet.command.insert-float-image', 'sheet.command.insert-cell-image'])
    commands.registerCommand({ id, type: CommandType.COMMAND, handler: oldInsert })
  const routes = bridge.installCommands({ copy, paste, insert, rejected })
  const drawings = injector.get(IDrawingManagerService)
  const sheets = injector.get(ISheetDrawingService)
  const image = (drawingId = 'image', subUnitId = SHEET, drawingType = DrawingTypeEnum.DRAWING_IMAGE) => ({
    unitId: BOOK,
    subUnitId,
    drawingId,
    drawingType,
    source: SOURCE,
    imageSourceType: ImageSourceType.URL,
    transform: { left: 0, top: 0, width: 100, height: 100 },
    sheetTransform: { from: { row: 0, column: 0, rowOffset: 0, columnOffset: 0 }, to: { row: 1, column: 1, rowOffset: 0, columnOffset: 0 } },
    axisAlignSheetTransform: { from: { row: 0, column: 0, rowOffset: 0, columnOffset: 0 }, to: { row: 1, column: 1, rowOffset: 0, columnOffset: 0 } },
  })
  for (const service of [drawings, sheets]) {
    service.setDrawingData(BOOK, SHEET, { image: image(), second: image('second') })
    service.setDrawingOrder(BOOK, SHEET, ['image', 'second'])
    service.setDrawingData(BOOK, 'two', { other: image('other', 'two') })
    service.setDrawingOrder(BOOK, 'two', ['other'])
  }
  const focus = (ids = ['image'], subUnitId = SHEET) => drawings.focusDrawing(ids.map(drawingId => ({ unitId: BOOK, subUnitId, drawingId })))
  const capture = (intent: 'copy' | 'cut' | 'insert' = 'copy') => {
    const target = bridge.capture(intent)
    if (!target)
      throw new Error('应捕获当前表格目标')
    return target
  }
  cleanup.push(() => {
    routes.dispose()
    bridge.dispose()
    container.remove()
    univer.dispose()
  })
  return { univer, injector, workbook, commands, context, bridge, container, copy, paste, insert, oldInsert, rejected, focus, capture, select, drawings, sheets, listeners, routes, revoke: () => {
    allowed = false
    for (const listener of listeners)
      listener()
  } }
}

afterEach(() => {
  for (const dispose of cleanup.splice(0))
    dispose()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('真实命令服务的图片接管', () => {
  it.each(['float', 'cell'] as const)('%s 正式菜单同步进入平台输入；失败不回落 SDK 文件框', async (kind) => {
    const h = setup()
    const pending = deferred<boolean>()
    h.insert.mockReturnValueOnce(pending.promise)
    const result = h.commands.executeCommand(`sheet.command.insert-${kind}-image`)
    expect(h.insert).toHaveBeenCalledExactlyOnceWith(kind, undefined)
    expect(h.oldInsert).not.toHaveBeenCalled()
    pending.resolve(false)
    expect(await result).toBe(false)
    expect(h.oldInsert).not.toHaveBeenCalled()
  })

  it('正式文件命令保留实际 File 列表，伪造文件拒绝且不弹默认文件框', async () => {
    const h = setup()
    const files = [new File(['controlled'], 'sample.png', { type: 'image/png' })]
    expect(await h.commands.executeCommand('sheet.command.insert-float-image', { files })).toBe(true)
    expect(h.insert).toHaveBeenCalledExactlyOnceWith('float', files)
    expect(await h.commands.executeCommand('sheet.command.insert-float-image', { files: [{ name: 'forged.png' }] })).toBe(false)
    expect(h.insert).toHaveBeenCalledOnce()
    expect(h.rejected).toHaveBeenCalledWith('type', 'insert', 'insert')
    expect(h.oldInsert).not.toHaveBeenCalled()
  })

  it('入口失焦、许可失效或处理器失败时不启动旧 SDK，释放不留下可调用入口', async () => {
    const h = setup()
    h.context.setContextValue(FOCUSING_FX_BAR_EDITOR, true)
    expect(await h.commands.executeCommand('sheet.command.insert-cell-image')).toBe(false)
    expect(h.insert).not.toHaveBeenCalled()
    h.context.setContextValue(FOCUSING_FX_BAR_EDITOR, false)
    h.insert.mockRejectedValueOnce(new Error('controlled failure'))
    expect(await h.commands.executeCommand('sheet.command.insert-cell-image')).toBe(false)
    h.revoke()
    expect(await h.commands.executeCommand('sheet.command.insert-cell-image')).toBe(false)
    expect(h.insert).toHaveBeenCalledOnce()
    expect(h.oldInsert).not.toHaveBeenCalled()
    h.routes.dispose()
    h.routes.dispose()
    expect(h.commands.hasCommand('sheet.command.insert-float-image')).toBe(false)
    expect(h.commands.hasCommand('sheet.command.insert-cell-image')).toBe(false)
  })

  it('原 MultiCommand 返回 false 会回落，自定义取消错误终止回落', async () => {
    const h = setup()
    const fallback = vi.fn(() => true)
    const register = (command: IMultiCommand) => h.commands.registerMultipleCommand(command)
    register({ id: 'test.multi', name: 'fallback', type: CommandType.COMMAND, multi: true, priority: 1, handler: fallback })
    const first = register({ id: 'test.multi', name: 'first', type: CommandType.COMMAND, multi: true, priority: 2, handler: () => false })
    expect(await h.commands.executeCommand('test.multi')).toBe(true)
    expect(fallback).toHaveBeenCalledOnce()
    first.dispose()
    register({ id: 'test.multi', name: 'reject', type: CommandType.COMMAND, multi: true, priority: 2, handler: () => {
      throw new CustomCommandExecutionError('cancel')
    } })
    expect(await h.commands.executeCommand('test.multi')).toBe(false)
    expect(fallback).toHaveBeenCalledOnce()
  })

  it.each([SheetCopyCommand, SheetCutCommand])('%s：选中图片在命令同步阶段接管，失败不进入原 SDK 剪贴板', async (command) => {
    const h = setup()
    h.focus()
    const oldCopy = vi.fn(async () => true)
    const oldCut = vi.fn(async () => true)
    h.injector.add([ISheetClipboardService, { useValue: clipboardPort({ copy: oldCopy, cut: oldCut }) }])
    h.commands.registerMultipleCommand(command)
    const pending = deferred<boolean>()
    h.copy.mockReturnValue(pending.promise)
    const result = h.commands.executeCommand(command.id)
    expect(h.copy).toHaveBeenCalledOnce()
    expect(h.copy.mock.calls[0]?.[2]).toBe(command.id === SheetCutCommand.id)
    pending.resolve(false)
    expect(await result).toBe(false)
    expect(oldCopy).not.toHaveBeenCalled()
    expect(oldCut).not.toHaveBeenCalled()
    expect(h.sheets.getDrawingOrder(BOOK, SHEET)).toEqual(['image', 'second'])
  })

  it('普通区域复制继续实际 SheetCopyCommand；释放接管后恢复原路由', async () => {
    const h = setup()
    const original = vi.fn(async () => true)
    h.injector.add([ISheetClipboardService, { useValue: clipboardPort({ copy: original }) }])
    h.commands.registerMultipleCommand(SheetCopyCommand)
    expect(await h.commands.executeCommand(SheetCopyCommand.id)).toBe(true)
    expect(original).toHaveBeenCalledOnce()
    expect(h.copy).not.toHaveBeenCalled()
    h.focus()
    h.routes.dispose()
    expect(await h.commands.executeCommand(SheetCopyCommand.id)).toBe(true)
    expect(original).toHaveBeenCalledTimes(2)
  })

  it.each([SheetCopyCommand, SheetCutCommand])('图片服务不可用时，普通区域 %s 仍走原表格剪贴板', async (command) => {
    const h = setup()
    const original = vi.fn(async () => true)
    h.injector.add([ISheetClipboardService, { useValue: clipboardPort({ copy: original, cut: original }) }])
    h.commands.registerMultipleCommand(command)
    h.revoke()
    expect(await h.commands.executeCommand(command.id)).toBe(true)
    expect(original).toHaveBeenCalledOnce()
    expect(h.copy).not.toHaveBeenCalled()
    expect(h.rejected).not.toHaveBeenCalled()
    expect(h.bridge.capture('insert')).toBeUndefined()
  })

  it('只读普通区域剪切由真实 SDK 拒绝并发出原提示，图片处理不接管', async () => {
    const h = setup()
    const cut = vi.fn(async () => true)
    h.injector.add([ISheetClipboardService, { useValue: clipboardPort({ cut }) }])
    h.commands.registerMultipleCommand(SheetCutCommand)
    h.injector.get(IPermissionService).updatePermissionPoint(new WorkbookEditablePermission(BOOK).id, false)
    const messages: string[] = []
    const observer = h.injector.get(SheetPermissionCheckController).triggerPermissionUIEvent$.subscribe(message => messages.push(message))
    try {
      expect(await h.commands.executeCommand(SheetCutCommand.id)).toBe(false)
      expect(messages).toEqual(['这份文档只能查看，不能剪切。'])
      expect(cut).not.toHaveBeenCalled()
      expect(h.copy).not.toHaveBeenCalled()
      expect(h.rejected).not.toHaveBeenCalled()
    }
    finally {
      observer.unsubscribe()
    }
  })

  it('只读真实图片剪切仍由严格图片目标拒绝，不回落 SDK', async () => {
    const h = setup()
    const fallback = vi.fn(async () => true)
    h.commands.registerMultipleCommand({ ...SheetCutCommand, handler: fallback })
    h.focus()
    h.injector.get(IPermissionService).updatePermissionPoint(new WorkbookEditablePermission(BOOK).id, false)
    expect(await h.commands.executeCommand(SheetCutCommand.id)).toBe(false)
    expect(h.rejected).toHaveBeenCalledExactlyOnceWith('permission', 'cut')
    expect(h.copy).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('同步表格事件在只读时仍由真实快捷粘贴命令发出权限提示，零正文写入', async () => {
    const h = setup()
    const legacyPaste = vi.fn(async () => true)
    h.injector.add([ISheetClipboardService, { useValue: clipboardPort({ legacyPaste }) }])
    h.commands.registerCommand(SheetPasteShortKeyCommand)
    h.injector.get(IPermissionService).updatePermissionPoint(new WorkbookEditablePermission(BOOK).id, false)
    const messages: string[] = []
    const observer = h.injector.get(SheetPermissionCheckController).triggerPermissionUIEvent$.subscribe(message => messages.push(message))
    try {
      const result = h.bridge.pasteTableEvent({ html: '<table><tr><td>42</td></tr></table>', text: '42', formulaClipboardPayload: 'formula' })
      expect(messages).toEqual(['这份文档只能查看，不能粘贴。'])
      expect(await result).toBe(false)
      expect(legacyPaste).not.toHaveBeenCalled()
      expect(h.paste).not.toHaveBeenCalled()
    }
    finally {
      observer.unsubscribe()
    }
  })

  it('同步表格事件立即以原范围启动真实命令，去掉预览文件并保留公式数据', async () => {
    const h = setup()
    const pending = deferred<boolean>()
    const legacyPaste = vi.fn(async () => pending.promise)
    h.injector.add([ISheetClipboardService, { useValue: clipboardPort({ legacyPaste }) }])
    h.commands.registerCommand(SheetPasteShortKeyCommand)
    h.select(3, 2)
    const result = h.bridge.pasteTableEvent({ html: '<table><tr><td>42</td></tr></table>', text: '42', formulaClipboardPayload: 'formula' })
    expect(legacyPaste).toHaveBeenCalledExactlyOnceWith('<table><tr><td>42</td></tr></table>', '42', [], 'formula', {
      unitId: BOOK,
      subUnitId: SHEET,
      range: { startRow: 3, endRow: 3, startColumn: 2, endColumn: 2 },
    })
    h.select(6, 4)
    pending.resolve(true)
    expect(await result).toBe(true)
    expect(legacyPaste).toHaveBeenCalledOnce()
  })

  it.each(['focus', 'selection', 'disposed'] as const)('同步表格事件在 %s 无效时不启动旧 SDK', async (reason) => {
    const h = setup()
    const legacyPaste = vi.fn(async () => true)
    h.injector.add([ISheetClipboardService, { useValue: clipboardPort({ legacyPaste }) }])
    h.commands.registerCommand(SheetPasteShortKeyCommand)
    if (reason === 'focus')
      h.context.setContextValue(FOCUSING_SHEET, false)
    else if (reason === 'selection')
      h.injector.get(SheetsSelectionsService).setSelections(BOOK, SHEET, [])
    else
      h.bridge.dispose()
    expect(await h.bridge.pasteTableEvent({ text: '不能写入' })).toBe(false)
    expect(legacyPaste).not.toHaveBeenCalled()
  })

  it('图片服务不可用时，右键普通表格仍按捕获范围交给真实快捷粘贴命令', async () => {
    const h = setup()
    const legacyPaste = vi.fn(async () => true)
    h.injector.add([ISheetClipboardService, { useValue: clipboardPort({ legacyPaste }) }])
    h.commands.registerCommand(SheetPasteShortKeyCommand)
    h.select(3, 2)
    h.revoke()
    h.paste.mockImplementation(async target => h.bridge.pasteTable(target, { html: '<table><tr><td>离线正文</td></tr></table>', text: '离线正文' }))
    expect(await h.commands.executeCommand(SheetPasteCommand.id)).toBe(true)
    expect(legacyPaste).toHaveBeenCalledExactlyOnceWith('<table><tr><td>离线正文</td></tr></table>', '离线正文', [], undefined, {
      unitId: BOOK,
      subUnitId: SHEET,
      range: { startRow: 3, endRow: 3, startColumn: 2, endColumn: 2 },
    })
    expect(h.rejected).not.toHaveBeenCalled()
  })

  it.each([SheetCopyCommand, SheetCutCommand])('图片服务不可用时，选中图片的 %s 仍被拒绝且不回落', async (command) => {
    const h = setup()
    const original = vi.fn(async () => true)
    h.commands.registerMultipleCommand({ ...command, handler: original })
    h.focus()
    h.revoke()
    expect(await h.commands.executeCommand(command.id)).toBe(false)
    expect(h.rejected).toHaveBeenCalledExactlyOnceWith('permission', command.id === SheetCutCommand.id ? 'cut' : 'copy')
    expect(h.copy).not.toHaveBeenCalled()
    expect(original).not.toHaveBeenCalled()
  })

  it('离线右键读出图片后不能转为图片写入；普通目标也不绕过身份变化与选区失效', async () => {
    const h = setup()
    h.paste.mockImplementation(async target => h.bridge.canWriteImage(target, 'float'))
    h.revoke()
    expect(await h.commands.executeCommand(SheetPasteCommand.id)).toBe(false)
    expect(h.paste).toHaveBeenCalledOnce()
    expect(h.paste.mock.calls[0]?.[0].isCurrent()).toBe(false)
    h.paste.mockImplementation(async (target) => {
      const cancelled = vi.fn()
      const remove = target.subscribe(cancelled)
      h.select(1)
      h.select()
      expect(target.isCurrent()).toBe(false)
      expect(cancelled).toHaveBeenCalled()
      remove()
      return h.bridge.pasteTable(target, { text: '不能写回' })
    })
    expect(await h.commands.executeCommand(SheetPasteCommand.id)).toBe(false)
    h.paste.mockImplementation(async (target) => {
      const remove = target.subscribe(() => {})
      h.revoke()
      expect(target.isCurrent()).toBe(false)
      remove()
      return false
    })
    expect(await h.commands.executeCommand(SheetPasteCommand.id)).toBe(false)
  })

  it('多选区域的主单元格可以不在最后一项，普通复制继续原命令且插入捕获活动位置', async () => {
    const h = setup()
    const selections = h.injector.get(SheetsSelectionsService)
    h.select(3, 2)
    selections.setSelections(BOOK, SHEET, [
      ...selections.getCurrentSelections(),
      { range: { startRow: 8, endRow: 9, startColumn: 0, endColumn: 0 }, primary: null, style: null },
    ])
    const original = vi.fn(async () => true)
    h.injector.add([ISheetClipboardService, { useValue: clipboardPort({ copy: original }) }])
    h.commands.registerMultipleCommand(SheetCopyCommand)
    await expect(h.commands.executeCommand(SheetCopyCommand.id)).resolves.toBe(true)
    expect(original).toHaveBeenCalledOnce()
    expect(h.capture('insert')).toMatchObject({ row: 3, column: 2 })
  })

  it('多张或其他工作表的陈旧图片选集均明确拒绝，不默默选第一张', async () => {
    const h = setup()
    h.focus(['image', 'second'])
    expect(await h.commands.executeCommand(SheetCopyCommand.id)).toBe(false)
    h.focus(['other'], 'two')
    expect(await h.commands.executeCommand(SheetCopyCommand.id)).toBe(false)
    expect(h.copy).not.toHaveBeenCalled()
    expect(h.rejected.mock.calls).toEqual([['selection', 'copy'], ['selection', 'copy']])
  })

  it('右键粘贴在同步阶段启动；已接管失败不读取第二次', async () => {
    const h = setup()
    const fallback = vi.fn(() => true)
    h.commands.registerMultipleCommand({ ...SheetPasteCommand, handler: fallback })
    const pending = deferred<boolean>()
    h.paste.mockReturnValue(pending.promise)
    const result = h.commands.executeCommand(SheetPasteCommand.id)
    expect(h.paste).toHaveBeenCalledOnce()
    pending.resolve(false)
    expect(await result).toBe(false)
    expect(fallback).not.toHaveBeenCalled()
  })

  it.each([[SheetCopyCommand, 'copy'], [SheetCutCommand, 'cut'], [SheetPasteCommand, 'insert']] as const)('权限拒绝报告本次 %s 的操作类别', async (command, intent) => {
    const h = setup()
    h.injector.get(IPermissionService).updatePermissionPoint((intent === 'insert' ? new WorkbookEditablePermission(BOOK) : new WorkbookCopyPermission(BOOK)).id, false)
    expect(await h.commands.executeCommand(command.id)).toBe(false)
    expect(h.rejected).toHaveBeenCalledExactlyOnceWith('permission', intent)
  })

  it('不能编辑浮图时，普通文字剪切与表格粘贴仍使用各自原权限', async () => {
    const h = setup()
    const point = new WorksheetEditExtraObjectPermission(BOOK, SHEET)
    const permissions = h.injector.get(IPermissionService)
    permissions.addPermissionPoint(point)
    permissions.updatePermissionPoint(point.id, false)
    const cut = vi.fn(async () => true)
    h.injector.add([ISheetClipboardService, { useValue: clipboardPort({ cut }) }])
    h.commands.registerMultipleCommand(SheetCutCommand)
    expect(await h.commands.executeCommand(SheetCutCommand.id)).toBe(true)
    expect(cut).toHaveBeenCalledOnce()
    expect(await h.commands.executeCommand(SheetPasteCommand.id)).toBe(true)
    expect(h.paste).toHaveBeenCalledOnce()
    expect(h.rejected).not.toHaveBeenCalled()
  })

  it('接管处理器同步抛错也转换成明确失败，不留下命令 Promise 拒绝或旧路径写入', async () => {
    const h = setup()
    h.focus()
    const fallback = vi.fn(() => true)
    h.commands.registerMultipleCommand({ ...SheetCopyCommand, handler: fallback })
    h.copy.mockImplementation(() => {
      throw new Error('读取失败')
    })
    await expect(h.commands.executeCommand(SheetCopyCommand.id)).resolves.toBe(false)
    expect(fallback).not.toHaveBeenCalled()
  })
})

describe('真实焦点、模型与固定目标', () => {
  it('普通选区可捕获；返回值只有只读坐标、检查与订阅能力', () => {
    const h = setup()
    expect(h.bridge.gridFocused()).toBe(true)
    const target = h.capture('insert')
    expect(Object.isFrozen(target)).toBe(true)
    expect(target).toMatchObject({ unitId: BOOK, subUnitId: SHEET, row: 0, column: 0 })
    expect(target.isCurrent()).toBe(true)
  })

  it.each(['input', 'textarea', 'select', 'contenteditable', 'formula', 'editing'] as const)('%s 焦点下遗留图片不能劫持输入', (kind) => {
    const h = setup()
    h.focus()
    if (kind === 'formula' || kind === 'editing') {
      h.context.setContextValue(kind === 'formula' ? FOCUSING_FX_BAR_EDITOR : EDITOR_ACTIVATED, true)
    }
    else {
      const element = document.createElement(kind === 'contenteditable' ? 'div' : kind)
      element.tabIndex = 0
      if (kind === 'contenteditable')
        element.setAttribute('contenteditable', 'true')
      document.body.append(element)
      element.focus()
    }
    expect(h.bridge.gridFocused()).toBe(false)
    expect(h.bridge.capture('insert')).toBeUndefined()
    expect(h.bridge.capture('copy')).toBeUndefined()
  })

  it('SDK 正常单元格的隐藏输入只在未编辑时代表画布，编辑栏或宿主仿冒不算', () => {
    const h = setup()
    const input = document.createElement('div')
    input.tabIndex = 0
    input.contentEditable = 'true'
    input.id = `__editor_${DOCS_NORMAL_EDITOR_UNIT_ID_KEY}`
    input.dataset.uComp = 'editor'
    h.container.append(input)
    input.focus()
    expect(h.bridge.gridFocused()).toBe(true)
    document.body.append(input)
    input.focus()
    expect(document.activeElement).toBe(input)
    expect(h.bridge.gridFocused()).toBe(false)
  })

  it.each(['selection', 'sheet', 'identity', 'permission', 'dispose'] as const)('%s 失效后发出通知，切回原位置也不复活', (change) => {
    const h = setup()
    const target = h.capture()
    const listener = vi.fn()
    const unsubscribe = target.subscribe(listener)
    if (change === 'selection') {
      h.select(1)
      h.select()
    }
    else if (change === 'sheet') {
      const next = h.workbook.getSheetBySheetId('two')
      const previous = h.workbook.getActiveSheet()
      if (!next)
        throw new Error('缺少测试表')
      h.workbook.setActiveSheet(next)
      h.workbook.setActiveSheet(previous)
    }
    else if (change === 'identity') {
      h.revoke()
    }
    else if (change === 'permission') {
      h.injector.get(IPermissionService).updatePermissionPoint(new WorkbookCopyPermission(BOOK).id, false)
    }
    else {
      h.bridge.dispose()
    }
    expect(target.isCurrent()).toBe(false)
    expect(listener).toHaveBeenCalled()
    unsubscribe()
    expect(h.listeners.size).toBe(0)
  })

  it('只读取实际选中图片的规范来源；复制期间对象更新后不能剪切删除', () => {
    const h = setup()
    h.focus(['second'])
    const target = h.capture('cut')
    const selection = h.bridge.selectedImage(target)
    expect(selection).toMatchObject({ kind: 'single', image: { kind: 'float', drawingId: 'second', source: SOURCE } })
    if (selection.kind !== 'single')
      throw new Error('应选中第二张图片')
    const image = h.drawings.getDrawingByParam({ unitId: BOOK, subUnitId: SHEET, drawingId: 'second' })
    if (!image)
      throw new Error('缺少图片')
    image.transform = { width: 20, height: 20 }
    const history = h.injector.get(IUndoRedoService).getUndoRedoStatus(BOOK)
    expect(h.bridge.removeImage(target, selection.image)).toBe(false)
    expect(h.sheets.getDrawingOrder(BOOK, SHEET)).toEqual(['image', 'second'])
    expect(h.injector.get(IUndoRedoService).getUndoRedoStatus(BOOK)).toEqual(history)
  })

  it.each(['float', 'cell'] as const)('%s：图片上传所需的专属权限撤回后立即通知，恢复权限也不能复活', (kind) => {
    const h = setup()
    const target = h.capture('insert')
    expect(h.bridge.canWriteImage(target, kind)).toBe(true)
    const listener = vi.fn()
    const remove = target.subscribe(listener)
    const point = kind === 'float' ? new WorksheetEditExtraObjectPermission(BOOK, SHEET) : new WorksheetSetCellStylePermission(BOOK, SHEET)
    const permissions = h.injector.get(IPermissionService)
    permissions.addPermissionPoint(point)
    permissions.updatePermissionPoint(point.id, false)
    expect(listener).toHaveBeenCalled()
    expect(target.isCurrent()).toBe(false)
    permissions.updatePermissionPoint(point.id, true)
    expect(target.isCurrent()).toBe(false)
    remove()
  })

  it('已失效目标的订阅立即通知且不再占用身份监听', () => {
    const h = setup()
    const target = h.capture('insert')
    h.bridge.dispose()
    const listener = vi.fn()
    const remove = target.subscribe(listener)
    expect(listener).toHaveBeenCalledOnce()
    expect(h.listeners.size).toBe(0)
    remove()
  })

  it('绘图管理器与工作表的图片来源不一致时不能复制其中任意一个', () => {
    const h = setup()
    h.focus()
    const drawing = h.sheets.getDrawingByParam({ unitId: BOOK, subUnitId: SHEET, drawingId: 'image' })
    if (!drawing)
      throw new Error('缺少测试图片')
    Object.assign(drawing, { source: '/api/assets/22222222-2222-4222-8222-222222222222' })
    expect(h.bridge.selectedImage(h.capture())).toEqual({ kind: 'reject' })
  })

  it('表格委托使用原快捷粘贴命令，保留公式数据和固定目标且不传图片预览', async () => {
    const h = setup()
    const legacyPaste = vi.fn(async () => true)
    h.injector.add([ISheetClipboardService, { useValue: clipboardPort({ legacyPaste }) }])
    h.commands.registerCommand(SheetPasteShortKeyCommand)
    const target = h.capture('insert')
    const html = '<table><tr><td>42<img src="data:image/png;base64,AQ=="></td></tr></table>'
    expect(await h.bridge.pasteTable(target, { html, text: '42', formulaClipboardPayload: 'formula-data' })).toBe(true)
    expect(legacyPaste).toHaveBeenCalledWith(html, '42', [], 'formula-data', {
      unitId: BOOK,
      subUnitId: SHEET,
      range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
    })
    h.select(1)
    expect(await h.bridge.pasteTable(target, { text: 'later' })).toBe(false)
    expect(legacyPaste).toHaveBeenCalledOnce()
  })

  it('多选中的图片锚点与原 SDK 表格粘贴目标分别捕获，不改变表格的末项范围语义', async () => {
    const h = setup()
    const selections = h.injector.get(SheetsSelectionsService)
    h.select(3, 2)
    selections.setSelections(BOOK, SHEET, [
      ...selections.getCurrentSelections(),
      { range: { startRow: 8, endRow: 9, startColumn: 0, endColumn: 0 }, primary: null, style: null },
    ])
    // 固定 SDK capturePasteTarget 直接复制 getCurrentLastSelection().range。
    const sdkRange = structuredClone(selections.getCurrentLastSelection()?.range)
    expect(sdkRange).toEqual({ startRow: 8, endRow: 9, startColumn: 0, endColumn: 0 })
    const legacyPaste = vi.fn(async () => true)
    h.injector.add([ISheetClipboardService, { useValue: clipboardPort({ legacyPaste }) }])
    h.commands.registerCommand(SheetPasteShortKeyCommand)
    const target = h.capture('insert')
    expect(target).toMatchObject({ row: 3, column: 2 })
    expect(await h.bridge.pasteTable(target, { text: '42' })).toBe(true)
    expect(legacyPaste).toHaveBeenCalledWith(undefined, '42', [], undefined, { unitId: BOOK, subUnitId: SHEET, range: sdkRange })
  })

  it('普通区域包含图片仍委托原表格复制，不遍历整个选区找首图', () => {
    const h = setup()
    h.commands.syncExecuteCommand(SetRangeValuesCommand.id, { value: 'ordinary' })
    h.select(0, 0, 10)
    expect(h.bridge.selectedImage(h.capture())).toEqual({ kind: 'none' })
  })
})

describe('已经上传的受管图片经正常命令插入与剪切', () => {
  const prepared = { source: SOURCE, width: 120, height: 80 }

  it.each(['float', 'cell'] as const)('%s 剪切命令重新绑定严格目标，实际删除与撤销均成立', async (kind) => {
    const h = setup()
    if (kind === 'float')
      h.focus()
    else
      expect(h.bridge.insertImage(h.capture('insert'), prepared, 'cell')).toBe(true)
    const current = () => kind === 'float'
      ? h.sheets.getDrawingByParam({ unitId: BOOK, subUnitId: SHEET, drawingId: 'image' })
      : h.workbook.getActiveSheet().getCellRaw(0, 0)?.p
    const original = structuredClone(current())
    expect(original).toBeDefined()
    h.copy.mockImplementation(async (target, image, cut) => cut && h.bridge.removeImage(target, image))
    expect(await h.commands.executeCommand(SheetCutCommand.id)).toBe(true)
    expect(h.copy).toHaveBeenCalledOnce()
    expect(current()).toBeUndefined()
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    expect(current()).toEqual(original)
  })

  it('浮图固定在捕获的单元格、使用独立 ID；真实撤销与重做保留受管地址', async () => {
    const h = setup()
    h.select(3, 2)
    const target = h.capture('insert')
    expect(h.bridge.insertImage(target, prepared, 'float')).toBe(true)
    const ids = h.sheets.getDrawingOrder(BOOK, SHEET)
    expect(ids).toHaveLength(3)
    const drawingId = ids.at(-1)
    expect(drawingId).toBeDefined()
    const drawing = h.sheets.getDrawingByParam({ unitId: BOOK, subUnitId: SHEET, drawingId: drawingId ?? '' })
    expect(drawing).toMatchObject({ source: SOURCE, imageSourceType: ImageSourceType.URL, transform: { width: 120, height: 80, angle: 0, skewX: 0, skewY: 0, flipX: false, flipY: false }, sheetTransform: { from: { row: 3, column: 2 } } })
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    expect(h.sheets.getDrawingOrder(BOOK, SHEET)).toEqual(['image', 'second'])
    expect(await h.commands.executeCommand(RedoCommand.id)).toBe(true)
    expect(h.sheets.getDrawingByParam({ unitId: BOOK, subUnitId: SHEET, drawingId: drawingId ?? '' })).toEqual(drawing)
    expect(h.bridge.insertImage(h.capture('insert'), prepared, 'float')).toBe(true)
    expect(new Set(h.sheets.getDrawingOrder(BOOK, SHEET)).size).toBe(4)
  })

  it('长宽不同比例的浮图都落在显示上限内；不把源地址交给 img.src 量尺寸', () => {
    const h = setup()
    const sourceAssignment = vi.spyOn(HTMLImageElement.prototype, 'src', 'set')
    expect(h.bridge.insertImage(h.capture('insert'), { ...prepared, width: 1000, height: 250 }, 'float')).toBe(true)
    const id = h.sheets.getDrawingOrder(BOOK, SHEET).at(-1) ?? ''
    expect(h.sheets.getDrawingByParam({ unitId: BOOK, subUnitId: SHEET, drawingId: id })).toMatchObject({ transform: { width: 500, height: 125 } })
    expect(sourceAssignment).not.toHaveBeenCalled()
  })

  it.each([
    { source: 'https://outside.invalid/image.png' },
    { source: 'blob:old' },
    { width: 0 },
    { width: Number.NaN },
    { height: 8193 },
    { width: 8192, height: 8192 },
  ])('来源或尺寸不合法时不写模型或历史：%j', (overrides) => {
    const h = setup()
    const before = h.injector.get(IUndoRedoService).getUndoRedoStatus(BOOK)
    expect(h.bridge.insertImage(h.capture('insert'), { ...prepared, ...overrides }, 'float')).toBe(false)
    expect(h.sheets.getDrawingOrder(BOOK, SHEET)).toEqual(['image', 'second'])
    expect(h.injector.get(IUndoRedoService).getUndoRedoStatus(BOOK)).toEqual(before)
  })

  it.each(['float', 'cell'] as const)('%s：异步结束时目标已变更不能落入新选区，也不能用复制目标写入', (kind) => {
    const h = setup()
    const old = h.capture('insert')
    h.select(2, 2)
    expect(h.bridge.insertImage(old, prepared, kind)).toBe(false)
    expect(h.bridge.insertImage(h.capture('copy'), prepared, kind)).toBe(false)
    expect(h.workbook.getActiveSheet().getCellRaw(2, 2)).toBeUndefined()
    expect(h.sheets.getDrawingOrder(BOOK, SHEET)).toEqual(['image', 'second'])
  })

  it('单元格图选中后复制真实来源；正常剪切删除可以撤销，不删除单元格样式', async () => {
    const h = setup()
    expect(h.commands.syncExecuteCommand(SetRangeValuesCommand.id, { value: { s: { bg: { rgb: '#ff0000' } } } })).toBe(true)
    expect(h.bridge.insertImage(h.capture('insert'), prepared, 'cell')).toBe(true)
    const cell = structuredClone(h.workbook.getActiveSheet().getCellRaw(0, 0))
    // 真实 BuildTextUtils 在空文档起始段落之后放置图片锚点。
    expect(cell?.p?.body?.dataStream).toBe('\r\b\r\n')
    const target = h.capture('cut')
    const selection = h.bridge.selectedImage(target)
    expect(selection).toMatchObject({ kind: 'single', image: { kind: 'cell', source: SOURCE } })
    if (selection.kind !== 'single')
      throw new Error('应选中单元格图')
    expect(h.bridge.removeImage(target, selection.image)).toBe(true)
    expect(h.workbook.getActiveSheet().getCellRaw(0, 0)?.p).toBeUndefined()
    expect(h.workbook.getActiveSheet().getCellRaw(0, 0)?.s).toEqual(cell?.s)
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    expect(h.workbook.getActiveSheet().getCellRaw(0, 0)).toEqual(cell)
  })

  it('单元格图替换原有公式和值，撤销准确恢复原单元格', async () => {
    const h = setup()
    expect(h.commands.syncExecuteCommand(SetRangeValuesCommand.id, { value: { v: 2, f: '=1+1', s: { bg: { rgb: '#ff0000' } } } })).toBe(true)
    const original = structuredClone(h.workbook.getActiveSheet().getCellRaw(0, 0))
    expect(h.bridge.insertImage(h.capture('insert'), prepared, 'cell')).toBe(true)
    const cell = h.workbook.getActiveSheet().getCellRaw(0, 0)
    expect(cell?.f).toBeFalsy()
    expect(cell?.v).not.toBe(2)
    expect(cell?.s).toEqual(original?.s)
    expect(h.bridge.selectedImage(h.capture())).toMatchObject({ kind: 'single', image: { kind: 'cell' } })
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    expect(h.workbook.getActiveSheet().getCellRaw(0, 0)).toEqual(original)
  })

  it('浮图剪切必须使用该次选中对象与 cut 目标，不能伪造或重复删除', async () => {
    const h = setup()
    h.focus(['second'])
    const target = h.capture('cut')
    const selection = h.bridge.selectedImage(target)
    if (selection.kind !== 'single')
      throw new Error('应选中浮图')
    expect(h.bridge.removeImage(target, { ...selection.image })).toBe(false)
    expect(h.bridge.removeImage(h.capture('copy'), selection.image)).toBe(false)
    expect(h.bridge.removeImage(target, selection.image)).toBe(true)
    expect(h.sheets.getDrawingOrder(BOOK, SHEET)).toEqual(['image'])
    expect(h.bridge.removeImage(target, selection.image)).toBe(false)
    expect(await h.commands.executeCommand(UndoCommand.id)).toBe(true)
    expect(h.sheets.getDrawingOrder(BOOK, SHEET)).toEqual(['image', 'second'])
  })
})
