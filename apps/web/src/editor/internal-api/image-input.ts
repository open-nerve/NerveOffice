import type { IDisposable, IMultiCommand, IRange, Univer, Workbook, Worksheet } from '@univerjs/core'
import { isPlatformAssetAddress } from '@nerve-office/contracts'
import { CommandType, CustomCommandExecutionError, DOCS_NORMAL_EDITOR_UNIT_ID_KEY, DrawingTypeEnum, EDITOR_ACTIVATED, FOCUSING_FX_BAR_EDITOR, FOCUSING_SHEET, ICommandService, IContextService, ImageSourceType, IPermissionService, IUniverInstanceService, UniverInstanceType } from '@univerjs/core'
import { IDrawingManagerService } from '@univerjs/drawing'
import { RangeProtectionPermissionEditPoint, RangeProtectionPermissionViewPoint, SetRangeValuesCommand, SheetPermissionCheckController, SheetsSelectionsService, WorkbookCopyPermission, WorkbookEditablePermission, WorksheetCopyPermission, WorksheetEditExtraObjectPermission, WorksheetEditPermission, WorksheetSetCellStylePermission, WorksheetSetCellValuePermission } from '@univerjs/sheets'
import { ISheetDrawingService, RemoveSheetDrawingCommand } from '@univerjs/sheets-drawing'
import { PREDEFINED_HOOK_NAME_PASTE, SheetCopyCommand, SheetCutCommand, SheetPasteCommand, SheetPasteShortKeyCommand } from '@univerjs/sheets-ui'
import { prepareImageInsertion } from './image-input-insert.ts'
import { imageRecord } from './image-json.ts'
import { injectorOf } from './injector.ts'

export type ImageInputIntent = 'copy' | 'cut' | 'insert'

export interface CapturedImageTarget {
  readonly unitId: string
  readonly subUnitId: string
  readonly row: number
  readonly column: number
  readonly isCurrent: () => boolean
  readonly subscribe: (listener: () => void) => () => void
}

export interface SelectedInputImage {
  readonly kind: 'float' | 'cell'
  readonly source: string
  readonly drawingId: string
}

export type ImageInputSelection
  = | { readonly kind: 'none' }
    | { readonly kind: 'reject' }
    | { readonly kind: 'single', readonly image: SelectedInputImage }

export interface ImageInputBridgeOptions {
  readonly unitId: string
  readonly origin: string
  readonly available: (intent: ImageInputIntent) => boolean
  readonly subscribe: (listener: () => void) => () => void
}

export interface ImageInputCommands {
  readonly copy: (target: CapturedImageTarget, image: SelectedInputImage, cut: boolean) => Promise<boolean>
  readonly paste: (target: CapturedImageTarget) => Promise<boolean>
  readonly rejected: (reason: 'selection' | 'permission', intent: ImageInputIntent) => void
}

export interface ImageTableInput {
  readonly html?: string
  readonly text?: string
  readonly formulaClipboardPayload?: string
}

export interface PreparedInputImage {
  readonly source: string
  readonly width: number
  readonly height: number
}

interface TargetState {
  readonly intent: ImageInputIntent
  readonly workbook: Workbook
  readonly worksheet: Worksheet
  readonly range: IRange
  readonly imageRange: IRange
  readonly singleCell: boolean
  writeKind?: 'float' | 'cell'
  imageCurrent?: () => boolean
}

function stopped(): never {
  // MultiCommand 的 false 表示试下一个实现；接管后的失败必须终止整条命令。
  throw new CustomCommandExecutionError('图片操作未完成')
}

export function createImageInputBridge(univer: Univer, container: HTMLElement, options: ImageInputBridgeOptions) {
  const injector = injectorOf(univer)
  const instances = injector.get(IUniverInstanceService)
  const context = injector.get(IContextService)
  const commands = injector.get(ICommandService)
  const permissions = injector.get(IPermissionService)
  const permissionCheck = injector.get(SheetPermissionCheckController)
  const selections = injector.get(SheetsSelectionsService)
  const drawings = injector.get(IDrawingManagerService)
  const sheets = injector.get(ISheetDrawingService)
  const targets = new WeakMap<CapturedImageTarget, TargetState>()
  const images = new WeakMap<SelectedInputImage, { target: CapturedImageTarget, remove: () => boolean }>()
  const watches = new Set<() => void>()
  const cleanups = new Set<() => void>()
  let disposed = false

  function gridFocused(): boolean {
    if (disposed || !context.getContextValue(FOCUSING_SHEET) || context.getContextValue(EDITOR_ACTIVATED) || context.getContextValue(FOCUSING_FX_BAR_EDITOR))
      return false
    const active = container.ownerDocument.activeElement
    if (active === null || active === container.ownerDocument.body)
      return true
    // docs-ui 的隐藏输入承接普通画布按键；同样标记的编辑栏或宿主元素不能充当画布。
    if (container.contains(active) && active.id === `__editor_${DOCS_NORMAL_EDITOR_UNIT_ID_KEY}` && active.getAttribute('data-u-comp') === 'editor')
      return true
    if (active.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
      return false
    return container.contains(active)
  }

  function permitted(intent: ImageInputIntent, range: IRange, subUnitId: string): boolean {
    if (!options.available(intent))
      return false
    const writing = intent !== 'copy'
    return permissionCheck.permissionCheckWithRanges({
      workbookTypes: writing ? (intent === 'cut' ? [WorkbookCopyPermission, WorkbookEditablePermission] : [WorkbookEditablePermission]) : [WorkbookCopyPermission],
      worksheetTypes: writing ? (intent === 'cut' ? [WorksheetCopyPermission, WorksheetEditPermission] : [WorksheetEditPermission]) : [WorksheetCopyPermission],
      rangeTypes: writing ? [RangeProtectionPermissionViewPoint, RangeProtectionPermissionEditPoint] : [RangeProtectionPermissionViewPoint],
    }, [range], options.unitId, subUnitId)
  }

  function imagePermitted(range: IRange, subUnitId: string, kind: 'float' | 'cell'): boolean {
    return permissionCheck.permissionCheckWithRanges({
      workbookTypes: [WorkbookEditablePermission],
      worksheetTypes: kind === 'float' ? [WorksheetEditPermission, WorksheetEditExtraObjectPermission] : [WorksheetEditPermission, WorksheetSetCellValuePermission, WorksheetSetCellStylePermission],
      rangeTypes: [RangeProtectionPermissionEditPoint],
    }, [range], options.unitId, subUnitId)
  }

  function canWriteImage(target: CapturedImageTarget, kind: 'float' | 'cell'): boolean {
    const state = targets.get(target)
    if (!state || state.intent === 'copy' || !target.isCurrent() || !imagePermitted(state.imageRange, target.subUnitId, kind))
      return false
    // 识别为图片后才加入专属权限；之后权限短暂撤回也会令本次异步目标永久失效。
    state.writeKind = kind
    return true
  }

  function selectionVersion(): string {
    return JSON.stringify(selections.getCurrentSelections().map(selection => ({ range: selection.range, primary: selection.primary })))
  }

  function capture(intent: ImageInputIntent): CapturedImageTarget | undefined {
    const workbook = instances.getCurrentUnitOfType<Workbook>(UniverInstanceType.UNIVER_SHEET)
    const worksheet = workbook?.getActiveSheet()
    // Enter/Tab 在多选区域间移动时只移动 primary，不重排数组；最后一项未必有主单元格。
    const selection = selections.getCurrentSelections().find(item => item.primary !== null && item.primary !== undefined)
    const primary = selection?.primary
    if (!gridFocused() || !workbook || workbook.getUnitId() !== options.unitId || !worksheet || !selection || !primary)
      return undefined
    const unitId = workbook.getUnitId()
    const subUnitId = worksheet.getSheetId()
    // 表格剪贴板仍取原 SDK 的最后一项范围；图片锚点另外跟随有 primary 的活动项。
    const range = { ...(selections.getCurrentLastSelection()?.range ?? selection.range) }
    const imageRange = { ...selection.range }
    if (!permitted(intent, range, subUnitId))
      return undefined
    const version = selectionVersion()
    const row = primary.isMerged ? primary.startRow : primary.actualRow
    const column = primary.isMerged ? primary.startColumn : primary.actualColumn
    const singleCell = selections.getCurrentSelections().length === 1 && ((range.startRow === range.endRow && range.startColumn === range.endColumn)
      || (primary.isMerged && primary.startRow === range.startRow && primary.endRow === range.endRow && primary.startColumn === range.startColumn && primary.endColumn === range.endColumn))
    const state: TargetState = { intent, workbook, worksheet, range, imageRange, singleCell }
    let expired = false
    const isCurrent = (): boolean => {
      expired ||= disposed || !gridFocused() || !permitted(intent, range, subUnitId)
        || instances.getCurrentUnitOfType(UniverInstanceType.UNIVER_SHEET) !== workbook
        || instances.getUnit(unitId) !== workbook || workbook.getActiveSheet() !== worksheet
        || workbook.getSheetBySheetId(subUnitId) !== worksheet || selectionVersion() !== version
        || (state.writeKind !== undefined && !imagePermitted(imageRange, subUnitId, state.writeKind))
        || state.imageCurrent?.() === false
      return !expired
    }
    const target: CapturedImageTarget = Object.freeze({
      unitId,
      subUnitId,
      row,
      column,
      isCurrent,
      subscribe: (listener: () => void) => {
        if (!isCurrent()) {
          listener()
          return () => {}
        }
        const notify = (): void => {
          if (!isCurrent())
            listener()
        }
        watches.add(notify)
        const observers = [
          instances.focused$.subscribe(notify),
          instances.getCurrentTypeOfUnit$(UniverInstanceType.UNIVER_SHEET).subscribe(notify),
          instances.unitDisposed$.subscribe(notify),
          workbook.activeSheet$.subscribe(notify),
          selections.selectionMoveStart$.subscribe(notify),
          selections.selectionMoving$.subscribe(notify),
          selections.selectionChanged$.subscribe(notify),
          context.contextChanged$.subscribe(notify),
          permissions.permissionPointUpdate$.subscribe(notify),
          drawings.focus$.subscribe(notify),
        ]
        const commandObserver = commands.onCommandExecuted(notify)
        const removeIdentity = options.subscribe(() => {
          expired = true
          notify()
        })
        container.ownerDocument.addEventListener('focusin', notify)
        window.addEventListener('offline', notify)
        let removed = false
        const remove = (): void => {
          if (removed)
            return
          removed = true
          watches.delete(notify)
          cleanups.delete(remove)
          observers.forEach(observer => observer.unsubscribe())
          commandObserver.dispose()
          removeIdentity()
          container.ownerDocument.removeEventListener('focusin', notify)
          window.removeEventListener('offline', notify)
        }
        cleanups.add(remove)
        notify()
        return remove
      },
    })
    targets.set(target, state)
    return target
  }

  function selectedImage(target: CapturedImageTarget): ImageInputSelection {
    const state = targets.get(target)
    if (!state || !target.isCurrent())
      return { kind: 'reject' }
    const focused = drawings.getFocusDrawings()
    let value: unknown
    let kind: SelectedInputImage['kind']
    let unchanged: () => boolean
    let remove: () => boolean
    if (focused.length > 0) {
      const drawing = focused[0]
      if (focused.length !== 1 || !drawing || drawing.unitId !== target.unitId || drawing.subUnitId !== target.subUnitId || drawing.drawingType !== DrawingTypeEnum.DRAWING_IMAGE)
        return { kind: 'reject' }
      const identity = { unitId: target.unitId, subUnitId: target.subUnitId, drawingId: drawing.drawingId }
      const managerValue = drawings.getDrawingByParam(identity)
      const sheetValue = sheets.getDrawingByParam(identity)
      if (!imageRecord(managerValue) || !imageRecord(sheetValue) || managerValue.source !== sheetValue.source
        || managerValue.drawingId !== identity.drawingId || sheetValue.drawingId !== identity.drawingId
        || managerValue.imageSourceType !== sheetValue.imageSourceType || managerValue.drawingType !== sheetValue.drawingType) {
        return { kind: 'reject' }
      }
      const managerVersion = JSON.stringify(managerValue)
      const sheetVersion = JSON.stringify(sheetValue)
      value = managerValue
      kind = 'float'
      unchanged = () => drawings.getFocusDrawings().length === 1 && drawings.getFocusDrawings()[0]?.drawingId === identity.drawingId
        && drawings.getFocusDrawings()[0]?.unitId === identity.unitId && drawings.getFocusDrawings()[0]?.subUnitId === identity.subUnitId
        && JSON.stringify(drawings.getDrawingByParam(identity)) === managerVersion && JSON.stringify(sheets.getDrawingByParam(identity)) === sheetVersion
      remove = () => commands.syncExecuteCommand(RemoveSheetDrawingCommand.id, { unitId: target.unitId, drawings: [{ ...identity, drawingType: DrawingTypeEnum.DRAWING_IMAGE }] })
    }
    else {
      if (!state.singleCell)
        return { kind: 'none' }
      const cell = state.worksheet.getCellMatrix().getValue(target.row, target.column)
      const document = cell?.p
      if (!document || !document.drawingsOrder || document.drawingsOrder.length === 0 || (cell?.f ?? '') !== '')
        return { kind: 'none' }
      const drawingId = document.drawingsOrder[0]
      const body = document.body
      if (document.drawingsOrder.length !== 1 || drawingId === undefined || drawingId === '' || !document.drawings || Object.keys(document.drawings).length !== 1
        || !body || body.dataStream.replace(/[\r\n]/g, '') !== '\b' || body.customBlocks?.length !== 1
        || body.customBlocks[0]?.blockId !== drawingId || body.customBlocks[0].startIndex !== body.dataStream.indexOf('\b')) {
        return { kind: 'reject' }
      }
      value = document.drawings[drawingId]
      kind = 'cell'
      const version = JSON.stringify(cell)
      unchanged = () => drawings.getFocusDrawings().length === 0 && JSON.stringify(state.worksheet.getCellMatrix().getValue(target.row, target.column)) === version
      remove = () => commands.syncExecuteCommand(SetRangeValuesCommand.id, {
        unitId: target.unitId,
        subUnitId: target.subUnitId,
        value: { [target.row]: { [target.column]: { v: null, p: null, f: null } } },
      })
    }
    if (!imageRecord(value) || value.drawingType !== DrawingTypeEnum.DRAWING_IMAGE || value.imageSourceType !== ImageSourceType.URL
      || typeof value.drawingId !== 'string' || typeof value.source !== 'string' || !isPlatformAssetAddress(value.source, options.origin)) {
      return { kind: 'reject' }
    }
    const source = value.source.startsWith('/') ? value.source : value.source.slice(options.origin.length)
    const image = Object.freeze({ kind, drawingId: value.drawingId, source })
    images.set(image, { target, remove })
    state.imageCurrent = unchanged
    return { kind: 'single', image }
  }

  function installCommands(handlers: ImageInputCommands): IDisposable {
    if (disposed)
      return { dispose: () => {} }
    const definitions = [SheetCopyCommand, SheetCutCommand, SheetPasteCommand]
    const registrations = definitions.map((command) => {
      const implementation: IMultiCommand = {
        id: command.id,
        name: `nerve-image:${command.name}`,
        type: CommandType.COMMAND,
        multi: true,
        priority: command.priority + 1,
        preconditions: gridFocused,
        handler: async (_accessor, params) => {
          const paste = command.id === SheetPasteCommand.id
          if (paste && imageRecord(params) && params.value !== undefined && params.value !== PREDEFINED_HOOK_NAME_PASTE.DEFAULT_PASTE)
            return false
          const cut = command.id === SheetCutCommand.id
          const intent = paste ? 'insert' : cut ? 'cut' : 'copy'
          const target = capture(intent)
          if (!target) {
            handlers.rejected('permission', intent)
            return stopped()
          }
          try {
            let result: Promise<boolean>
            if (paste) {
              result = handlers.paste(target)
            }
            else {
              const selected = selectedImage(target)
              if (selected.kind === 'none')
                return false
              if (selected.kind === 'reject') {
                handlers.rejected('selection', intent)
                return stopped()
              }
              if (cut && !canWriteImage(target, selected.image.kind)) {
                handlers.rejected('permission', intent)
                return stopped()
              }
              result = handlers.copy(target, selected.image, cut)
            }
            if (await result)
              return true
          }
          catch {
            return stopped()
          }
          return stopped()
        },
      }
      return commands.registerMultipleCommand(implementation)
    })
    let removed = false
    const dispose = (): void => {
      if (removed)
        return
      removed = true
      registrations.forEach(registration => registration.dispose())
      cleanups.delete(dispose)
    }
    cleanups.add(dispose)
    return { dispose }
  }

  return {
    gridFocused,
    capture,
    selectedImage,
    canWriteImage,
    insertImage: (target: CapturedImageTarget, image: PreparedInputImage, kind: 'float' | 'cell'): boolean => {
      if (targets.get(target)?.intent !== 'insert' || !canWriteImage(target, kind))
        return false
      const command = prepareImageInsertion(univer, target, image, kind, options.origin)
      return command !== undefined && target.isCurrent() && commands.syncExecuteCommand(command.id, command.params)
    },
    removeImage: (target: CapturedImageTarget, image: SelectedInputImage): boolean => {
      const binding = images.get(image)
      return targets.get(target)?.intent === 'cut' && binding?.target === target && canWriteImage(target, image.kind) && binding.remove()
    },
    pasteTable: async (target: CapturedImageTarget, data: ImageTableInput): Promise<boolean> => {
      const state = targets.get(target)
      if (!state || state.intent !== 'insert' || !target.isCurrent())
        return false
      return commands.executeCommand(SheetPasteShortKeyCommand.id, {
        htmlContent: data.html,
        textContent: data.text,
        formulaClipboardPayload: data.formulaClipboardPayload,
        files: [],
        target: { unitId: target.unitId, subUnitId: target.subUnitId, range: { ...state.range } },
      })
    },
    installCommands,
    dispose: () => {
      if (disposed)
        return
      disposed = true
      for (const notify of watches)
        notify()
      for (const remove of cleanups)
        remove()
    },
  }
}
