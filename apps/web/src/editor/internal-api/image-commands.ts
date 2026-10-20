import type { Univer } from '@univerjs/core'
import { isICellData, IUndoRedoService, JSON1, RedoCommand, UndoCommand } from '@univerjs/core'
import { IDrawingManagerService } from '@univerjs/drawing'
import { SetRangeValuesCommand, SetRangeValuesMutation } from '@univerjs/sheets'
import { InsertSheetDrawingCommand, ISheetDrawingService, RemoveSheetDrawingCommand, SetDrawingApplyMutation, SetSheetDrawingCommand, SetWorksheetBackgroundImageCommand, SetWorksheetBackgroundImageMutation } from '@univerjs/sheets-drawing'
import { acceptsImageCellWrite } from './image-cells.ts'
import { imageRecord, pureImageOperation, safeImageKey, validDrawingMaps } from './image-json.ts'
import { acceptsImageSheetInput, acceptsImageStructure, IMAGE_STRUCTURE_PROTOCOL, imageMoveTargets } from './image-structure.ts'
import { injectorOf } from './injector.ts'

export const IMAGE_COMMAND_PROTOCOL = Object.freeze({
  ...IMAGE_STRUCTURE_PROTOCOL,
  insert: InsertSheetDrawingCommand.id,
  update: SetSheetDrawingCommand.id,
  remove: RemoveSheetDrawingCommand.id,
  apply: SetDrawingApplyMutation.id,
  setCells: SetRangeValuesCommand.id,
  applyCells: SetRangeValuesMutation.id,
  background: SetWorksheetBackgroundImageCommand.id,
  applyBackground: SetWorksheetBackgroundImageMutation.id,
  undo: UndoCommand.id,
  redo: RedoCommand.id,
})

type TransitionCheck = (before: unknown, after: unknown) => boolean
type CellCheck = (params: unknown) => boolean
type DrawingState = IDrawingManagerService['drawingManagerData']
type JsonDocument = Parameters<typeof JSON1.type.apply>[0]

function validNotifications(params: Record<string, unknown>): boolean {
  if (typeof params.type !== 'number' || !Number.isInteger(params.type) || params.type < 0 || params.type > 5 || !Array.isArray(params.objects) || params.objects.length > 100_000)
    return false
  const search = (value: unknown): boolean => imageRecord(value) && safeImageKey(value.unitId) && safeImageKey(value.subUnitId) && safeImageKey(value.drawingId)
  return params.objects.every((value: unknown) => params.type === 4 || params.type === 5
    ? imageRecord(value) && search(value.parent) && Array.isArray(value.children) && value.children.length <= 100_000 && value.children.every(search)
    : search(value))
}

export function previewImageMutation(state: unknown, params: unknown, valid: TransitionCheck): unknown {
  if (!imageRecord(params) || !safeImageKey(params.unitId) || !safeImageKey(params.subUnitId) || !validNotifications(params) || !pureImageOperation(params.op) || !validDrawingMaps(state))
    throw new Error('无法预检图片操作')
  const { unitId, subUnitId } = params
  const prepared = { ...state, [unitId]: { ...state[unitId], [subUnitId]: state[unitId]?.[subUnitId] ?? { data: {}, order: [] } } }
  // SDK 的 drawing 数据由资源 JSON 与规范命令构成；接口里的 IDrawing 没有 Doc 索引签名。
  // 此处与固定 UnitDrawingService 使用同一基础结构、同一 apply，仅允许已证明纯的子类型。
  const next: unknown = JSON1.type.apply(prepared as JsonDocument, params.op)
  if (!validDrawingMaps(next) || !valid(state, next))
    throw new Error('图片候选状态不符合写入规则')
  return next
}

/** 固定 SDK 对 value 的单格判定，避免普通对象矩阵与单格富文本走不同分支。 */
export function imageCellValueIsSingle(value: unknown): boolean {
  return imageRecord(value) && Boolean(isICellData(value))
}

/** 只返回判断结果；不暴露服务、改动绘图对象或调用会建立空映射的 getBatch*Op。 */
export function createImageCommandPreview(univer: Univer, valid: TransitionCheck) {
  const injector = injectorOf(univer)
  const states = (): DrawingState[] => [injector.get(IDrawingManagerService).drawingManagerData, injector.get(ISheetDrawingService).drawingManagerData]
  const safe = (read: () => boolean): boolean => {
    try {
      return read()
    }
    catch { return false }
  }
  return {
    structure: (id: string, params: unknown, validSheet: CellCheck, validFragment: CellCheck): boolean => safe(() => acceptsImageStructure(univer, id, params, validSheet, validFragment)),
    sheet: (params: unknown, validFragment: CellCheck): boolean => safe(() => acceptsImageSheetInput(univer, params, validFragment)),
    move: (params: unknown, validCell: CellCheck): boolean => safe(() => {
      const targets = imageMoveTargets(univer, params)
      return targets !== undefined && targets.every(target => acceptsImageCellWrite(univer, target, target.cellValue, true, validCell))
    }),
    cells: (params: unknown, value: unknown, mutation: boolean, validCell: CellCheck): boolean => safe(() => acceptsImageCellWrite(univer, params, value, mutation, validCell)),
    mutation: (params: unknown): boolean => safe(() => {
      for (const state of states())
        previewImageMutation(state, params, valid)
      return true
    }),
    updates: (value: unknown, remove: boolean): boolean => safe(() => {
      if (!Array.isArray(value) || value.length === 0)
        return false
      for (const state of states()) {
        for (const drawing of value) {
          if (!imageRecord(drawing) || !safeImageKey(drawing.unitId) || !safeImageKey(drawing.subUnitId) || !safeImageKey(drawing.drawingId))
            return false
          const before = state[drawing.unitId]?.[drawing.subUnitId]?.data[drawing.drawingId]
          if (!valid(before, remove ? undefined : { ...before, ...drawing }))
            return false
        }
      }
      return true
    }),
    history: (id: string, validInput: (id: string, params: unknown) => boolean): boolean => safe(() => {
      const history = injector.get(IUndoRedoService)
      const record = id === UndoCommand.id ? history.pitchTopUndoElement() : history.pitchTopRedoElement()
      if (!record)
        return true
      const commands = id === UndoCommand.id ? record.undoMutations : record.redoMutations
      let candidates: unknown[] | undefined
      for (const command of commands) {
        if (command.id === SetDrawingApplyMutation.id) {
          candidates ??= states()
          candidates = candidates.map(state => previewImageMutation(state, command.params, valid))
        }
        else if (!validInput(command.id, command.params)) {
          return false
        }
      }
      return true
    }),
  }
}
