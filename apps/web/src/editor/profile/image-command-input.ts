import type { ImageSourceResult } from '../images/image-source-policy.ts'
import { normalizeImageAxis, normalizeImageCell, normalizeImageCells, normalizeImageFragment, normalizeImageSheet } from '../images/image-source-policy.ts'
import { IMAGE_COMMAND_PROTOCOL, imageCellValueIsSingle } from '../internal-api/ui.ts'

const C = IMAGE_COMMAND_PROTOCOL
type Cleaner = (value: unknown, origin: string) => ImageSourceResult

export type PreparedImageInput
  = | { readonly ok: false }
    | { readonly ok: true, readonly params: unknown, readonly changed: boolean, readonly commit: () => boolean }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function movePart(value: unknown, origin: string): ImageSourceResult {
  if (!record(value))
    return { ok: false, reason: 'structure' }
  const result = normalizeImageCells(value.value, origin)
  return result.ok ? { ok: true, value: result.changed ? { ...value, value: result.value } : value, changed: result.changed } : result
}

function fields(id: string, params: Record<string, unknown>): Record<string, Cleaner> {
  if (id === C.insert || id === C.update)
    return { drawings: normalizeImageFragment }
  if (id === C.setCells)
    return { value: imageCellValueIsSingle(params.value) ? normalizeImageCell : normalizeImageCells }
  if (id === C.applyCells)
    return { cellValue: normalizeImageCells }
  if (C.insertAxis.includes(id))
    return { cellValue: normalizeImageCells }
  if (C.applyAxis.includes(id))
    return { rowInfo: normalizeImageAxis, colInfo: normalizeImageAxis }
  if (id === C.insertSheet || id === C.applySheet)
    return { sheet: normalizeImageSheet, styles: normalizeImageFragment }
  if (id === C.applyMove)
    return { from: movePart, to: movePart }
  return {}
}

/** 所有改动先准备好，再一次提交已验证的字段。拒绝/冻结参数不留下前一个字段的改写。 */
function prepared(params: Record<string, unknown>, changes: Record<string, unknown>): PreparedImageInput {
  const keys = Object.keys(changes)
  return {
    ok: true,
    changed: keys.length > 0,
    params: keys.length > 0 ? { ...params, ...changes } : params,
    commit: () => {
      if (keys.some(key => Object.getOwnPropertyDescriptor(params, key)?.writable !== true))
        return false
      for (const key of keys) {
        if (!Reflect.set(params, key, changes[key]))
          return false
      }
      return true
    },
  }
}

export function prepareImageCommandInput(id: string, params: unknown, origin: string): PreparedImageInput {
  if (params === undefined)
    return { ok: true, params, changed: false, commit: () => true }
  if (!record(params))
    return { ok: false }
  const changes: Record<string, unknown> = {}
  for (const [key, normalize] of Object.entries(fields(id, params))) {
    const result = normalize(params[key], origin)
    if (!result.ok)
      return { ok: false }
    if (result.changed)
      changes[key] = result.value
  }
  return prepared(params, changes)
}
