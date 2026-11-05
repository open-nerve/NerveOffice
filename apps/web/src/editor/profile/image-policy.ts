import type { IDisposable, Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import type { ImageSourceResult } from '../images/image-source-policy.ts'
import type { ImageWriteRejection } from '../images/system-image-input.ts'
import type { ImageCleanupScope, LegacyImageRemoval } from '../internal-api/ui.ts'
import { acceptsImageTransition, imageTransition, normalizeImageCell, normalizeImageFragment, normalizeImageSheet } from '../images/image-source-policy.ts'
import { createImageCommandPreview, IMAGE_COMMAND_PROTOCOL, prepareLegacyImageRemoval } from '../internal-api/ui.ts'
import { prepareImageCommandInput } from './image-command-input.ts'

const C = IMAGE_COMMAND_PROTOCOL

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const RELATED = new Set([C.insert, C.update, C.remove, C.apply, C.setCells, C.applyCells, C.insertSheet, C.applySheet, C.applyMove, ...C.structural, ...C.insertAxis, ...C.applyAxis])

const legacyTransition = (before: unknown, after: unknown): boolean => acceptsImageTransition(before, after, true)

type FragmentFailure = Extract<ImageSourceResult, { ok: false }>['reason']
const REJECTIONS: Readonly<Record<FragmentFailure, ImageWriteRejection>> = { source: 'write-source', limit: 'write-limit', structure: 'write-structure' }

/** 返回 undefined 表示放行；拒绝时返回最后一个判定失败的有界原因，未归类的失败按结构处理。 */
function commandChecker(univer: Univer, permits: WeakSet<object>): (id: string, params: unknown) => ImageWriteRejection | undefined {
  let reason: ImageWriteRejection = 'write-structure'
  const settled = (result: ImageSourceResult): boolean => {
    if (!result.ok)
      reason = REJECTIONS[result.reason]
    else if (result.changed)
      reason = 'write-source'
    return result.ok && !result.changed
  }
  const transition = (allowLegacyRemoval: boolean) => (before: unknown, after: unknown): boolean => {
    const result = imageTransition(before, after, allowLegacyRemoval)
    if (!result.ok)
      reason = REJECTIONS[result.reason]
    return result.ok
  }
  const preview = createImageCommandPreview(univer, transition(false))
  const cleanupPreview = createImageCommandPreview(univer, transition(true))
  const validCell = (cell: unknown): boolean => settled(normalizeImageCell(cell, ''))
  const validFragment = (value: unknown): boolean => settled(normalizeImageFragment(value, ''))
  const validSheet = (value: unknown): boolean => settled(normalizeImageSheet(value, ''))
  const check = (id: string, params: unknown, history: boolean): boolean => {
    if (id === C.background || id === C.applyBackground) {
      reason = 'write-unsupported'
      return false
    }
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
    if (!input.ok) {
      reason = REJECTIONS[input.reason]
      return false
    }
    if (input.changed) {
      reason = 'write-source'
      return false
    }
    return check(id, input.params, true)
  }
  const accepts = (id: string, params: unknown): boolean => {
    if (id === C.undo || id === C.redo)
      return preview.history(id, historyInput)
    if (!RELATED.has(id))
      return check(id, params, false)
    const input = prepareImageCommandInput(id, params, location.origin)
    if (!input.ok) {
      reason = REJECTIONS[input.reason]
      return false
    }
    if (!check(id, input.params, false))
      return false
    reason = 'write-structure'
    return input.commit()
  }
  return (id, params) => {
    reason = 'write-structure'
    return accepts(id, params) ? undefined : reason
  }
}

/** 图片显示与资源请求的失败走 failed；写入策略的拒绝走 rejected，只带有界原因，不回显输入（M5R-M-10）。 */
export interface ImagePolicyChannels {
  readonly failed: (error: unknown) => void
  readonly rejected: (reason: ImageWriteRejection) => void
}

export interface ImagePolicy extends IDisposable {
  readonly prepareLegacyRemoval: (sheetId: string, ids: readonly string[]) => LegacyImageRemoval | undefined
}

export function installImagePolicy(univer: Univer, api: FUniver, channels: ImagePolicyChannels, scope?: ImageCleanupScope): ImagePolicy {
  let active = true
  const permits = new WeakSet<object>()
  const accept = commandChecker(univer, permits)
  const report = channels.failed
  const before = (id: string, params: unknown, event: { cancel?: boolean }): void => {
    if (event.cancel)
      return
    let rejection: ImageWriteRejection | undefined = 'write-structure'
    try {
      rejection = accept(id, params)
    }
    catch { /* 畸形图片参数只作整次拒绝，不回显输入。 */ }
    if (rejection === undefined)
      return
    event.cancel = true
    try {
      channels.rejected(rejection)
    }
    catch { /* 提示通道失效也不能让被拒绝的写入继续。 */ }
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
