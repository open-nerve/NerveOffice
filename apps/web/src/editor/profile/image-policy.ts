import type { IDisposable, Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import type { ImageCleanupScope, LegacyImageRemoval } from '../internal-api/ui.ts'
import { acceptsImageTransition, normalizeImageCell, normalizeImageFragment, normalizeImageSheet } from '../images/image-source-policy.ts'
import { createImageCommandPreview, IMAGE_COMMAND_PROTOCOL, prepareLegacyImageRemoval } from '../internal-api/ui.ts'
import { prepareImageCommandInput } from './image-command-input.ts'

const C = IMAGE_COMMAND_PROTOCOL

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const RELATED = new Set([C.insert, C.update, C.remove, C.apply, C.setCells, C.applyCells, C.insertSheet, C.applySheet, C.applyMove, ...C.structural, ...C.insertAxis, ...C.applyAxis])

const legacyTransition = (before: unknown, after: unknown): boolean => acceptsImageTransition(before, after, true)

function commandChecker(univer: Univer, permits: WeakSet<object>): (id: string, params: unknown) => boolean {
  const preview = createImageCommandPreview(univer, acceptsImageTransition)
  const cleanupPreview = createImageCommandPreview(univer, legacyTransition)
  const validCell = (cell: unknown): boolean => {
    const result = normalizeImageCell(cell, '')
    return result.ok && !result.changed
  }
  const validFragment = (value: unknown): boolean => {
    const result = normalizeImageFragment(value, '')
    return result.ok && !result.changed
  }
  const validSheet = (value: unknown): boolean => {
    const result = normalizeImageSheet(value, '')
    return result.ok && !result.changed
  }
  const check = (id: string, params: unknown, history: boolean): boolean => {
    if (id === C.background || id === C.applyBackground)
      return false
    if (!RELATED.has(id))
      return true
    if (C.structural.includes(id) || C.insertAxis.includes(id)) {
      if (!preview.structure(id, params, validSheet, validFragment))
        return false
    }
    if (C.structural.includes(id))
      return true
    if (id === C.insertSheet || id === C.applySheet)
      return preview.sheet(params, validFragment)
    if (!record(params))
      return false
    if (id === C.apply)
      return permits.has(params) ? cleanupPreview.mutation(params) : preview.mutation(params)
    if (id === C.remove)
      return preview.updates(params.drawings, true)
    if (id === C.insert || id === C.update)
      return preview.updates(params.drawings, false)
    if (id === C.applyMove)
      return preview.move(params, validCell)
    if (C.applyAxis.includes(id))
      return preview.sheet({ unitId: params.unitId, sheet: { rowData: params.rowInfo, columnData: params.colInfo } }, validFragment)
    if (id !== C.setCells && id !== C.applyCells && !C.insertAxis.includes(id))
      return true
    const field = id === C.setCells ? 'value' : 'cellValue'
    if (history)
      return preview.sheet({ unitId: params.unitId, sheet: { cellData: params[field] } }, validFragment)
    return preview.cells(params, params[field], id !== C.setCells, validCell)
  }
  const historyInput = (id: string, params: unknown): boolean => {
    if (!RELATED.has(id))
      return check(id, params, true)
    const input = prepareImageCommandInput(id, params, '')
    return input.ok && !input.changed && check(id, input.params, true)
  }
  return (id, params) => {
    if (id === C.undo || id === C.redo)
      return preview.history(id, historyInput)
    if (!RELATED.has(id))
      return check(id, params, false)
    const input = prepareImageCommandInput(id, params, location.origin)
    return input.ok && check(id, input.params, false) && input.commit()
  }
}

export interface ImagePolicy extends IDisposable {
  readonly prepareLegacyRemoval: (sheetId: string, ids: readonly string[]) => LegacyImageRemoval | undefined
}

export function installImagePolicy(univer: Univer, api: FUniver, report: (error: unknown) => void, scope?: ImageCleanupScope): ImagePolicy {
  let active = true
  const permits = new WeakSet<object>()
  const accept = commandChecker(univer, permits)
  const before = (id: string, params: unknown, event: { cancel?: boolean }): void => {
    if (event.cancel)
      return
    let accepted = false
    try {
      accepted = accept(id, params)
    }
    catch { /* 畸形图片参数只作整次拒绝，不回显输入。 */ }
    if (accepted)
      return
    event.cancel = true
    try {
      report(new Error('图片操作未完成：来源不符合要求，或需要先确认清理旧图片。'))
    }
    catch { /* 错误通道失效也不能让被拒绝的写入继续。 */ }
  }
  // Facade 的通用事件明确跳过 Undo/Redo；必须在专属事件里预检，不能等内部 mutation 再拒绝。
  const subscriptions = [
    api.addEvent(api.Event.BeforeCommandExecute, event => before(event.id, event.params, event)),
    api.addEvent(api.Event.BeforeUndo, event => before(C.undo, undefined, event)),
    api.addEvent(api.Event.BeforeRedo, event => before(C.redo, undefined, event)),
  ]
  return {
    prepareLegacyRemoval: (sheetId, ids) => scope === undefined
      ? undefined
      : prepareLegacyImageRemoval(univer, {
          unitId: scope.unitId,
          canEdit: () => active && scope.canEdit(),
        }, sheetId, ids, acceptsImageTransition, legacyTransition, (params, execute) => {
          permits.add(params)
          try {
            return execute()
          }
          finally {
            permits.delete(params)
          }
        }, report),
    dispose: () => {
      if (!active)
        return
      active = false
      for (const subscription of subscriptions)
        subscription.dispose()
    },
  }
}
