// 规范化的内容（00 号计划书 §7.4 末与 §8.1，M3-P3 设计 §3.2；规格写进 ADR-011）：内容哈希与"内容相同不递增"的口径。
// 前后端共用，客户端在 M4 要逐字节复现，所以下面每一步都写死：
// 0. 以 JSON 文本为准：取值按 JSON.parse 的语义（数字按它解析、重复的键取后一个、__proto__ 是普通的键）；
// 1. 去掉每张工作表（sheets 的每个值）的视图状态 zoomRatio、scrollTop、scrollLeft：缩放与滚动不产生 mutation，随下一次真实的修改保存
//    （§7.3）；文字文档的 settings.zoomRatio 留给 M6；
// 2. 资源（resources；没有或为 null 时按空数组）：每项的 data 解析一次（只解析这一层，里面的字符串不再当 JSON；空串是空，解析不了的
//    原样当字符串）；深层为空的资源去掉——"在而为空"与"不在"等价（与 editor/testing/content-compare.ts 一致），"不在"的风险由不缩水兜住；
//    非空的、data 是对象时，**只在第一层**（每张表一个键的那一层）去掉取值深层为空的键：SDK 打开再保存时给每张表补上空的规则表
//    （{ "<表>": [] }，M0 的 S0 与 S1 唯一的差别就在这里，M0-P2 报告 §2.3）；更深的层级原样保留——那里的空串、空数组、空对象与 null
//    都算内容（M3-P3 审查 A5：例如筛选的"为空"条件 customFilters:[{val:""}] 与"按值筛选一个也没选" filters:{} 语义不同，
//    "内容相同"会让服务端不写入，把语义不同的判成相同就是静默丢掉修改）；data 是数组或别的值时原样保留；
//    按名称排序（UTF-16 码元的顺序，名称相同的保持原来的先后）；不是 { name: 字符串, data: 字符串 } 的项原样排在后面（服务端的检查先拒绝它们，
//    只为结果确定）；规范化之后每项是 { "data": 解析出的值, "name": 名称 }；
// 3. 写成 JSON，不带空白：对象的键序是"规范的数组下标形式的键（0 到 4294967294 的十进制写法，不带前导零）按数值升序在前，其余按 UTF-16 码元
//    的字典序"——M0 原型（Object.keys 排序之后经 Object.fromEntries 重建）实际得到的就是 JS 属性的这个顺序；字符串、数字与键按
//    JSON.stringify 写（-0 写成 0，孤立的代理项写成 \u 转义）。
// 内容哈希是这段文字的 UTF-8 字节（contentHashInput）的 SHA-256，各端用自己的实现（服务端 node:crypto，页面 crypto.subtle）
import { compareCodeUnits, isEmptyLeaf, isJsonObject } from './json-values.ts'

/** 工作表上的视图状态：不产生 mutation，不算内容（00 号计划书 §7.3） */
export const SHEET_VIEW_STATE_FIELDS: readonly string[] = ['zoomRatio', 'scrollTop', 'scrollLeft']

/** 规范的数组下标形式的键：0 到 4294967294（2³² − 2）的十进制写法，不带前导零 */
function isArrayIndex(key: string): boolean {
  return /^(?:0|[1-9]\d{0,9})$/.test(key) && Number(key) <= 4_294_967_294
}

/** 对象的键按规范的键序排好（见文件开头第 3 步） */
function canonicalKeys(object: Record<string, unknown>): string[] {
  const indices: string[] = []
  const names: string[] = []
  for (const key of Object.keys(object))
    (isArrayIndex(key) ? indices : names).push(key)
  indices.sort((a, b) => Number(a) - Number(b))
  names.sort(compareCodeUnits)
  return [...indices, ...names]
}

/** 不是对象或数组的值的写法：与 JSON.stringify 相同；JSON 里没有的值（undefined、函数、非有限的数）不在定义域里，写成 null */
function primitiveJson(value: unknown): string {
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
    return JSON.stringify(value)
  if (typeof value === 'boolean')
    return value ? 'true' : 'false'
  return 'null'
}

function isContainer(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function childrenOf(container: object): readonly unknown[] {
  return Array.isArray(container) ? container : Object.values(container)
}

/**
 * 每个对象与数组是否深层为空（与 profile-resources.ts 的 isDeepEmpty 同一个定义）：一遍迭代的后序遍历算完，
 * 判断整项资源与第一层的每个键时按它查，不必对每个键重新遍历子树
 */
function emptinessOf(root: unknown): ReadonlyMap<object, boolean> {
  const empty = new Map<object, boolean>()
  if (!isContainer(root))
    return empty
  const stack: { readonly node: object, expanded: boolean }[] = [{ node: root, expanded: false }]
  for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
    if (!top.expanded) {
      top.expanded = true
      for (const child of childrenOf(top.node)) {
        if (isContainer(child))
          stack.push({ node: child, expanded: false })
      }
      continue
    }
    stack.pop()
    empty.set(top.node, childrenOf(top.node).every(child => isEmptyIn(empty, child)))
  }
  return empty
}

/** value 深层为空（按 emptinessOf 算好的结果；叶子按 isEmptyLeaf） */
function isEmptyIn(emptiness: ReadonlyMap<object, boolean>, value: unknown): boolean {
  return isContainer(value) ? emptiness.get(value) === true : isEmptyLeaf(value)
}

/** 规范化之后的一项资源：写成 { "data": 第一层去掉空键的值, "name": 名称 } */
class CanonicalResource {
  readonly name: string
  readonly data: unknown

  constructor(name: string, data: unknown) {
    this.name = name
    this.data = data
  }
}

/** 资源的 data 解析一次：空串是空；解析不了的原样当字符串（服务端的检查先拒绝它） */
function resourceValue(data: string): unknown {
  if (data === '')
    return ''
  try {
    return JSON.parse(data) as unknown
  }
  catch {
    return data
  }
}

function canonicalResources(resources: unknown): unknown {
  if (resources === undefined || resources === null)
    return []
  if (!Array.isArray(resources))
    return resources
  const named: CanonicalResource[] = []
  const others: unknown[] = []
  for (const entry of resources as readonly unknown[]) {
    if (!isJsonObject(entry) || typeof entry.name !== 'string' || typeof entry.data !== 'string') {
      others.push(entry)
      continue
    }
    const value = resourceValue(entry.data)
    const emptiness = emptinessOf(value)
    if (!isEmptyIn(emptiness, value))
      named.push(new CanonicalResource(entry.name, withoutEmptyEntries(value, emptiness)))
  }
  named.sort((a, b) => compareCodeUnits(a.name, b.name))
  return [...named, ...others]
}

/**
 * 资源的 data 是对象时，去掉第一层取值深层为空的键（浅拷贝，见文件开头第 2 步）；更深的层级原样引用。不是对象时原样返回。
 * Object.fromEntries 按"定义自有属性"写，__proto__ 照样是普通的键
 */
function withoutEmptyEntries(value: unknown, emptiness: ReadonlyMap<object, boolean>): unknown {
  if (!isJsonObject(value))
    return value
  return Object.fromEntries(Object.keys(value).filter(key => !isEmptyIn(emptiness, value[key])).map(key => [key, value[key]]))
}

/** 对象去掉某几个键的浅拷贝（Object.fromEntries 按"定义自有属性"写，__proto__ 照样是普通的键） */
function without(object: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.keys(object).filter(key => !keys.includes(key)).map(key => [key, object[key]]))
}

/** 第 1、2 步：只浅拷贝顶层、sheets 与每张工作表，其余（单元格等）原样引用，不改传入的值 */
function normalized(snapshot: unknown): unknown {
  if (!isJsonObject(snapshot))
    return snapshot
  const entries = Object.keys(snapshot).map((key): [string, unknown] => {
    const value = snapshot[key]
    if (key === 'sheets' && isJsonObject(value))
      return [key, Object.fromEntries(Object.keys(value).map(id => [id, isJsonObject(value[id]) ? without(value[id], SHEET_VIEW_STATE_FIELDS) : value[id]]))]
    if (key === 'resources')
      return [key, canonicalResources(value)]
    return [key, value]
  })
  if (!Object.hasOwn(snapshot, 'resources'))
    entries.push(['resources', []])
  return Object.fromEntries(entries)
}

/** 写的时候还没处理的：一段现成的文字，或者一个值 */
type Pending = string | { readonly value: unknown }

/** 第 3 步：迭代地写（不递归，任何深度都不会爆栈；JSON.stringify 在几千层就抛 RangeError） */
function write(root: unknown): string {
  const out: string[] = []
  const pending: Pending[] = [{ value: root }]
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (typeof item === 'string') {
      out.push(item)
      continue
    }
    const { value } = item
    if (value instanceof CanonicalResource) {
      pending.push('}', { value: value.name }, ',"name":', { value: value.data })
      out.push('{"data":')
      continue
    }
    if (Array.isArray(value)) {
      out.push('[')
      pending.push(']')
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: (value as readonly unknown[])[index] })
        if (index > 0)
          pending.push(',')
      }
      continue
    }
    if (isJsonObject(value)) {
      const keys = canonicalKeys(value)
      out.push('{')
      pending.push('}')
      // 倒着压进待写的栈：先写的最后压；第一个键前面没有逗号
      for (const [index, key] of keys.toReversed().entries()) {
        pending.push({ value: value[key] }, `${JSON.stringify(key)}:`)
        if (index < keys.length - 1)
          pending.push(',')
      }
      continue
    }
    out.push(primitiveJson(value))
  }
  return out.join('')
}

/**
 * 规范化的内容（文件开头的第 1–3 步），输入是对快照的 JSON 文本 JSON.parse 的结果——服务端在检查时已经解析过，不必再解析一次。
 * 不要传内存里的模型（Univer 的 save() 的结果里有 Infinity、undefined，与写成 JSON 之后不同）。不改传入的值；
 * 任何 JSON 的值都不抛出（不是对象时原样写出）
 */
export function canonicalContentTextOf(snapshot: unknown): string {
  return write(normalized(snapshot))
}

/** 规范化的内容，输入是快照的 JSON 文本（不是合法的 JSON 时抛出 JSON.parse 的 SyntaxError：服务端先拒绝它，页面的快照来自 SDK） */
export function canonicalContentText(snapshotText: string): string {
  return canonicalContentTextOf(JSON.parse(snapshotText) as unknown)
}

/** 内容哈希的输入：规范文字的 UTF-8 字节（规范文字里没有孤立的代理项，编码是确定的）。哈希本身各端用自己的 SHA-256 */
export function contentHashInput(canonicalText: string): Uint8Array {
  return new TextEncoder().encode(canonicalText)
}
