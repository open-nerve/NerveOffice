import { isPlatformAssetAddress } from '@nerve-office/contracts'
import { normalizeImageFormula } from './image-formula-address.ts'

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

/** 自身数据属性，按 Reflect.ownKeys 的次序；键与值分列存放，大范围写入时不为每个属性另建元组。 */
interface DataEntries {
  readonly array: boolean
  readonly keys: readonly string[]
  readonly values: readonly unknown[]
}

/** 只读数据属性；不执行 getter、toJSON 或复制对象时的用户代码。 */
function dataEntries(value: object): DataEntries {
  const array = Array.isArray(value)
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && !(array && prototype === Array.prototype))
    reject('structure')
  const keys: string[] = []
  const values: unknown[] = []
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor')
      reject('structure')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor))
      reject('structure')
    if (array && key === 'length')
      continue
    keys.push(key)
    values.push(descriptor.value)
  }
  return { array, keys, values }
}

function dataMap(value: object): Map<string, unknown> {
  const { keys, values } = dataEntries(value)
  return new Map(keys.map((key, index) => [key, values[index]]))
}

function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/**
 * 按次序访问全部字段；发现后续坏字段时，原输入从未改变。没有字段改变时返回原对象，
 * 第一个改变出现时才建副本并补上之前的字段（M5R-I-01 的 CI 首轮：校验大范围写入时不为每个对象建映射数组）。
 */
function remap(value: object, entries: DataEntries, visit: Visitor): unknown {
  const { array, keys, values } = entries
  let copy: object | undefined
  let index = 0
  for (const key of keys) {
    const previous = values[index]
    const next = visit(previous, key)
    if (copy === undefined && next !== previous) {
      const created: unknown[] | Record<string, unknown> = array ? [] : {}
      if (Array.isArray(value) && Array.isArray(created))
        created.length = value.length
      keys.slice(0, index).forEach((earlierKey, earlier) => define(created, earlierKey, values[earlier]))
      copy = created
    }
    if (copy !== undefined)
      define(copy, key, next)
    index++
  }
  return copy ?? value
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
  // 当前路径上的祖先（深度不超过 64）；共享而非祖先的引用照常各访问一次
  const ancestors: object[] = []
  let count = 0
  const visit = (value: unknown, depth: number): unknown => {
    if (++count > IMAGE_FRAGMENT_LIMITS.entries || depth > IMAGE_FRAGMENT_LIMITS.depth)
      return reject('limit')
    // 这里处理 SDK 运行期片段；普通富文本的 pageSize 使用 Infinity 表示无限画布。
    // 数字不是图片来源，不在此改写布局值。source/cache 仍单独校验，JSON1 操作仍须纯 JSON。
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
      return value
    if (typeof value !== 'object' || ancestors.includes(value))
      return reject('structure')
    const entries = dataEntries(value)
    if (entries.keys.length + count > IMAGE_FRAGMENT_LIMITS.entries || (Array.isArray(value) && value.length > IMAGE_FRAGMENT_LIMITS.entries))
      return reject('limit')
    const source = entries.keys.indexOf('source')
    const cache = entries.keys.indexOf('base64Cache')
    if (source >= 0 && cache >= 0 && canonicalSource(entries.values[source], origin) !== canonicalSource(entries.values[cache], origin))
      return reject('source')
    ancestors.push(value)
    const next = remap(value, entries, (child, key) => key === 'source' || key === 'base64Cache' ? canonicalSource(child, origin) : visit(child, depth + 1))
    ancestors.pop()
    return next
  }
  return (value) => {
    count = 0
    ancestors.length = 0
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
      // IMAGE() 首参的本站绝对地址改为相对地址，服务端才建立引用（M5R-I-03）；不含本站地址的公式只做一次子串判断
      if (key === 'f' && typeof child === 'string')
        return normalizeImageFormula(child, origin)
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
    count += entries.keys.length
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
    if (entries.keys.length > IMAGE_FRAGMENT_LIMITS.cells)
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
    const old = dataMap(before)
    const current = dataMap(after)
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
