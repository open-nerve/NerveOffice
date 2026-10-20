import type { JSONXActions } from '@univerjs/core'
import { JSON1 } from '@univerjs/core'

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const PURE_SUBTYPES = new Set(['text-unicode', 'number', 'http://sharejs.org/types/text-unicode'])

export function imageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function safeImageKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !FORBIDDEN_KEYS.has(value)
}

/** 操作对象必须是有界的普通 JSON 数据，保证后面的 SDK 校验不会触发 getter 或碰到循环。 */
function isJsonData(value: unknown): boolean {
  let count = 0
  const ancestors = new WeakSet<object>()
  const visit = (item: unknown, depth: number): boolean => {
    if (++count > 100_000 || depth > 64)
      return false
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)))
      return true
    if (typeof item !== 'object' || ancestors.has(item))
      return false
    const prototype: unknown = Object.getPrototypeOf(item)
    if (prototype !== Object.prototype && prototype !== null && !(Array.isArray(item) && prototype === Array.prototype))
      return false
    if (Array.isArray(item) && item.length > 100_000)
      return false
    const keys = Reflect.ownKeys(item)
    if (Array.isArray(item) && (keys.length !== item.length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= item.length))))
      return false
    ancestors.add(item)
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length')
        continue
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key) || !descriptor || !('value' in descriptor) || !visit(descriptor.value, depth + 1))
        return false
    }
    ancestors.delete(item)
    return true
  }
  return visit(value, 0)
}

/** i/r 是数据，e/es/ena 才是编辑操作；绝不把被删除的 source 当新输入。 */
function pureComponents(list: readonly unknown[]): boolean {
  return list.every((part) => {
    if (Array.isArray(part))
      return pureComponents(part)
    if (typeof part === 'string')
      return !FORBIDDEN_KEYS.has(part)
    if (typeof part === 'number')
      return true
    return imageRecord(part) && (part.et === undefined || (typeof part.et === 'string' && PURE_SUBTYPES.has(part.et)))
  })
}

export function pureImageOperation(value: unknown): value is JSONXActions {
  if (!isJsonData(value) || (value !== null && (!Array.isArray(value) || !pureComponents(value))))
    return false
  // 已证明 JSONOp 的递归容器形状；具体分量、顺序、配对和子类型参数交给固定 SDK 的同一校验器。
  JSON1.type.checkValidOp(value as JSONXActions)
  return true
}

/** 与 UnitDrawingService.applyJson1 的最终结构检查一致，并拒绝无法读取的容器。 */
export function validDrawingMaps(value: unknown): value is Record<string, Record<string, { data: Record<string, unknown>, order: string[] }>> {
  if (!imageRecord(value))
    return false
  for (const [unitId, unit] of Object.entries(value)) {
    if (!safeImageKey(unitId) || !imageRecord(unit))
      return false
    for (const [sheetId, sheet] of Object.entries(unit)) {
      if (!safeImageKey(sheetId) || !imageRecord(sheet) || !imageRecord(sheet.data) || !Object.keys(sheet.data).every(safeImageKey) || !Array.isArray(sheet.order) || !sheet.order.every(safeImageKey))
        return false
    }
  }
  return true
}

/**
 * 结构命令先改表、再运行由 sheet 服务生成的 JSON1；两服务须具备相同的操作路径。
 * 渲染端会单独重算像素 transform，数值差异合法；不能要求整个绘图对象逐值相等。
 * 字符串（含身份、来源和分组关系）、数组长度、属性路径必须相同。
 */
export function compatibleDrawingSheets(left: unknown, right: unknown, space: { unitId: string, subUnitId: string }, checkLayout = false): boolean {
  const empty = { data: {}, order: [] }
  const first = left ?? empty
  const second = right ?? empty
  const validSheet = (value: unknown): value is { data: Record<string, unknown>, order: string[] } => {
    if (!imageRecord(value) || !imageRecord(value.data) || !Array.isArray(value.order))
      return false
    const data = value.data
    const keys = Object.keys(data)
    return keys.length <= 100_000 && keys.length === value.order.length
      && keys.every(key => safeImageKey(key) && imageRecord(data[key]) && data[key].drawingId === key && data[key].unitId === space.unitId && data[key].subUnitId === space.subUnitId)
      && value.order.every(id => safeImageKey(id) && Object.hasOwn(data, id)) && new Set(value.order).size === value.order.length
  }
  if (!validSheet(first) || !validSheet(second) || first.order.length !== second.order.length || first.order.some((id, index) => id !== second.order[index]))
    return false
  // 纯删除/复制不会按旧 transform 的子字段拼写更新操作；合法默认字段差异不应阻止它们。
  if (!checkLayout)
    return true
  let count = 0
  const shape = (a: unknown, b: unknown, depth = 0): boolean => {
    if (++count > 100_000 || depth > 64)
      return false
    if (a === b)
      return true
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null)
      return typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b)
    if (Array.isArray(a) !== Array.isArray(b) || (Array.isArray(a) && Array.isArray(b) && a.length !== b.length))
      return false
    const entries: [string, unknown][] = Object.entries(a)
    const current = new Map<string, unknown>(Object.entries(b))
    return entries.length === current.size && entries.every(([key, value]) => current.has(key) && shape(value, current.get(key), depth + 1))
  }
  return shape(first.data, second.data)
}
