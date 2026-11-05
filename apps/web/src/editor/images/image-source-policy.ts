import { isPlatformAssetAddress } from '@nerve-office/contracts'

export const IMAGE_FRAGMENT_LIMITS = { depth: 64, entries: 100_000, cells: 1_500_000 } as const

export type ImageSourceResult
  = | { readonly ok: true, readonly value: unknown, readonly changed: boolean }
    | { readonly ok: false, readonly reason: 'source' | 'structure' | 'limit' }

type FailureReason = Extract<ImageSourceResult, { ok: false }>['reason']
type Visitor = (value: unknown, key: string) => unknown

class RejectedImageFragment extends Error {
  readonly reason: FailureReason

  constructor(reason: FailureReason) {
    super('图片片段不能写入')
    this.reason = reason
  }
}

function reject(reason: FailureReason): never {
  throw new RejectedImageFragment(reason)
}

/** 只读数据属性；不执行 getter、toJSON 或复制对象时的用户代码。 */
function dataEntries(value: object): [string, unknown][] {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && !(Array.isArray(value) && prototype === Array.prototype))
    reject('structure')
  const entries: [string, unknown][] = []
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor')
      reject('structure')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor))
      reject('structure')
    if (Array.isArray(value) && key === 'length')
      continue
    entries.push([key, descriptor.value])
  }
  return entries
}

/** 先构造完整结果；发现后续坏字段时，原输入及之前的字段从未改变。 */
function remap(value: object, entries: readonly [string, unknown][], visit: Visitor): unknown {
  let changed = false
  const mapped = entries.map(([key, previous]): [string, unknown] => {
    const next = visit(previous, key)
    changed ||= next !== previous
    return [key, next]
  })
  if (!changed)
    return value
  const copy: object = Array.isArray(value) ? [] : {}
  if (Array.isArray(value) && Array.isArray(copy))
    copy.length = value.length
  for (const [key, next] of mapped)
    Object.defineProperty(copy, key, { value: next, enumerable: true, writable: true, configurable: true })
  return copy
}

function canonicalSource(value: unknown, origin: string): string {
  if (typeof value !== 'string' || !isPlatformAssetAddress(value, origin))
    return reject('source')
  return value.startsWith('/') ? value : value.slice(origin.length)
}

/**
 * 预算按顶层片段计：一次 normalizeImageFragment 的整个值共用一份预算，单元格与行列的每个 p/s 各自一份。
 * 预算只约束单个片段的规模与深度；整次写入的规模由 cells 上限约束。整次写入共用一份时，
 * 中等规模表上的撤销、加粗、边框与富文本结构命令会被整体取消（M5R-I-01）。
 */
function fragmentVisitor(origin: string): (value: unknown) => unknown {
  const ancestors = new WeakSet<object>()
  let count = 0
  const visit = (value: unknown, depth: number): unknown => {
    if (++count > IMAGE_FRAGMENT_LIMITS.entries || depth > IMAGE_FRAGMENT_LIMITS.depth)
      return reject('limit')
    // 这里处理 SDK 运行期片段；普通富文本的 pageSize 使用 Infinity 表示无限画布。
    // 数字不是图片来源，不在此改写布局值。source/cache 仍单独校验，JSON1 操作仍须纯 JSON。
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
      return value
    if (typeof value !== 'object' || ancestors.has(value))
      return reject('structure')
    const entries = dataEntries(value)
    if (entries.length + count > IMAGE_FRAGMENT_LIMITS.entries || (Array.isArray(value) && value.length > IMAGE_FRAGMENT_LIMITS.entries))
      return reject('limit')
    const source = entries.find(([key]) => key === 'source')
    const cache = entries.find(([key]) => key === 'base64Cache')
    if (source && cache && canonicalSource(source[1], origin) !== canonicalSource(cache[1], origin))
      return reject('source')
    ancestors.add(value)
    const next = remap(value, entries, (child, key) => key === 'source' || key === 'base64Cache' ? canonicalSource(child, origin) : visit(child, depth + 1))
    ancestors.delete(value)
    return next
  }
  return (value) => {
    count = 0
    return visit(value, 0)
  }
}

function checked(value: unknown, visit: (value: unknown) => unknown): ImageSourceResult {
  try {
    const next = visit(value)
    return { ok: true, value: next, changed: next !== value }
  }
  catch (error) {
    return { ok: false, reason: error instanceof RejectedImageFragment ? error.reason : 'structure' }
  }
}

export function normalizeImageFragment(value: unknown, origin: string): ImageSourceResult {
  return checked(value, fragmentVisitor(origin))
}

function cellVisitor(origin: string): (value: unknown) => unknown {
  const fragment = fragmentVisitor(origin)
  return (value) => {
    if (value === null || value === undefined)
      return value
    if (typeof value !== 'object' || Array.isArray(value))
      return reject('structure')
    return remap(value, dataEntries(value), (child, key) => {
      // null 是 SDK 撤销与清除为每格补的空位，不是片段，不进入预算
      if (child !== null && (key === 'p' || (key === 's' && typeof child === 'object')))
        return fragment(child)
      return child
    })
  }
}

export function normalizeImageCell(value: unknown, origin: string): ImageSourceResult {
  return checked(value, cellVisitor(origin))
}

export function normalizeImageCells(value: unknown, origin: string): ImageSourceResult {
  const cell = cellVisitor(origin)
  let count = 0
  const level = (input: unknown, visit: (child: unknown) => unknown): unknown => {
    if (input === null || input === undefined)
      return input
    if (typeof input !== 'object')
      return reject('structure')
    const entries = dataEntries(input)
    count += entries.length
    if (count > IMAGE_FRAGMENT_LIMITS.cells)
      return reject('limit')
    return remap(input, entries, visit)
  }
  return checked(value, input => level(input, row => level(row, cell)))
}

/** 行/列信息只有 s 是图片载体；长度、高度、普通元数据不作递归图片扫描。 */
export function normalizeImageAxis(value: unknown, origin: string): ImageSourceResult {
  const cell = cellVisitor(origin)
  return checked(value, (input) => {
    if (input === null || input === undefined)
      return input
    if (typeof input !== 'object')
      return reject('structure')
    const entries = dataEntries(input)
    if (entries.length > IMAGE_FRAGMENT_LIMITS.cells)
      return reject('limit')
    return remap(input, entries, cell)
  })
}

/** 插表、复制/恢复工作表的已知片段，不扫描普通单元格文字或 custom。 */
export function normalizeImageSheet(value: unknown, origin: string): ImageSourceResult {
  return checked(value, (input) => {
    if (input === undefined)
      return input
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      return reject('structure')
    return remap(input, dataEntries(input), (child, key) => {
      if (key === 'backgroundImage' && child != null)
        return reject('source')
      const result = key === 'cellData'
        ? normalizeImageCells(child, origin)
        : key === 'rowData' || key === 'columnData'
          ? normalizeImageAxis(child, origin)
          : key === 'defaultStyle' && typeof child === 'object'
            ? normalizeImageFragment(child, origin)
            : { ok: true as const, value: child }
      return result.ok ? result.value : reject(result.reason)
    })
  })
}

export type ImageTransitionResult = { readonly ok: true } | { readonly ok: false, readonly reason: FailureReason }

/** 只检查实际改变的分支。低层不能再归一，否则保存的逆操作与模型会不一致。拒绝时给出有界原因，供操作状态提示（M5R-M-10）。 */
export function imageTransition(previous: unknown, next: unknown, allowLegacyRemoval = false): ImageTransitionResult {
  let count = 0
  const settled = (value: unknown): void => {
    const result = normalizeImageFragment(value, '')
    if (!result.ok)
      reject(result.reason)
    if (result.changed)
      reject('source')
  }
  const visit = (before: unknown, after: unknown, depth: number): void => {
    if (before === after)
      return
    if (++count > IMAGE_FRAGMENT_LIMITS.entries || depth > IMAGE_FRAGMENT_LIMITS.depth)
      reject('limit')
    const beforeObject = typeof before === 'object' && before !== null
    const afterObject = typeof after === 'object' && after !== null
    if (!beforeObject || !afterObject) {
      settled(after)
      if (!allowLegacyRemoval)
        settled(before)
      return
    }
    const old = new Map(dataEntries(before))
    const current = new Map(dataEntries(after))
    for (const key of new Set([...old.keys(), ...current.keys()])) {
      const from = old.get(key)
      const to = current.get(key)
      if (from === to && old.has(key) === current.has(key))
        continue
      if (key === 'source' || key === 'base64Cache') {
        if ((current.has(key) && canonicalSource(to, '') !== to) || (!allowLegacyRemoval && old.has(key) && canonicalSource(from, '') !== from))
          reject('source')
        if (current.has('source') && current.has('base64Cache') && current.get('source') !== current.get('base64Cache'))
          reject('source')
      }
      else {
        visit(from, to, depth + 1)
      }
    }
  }
  try {
    visit(previous, next, 0)
    return { ok: true }
  }
  catch (error) {
    return { ok: false, reason: error instanceof RejectedImageFragment ? error.reason : 'structure' }
  }
}

export function acceptsImageTransition(previous: unknown, next: unknown, allowLegacyRemoval = false): boolean {
  return imageTransition(previous, next, allowLegacyRemoval).ok
}
