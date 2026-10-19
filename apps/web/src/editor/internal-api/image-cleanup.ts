import type { JSONXActions, Univer, Workbook } from '@univerjs/core'
import { DrawingTypeEnum, ICommandService, IPermissionService, IUndoRedoService, IUniverInstanceService, JSON1, UniverInstanceType } from '@univerjs/core'
import { IDrawingManagerService } from '@univerjs/drawing'
import { WorkbookEditablePermission, WorksheetEditPermission } from '@univerjs/sheets'
import { ClearSheetDrawingTransformerOperation, DrawingApplyType, ISheetDrawingService, SetDrawingApplyMutation } from '@univerjs/sheets-drawing'
import { previewImageMutation } from './image-commands.ts'
import { compatibleDrawingSheets, safeImageKey } from './image-json.ts'
import { injectorOf } from './injector.ts'

export interface ImageCleanupScope {
  readonly unitId: string
  /** 由宿主绑定编辑身份及生命周期；确认后再读取，不能复用准备时的许可。 */
  readonly canEdit: () => boolean
}

export interface LegacyImageRemoval {
  /** 调用方须明确告知：无法撤销，并清除当前文档此前的撤销历史。票据仅可使用一次。 */
  readonly confirm: (confirmedHistoryReset: boolean) => 'cancelled' | 'rejected' | 'removed'
}

type Transition = (before: unknown, after: unknown) => boolean
type Authorize = (params: object, execute: () => boolean) => boolean

/** 许可所绑定的操作不可被稍后的命令监听者改成另一笔写入。 */
function freezeOperation(value: unknown): void {
  if (typeof value !== 'object' || value === null)
    return
  for (const child of Object.values(value))
    freezeOperation(child)
  Object.freeze(value)
}

/**
 * 只支持选定的、未分组且只有一个渲染实例的浮动坏图。准备不写模型、不生成 undo。
 * 确认时检查原对象仍在，两个服务用同一个纯删除 op 预演，再走正常 mutation 与只读防火墙。
 */
export function prepareLegacyImageRemoval(univer: Univer, scope: ImageCleanupScope, subUnitId: string, requestedIds: readonly string[], strict: Transition, legacy: Transition, authorize: Authorize, report: (error: unknown) => void): LegacyImageRemoval | undefined {
  try {
    if (!scope.canEdit() || !safeImageKey(scope.unitId) || !safeImageKey(subUnitId) || requestedIds.length === 0 || requestedIds.length > 100 || !requestedIds.every(safeImageKey) || new Set(requestedIds).size !== requestedIds.length)
      return undefined
    const ids = Object.freeze([...requestedIds])
    const { unitId } = scope
    const injector = injectorOf(univer)
    const instances = injector.get(IUniverInstanceService)
    const book = instances.getUnit<Workbook>(unitId, UniverInstanceType.UNIVER_SHEET)
    const sheet = book?.getSheetBySheetId(subUnitId)
    const permissions = injector.get(IPermissionService)
    const permitted = (): boolean => scope.canEdit()
      && instances.getUnit(unitId, UniverInstanceType.UNIVER_SHEET) === book
      && book?.getSheetBySheetId(subUnitId) === sheet
      && permissions.getPermissionPoint(new WorkbookEditablePermission(unitId).id)?.value === true
      && permissions.getPermissionPoint(new WorksheetEditPermission(unitId, subUnitId).id)?.value === true
    if (!book || !sheet || !permitted())
      return undefined
    const services = [injector.get(IDrawingManagerService), injector.get(ISheetDrawingService)]
    const maps = services.map(service => service.drawingManagerData[unitId]?.[subUnitId])
    if (!compatibleDrawingSheets(maps[0], maps[1], { unitId, subUnitId }))
      return undefined
    const selected = services.map(service => ids.map(drawingId => service.drawingManagerData[unitId]?.[subUnitId]?.data[drawingId]))
    if (selected.some(drawings => drawings.some(drawing => !drawing
      || drawing.drawingType !== DrawingTypeEnum.DRAWING_IMAGE
      || drawing.unitId !== unitId || drawing.subUnitId !== subUnitId || !ids.includes(drawing.drawingId)
      || Boolean(drawing.groupId) || Boolean(drawing.isMultiTransform)
      || strict(drawing, undefined)))) {
      return undefined
    }
    const identityKeys = ['unitId', 'subUnitId', 'drawingId', 'drawingType', 'source', 'base64Cache', 'groupId', 'isMultiTransform']
    const identities = selected.map(drawings => drawings.map(drawing => identityKeys.map((key): unknown => drawing === undefined ? undefined : Object.getOwnPropertyDescriptor(drawing, key)?.value)))
    const order = [...maps[0]?.order ?? []]
    if (ids.some(id => !order.includes(id)))
      return undefined
    let op: JSONXActions = null
    for (const id of [...ids].sort((a, b) => order.indexOf(b) - order.indexOf(a))) {
      op = JSON1.type.compose(op, JSON1.removeOp([unitId, subUnitId, 'data', id], true))
      op = JSON1.type.compose(op, JSON1.removeOp([unitId, subUnitId, 'order', order.indexOf(id)], true))
    }
    const params = { unitId, subUnitId, op, objects: ids.map(drawingId => ({ unitId, subUnitId, drawingId })), type: DrawingApplyType.REMOVE }
    freezeOperation(params)
    const preflight = (): boolean => {
      if (!permitted())
        return false
      for (const [index, service] of services.entries()) {
        const current = service.drawingManagerData[unitId]?.[subUnitId]
        // 准备后的顺序/对象变化使票据失效；不能把一次旧确认用于另一张图片。
        if (!current || current.order.length !== order.length || current.order.some((id, position) => id !== order[position])
          || ids.some((id, position) => {
            const drawing = current.data[id]
            return drawing === undefined || drawing !== selected[index]?.[position]
              || identityKeys.some((key, field) => !Object.is(Object.getOwnPropertyDescriptor(drawing, key)?.value, identities[index]?.[position]?.[field]))
          })) {
          return false
        }
        previewImageMutation(service.drawingManagerData, params, legacy)
      }
      return true
    }
    if (!preflight())
      return undefined
    let used = false
    return Object.freeze({ confirm: (confirmed: boolean): 'cancelled' | 'rejected' | 'removed' => {
      if (used)
        return 'rejected'
      used = true
      if (confirmed !== true)
        return 'cancelled'
      try {
        if (!preflight())
          return 'rejected'
        const commands = injector.get(ICommandService)
        let notificationFailed = false
        try {
          authorize(params, () => commands.syncExecuteCommand(SetDrawingApplyMutation.id, params))
        }
        catch {
          notificationFailed = true
        }
        // CommandService 在 handler 提交之后还同步调用 onCommandExecuted；抛错不代表回滚。
        // 被取消的命令没有删除目标；两边已删除则必须完成本次明确确认的历史屏障。
        if (services.some(service => ids.some(id => service.drawingManagerData[unitId]?.[subUnitId]?.data[id] !== undefined)))
          return 'rejected'
        injector.get(IUndoRedoService).clearUndoRedo(unitId)
        try {
          commands.syncExecuteCommand(ClearSheetDrawingTransformerOperation.id, [unitId])
        }
        catch {
          notificationFailed = true
        }
        if (notificationFailed) {
          try {
            report(new Error('旧图片已清理，后续显示通知未能完成。'))
          }
          catch { /* 保留已经完成的事务结果。 */ }
        }
        return 'removed'
      }
      catch {
        return 'rejected'
      }
    } })
  }
  catch {
    return undefined
  }
}
