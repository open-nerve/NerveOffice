// 快照检查里服务端自己的规则（M3-P3 设计 §3.3，00 号计划书 §11.2）：与文档无关，只看快照本身，都是纯函数、不抛出。
// 资源的规则在 contracts 的 profile-resources.ts（checkResources），链接地址的判定在 link-address.ts（checkCellLinks），
// 平台图片地址在 asset-address.ts；这里是嵌套与数量、工作簿的结构、图片地址出现在哪里、链接出现在哪里。
// 规则按档案组织（PROFILE_SNAPSHOT_RULES）：结构与链接的位置随文档类型而变，M6 的 doc@1 加一项；嵌套、数量与图片地址不分档案。
// 嵌套与数量在解析之前按文字数（measureJsonText）：JSON.parse 本身不限层数，5 MiB 的 [[[…]]] 解析时 V8 的堆上约 150 MiB、
// 堆外再约 300 MiB（DEF-018 的测量），超过上限的文字根本不交给它。之后的遍历一律迭代
import type { CellLinkRule, DocumentProfile, RuleCheck } from '@nerve-office/contracts'
import { checkCellLinks, isPlatformAssetAddress, SNAPSHOT_MAX_DEPTH } from '@nerve-office/contracts'

/**
 * 元素数量的上限（对象的键加数组的项，外层与资源 data 里的 JSON 合计）：只挡最极端的形状。真实形状的 5 MiB 快照约 61 万个
 * （P3 设计前的探索 A §2.5），全是 0 的数组约 260 万、全是空对象的数组约 170 万；60 万个键的大对象挡不住，那要靠工作线程与并发的上限
 */
export const SNAPSHOT_MAX_ENTRIES = 1_500_000

/**
 * 资源 data 解析出的值嵌在快照里的深度：顶层（第 1 层）→ resources 数组（第 2 层）→ 一项资源 { name, data }（第 3 层）→ data 的位置（第 4 层）。
 * 嵌套按"外层与资源 data 里的 JSON 累加"计（P3 设计 §3.3）：data 里的 JSON 好比直接写在 data 的位置上
 */
export const RESOURCE_DATA_DEPTH = 4

/** JSON 的对象：不是 null、不是数组 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 嵌套与数量超出时的规则 */
export type JsonLimitRule = 'depth' | 'entries'

/** 一份快照里各段 JSON 文字合计的元素数（外层与资源 data 累加） */
export interface EntryCount {
  entries: number
}

const QUOTE = 0x22
const BACKSLASH = 0x5C
const COMMA = 0x2C
const OPEN_ARRAY = 0x5B
const CLOSE_ARRAY = 0x5D
const OPEN_OBJECT = 0x7B
const CLOSE_OBJECT = 0x7D

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D
}

/** from 起（跳过空白）紧接着就是右括号：刚打开的对象或数组是空的 */
function closesRightAway(text: string, from: number): boolean {
  for (let index = from; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (!isJsonWhitespace(code))
      return code === CLOSE_ARRAY || code === CLOSE_OBJECT
  }
  return true
}

/**
 * 解析之前按文字数一段 JSON 的嵌套与元素（不解析、不分配，任何文字都不抛出）：
 * - 嵌套：字符串之外的 [ 与 { 打开一层，] 与 } 关上一层；最外层的对象或数组在 depth 层（快照本身是 1，资源的 data 是 RESOURCE_DATA_DEPTH），
 *   任何一层超过 SNAPSHOT_MAX_DEPTH 就是 depth；
 * - 元素（对象的键加数组的项）：字符串之外的逗号各分出一个，每个不空的对象或数组再加一个；与解析之后数出的相同（重复的键多算，只会更严），
 *   累加到 count 上，合计超过 SNAPSHOT_MAX_ENTRIES 就是 entries。
 * 字符串里的引号与反斜杠按 JSON 的转义跳过。不是合法 JSON 的文字数出来的不作数：没超上限的照样交给 JSON.parse，由它报 json
 */
export function measureJsonText(text: string, depth: number, count: EntryCount): JsonLimitRule | undefined {
  let level = depth - 1
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (inString) {
      if (code === BACKSLASH)
        index += 1
      else if (code === QUOTE)
        inString = false
      continue
    }
    if (code === QUOTE) {
      inString = true
    }
    else if (code === OPEN_ARRAY || code === OPEN_OBJECT) {
      level += 1
      if (level > SNAPSHOT_MAX_DEPTH)
        return 'depth'
      if (!closesRightAway(text, index + 1))
        count.entries += 1
    }
    else if (code === CLOSE_ARRAY || code === CLOSE_OBJECT) {
      level -= 1
    }
    else if (code === COMMA) {
      count.entries += 1
    }
    if (count.entries > SNAPSHOT_MAX_ENTRIES)
      return 'entries'
  }
  return undefined
}

/**
 * 资源 data 里的 JSON：每项资源（resources 是数组、这一项是对象、data 是非空的字符串）先按文字数嵌套与元素（从 RESOURCE_DATA_DEPTH 起、
 * 与外层累加），没超出才解析；解析不了的不算在里面——资源的规则会拒绝它（resource-data），规范化也只解析能解析的。
 * 超出时给出规则，否则给出解析出的各个值
 */
export function embeddedJson(snapshot: unknown, count: EntryCount): JsonLimitRule | readonly unknown[] {
  const values: unknown[] = []
  const resources = isJsonObject(snapshot) ? snapshot.resources : undefined
  if (!Array.isArray(resources))
    return values
  for (const entry of resources as readonly unknown[]) {
    if (!isJsonObject(entry) || typeof entry.data !== 'string' || entry.data === '')
      continue
    const limit = measureJsonText(entry.data, RESOURCE_DATA_DEPTH, count)
    if (limit !== undefined)
      return limit
    try {
      values.push(JSON.parse(entry.data) as unknown)
    }
    catch {
      // 不是 JSON：留给资源的规则
    }
  }
  return values
}

/** 图片地址的规则（00 号计划书 §11.2）：名为 source 的字段只能是相对的平台图片地址（本站的绝对写法也不接受，M5 的粘贴清洗会改写） */
function isPlatformImage(value: unknown): boolean {
  return typeof value === 'string' && isPlatformAssetAddress(value, '')
}

/** 遍历的一层：一个对象（keys 是它的键）或一个数组（keys 为 undefined），接下来看第 index 项 */
interface Level {
  readonly node: object
  readonly keys: readonly string[] | undefined
  readonly length: number
  index: number
}

/**
 * 图片地址出现在哪里：任何深度上名为 source 的字段（单元格图片的 p.drawings、浮动图片的资源、工作表背景……都在其中），
 * 在快照本身与资源 data 解析出的每个值里找。有一个不是平台的图片地址就是 true。
 * 深度优先、迭代地走（栈的深度就是嵌套的层数，解析之前已经限制在 SNAPSHOT_MAX_DEPTH 之内）
 */
export function hasForeignImage(roots: readonly unknown[]): boolean {
  const stack: Level[] = []
  const enter = (value: unknown): void => {
    if (typeof value !== 'object' || value === null)
      return
    const keys = Array.isArray(value) ? undefined : Object.keys(value)
    stack.push({ node: value, keys, length: keys === undefined ? (value as readonly unknown[]).length : keys.length, index: 0 })
  }
  for (const root of roots) {
    enter(root)
    for (let level = stack.at(-1); level !== undefined; level = stack.at(-1)) {
      if (level.index >= level.length) {
        stack.pop()
        continue
      }
      const index = level.index
      level.index += 1
      if (level.keys === undefined) {
        enter((level.node as readonly unknown[])[index])
        continue
      }
      const key = level.keys[index] as string
      const child = (level.node as Record<string, unknown>)[key]
      if (key === 'source' && !isPlatformImage(child))
        return true
      enter(child)
    }
  }
  return false
}

/** 结构通过之后的快照：unitId，与链接扫描要走的部分 */
export interface CheckedStructure {
  readonly unitId: string
  readonly snapshot: Readonly<Record<string, unknown>>
}

/** 一个档案的结构与链接的位置（资源的规则按档案在 contracts 的 PROFILE_RESOURCES） */
export interface ProfileSnapshotRules {
  /** 结构：通过时给出 unitId 与快照，不通过时为 undefined（规则 structure） */
  readonly structure: (snapshot: unknown) => CheckedStructure | undefined
  /** 地址提取器的链接一半：扫描这类文档里每一处链接（规则 link-structure、link-address、link-range-id） */
  readonly links: (checked: CheckedStructure) => RuleCheck<CellLinkRule>
}

/**
 * 工作簿的结构（sheet@1）：顶层是对象、id 是非空的字符串；sheets 是对象、每个值都是对象；sheetOrder 是数组、每一项都是字符串并且是 sheets 的键。
 * 用 M0 的样本（spikes/m0 下 fixtures/sheet、e2e 结果里的 v03/s1 与 v16 的保存结果）、模板与只读样本核实过不会误拒（53 份工作簿）。
 * 不要求 sheets 里每张表都在 sheetOrder 里、不要求 sheetOrder 不重复、不要求 sheets[id].id 等于键：没有证据说 SDK 写出的快照都满足，
 * 误拒的代价是存不进去
 */
function workbookStructure(snapshot: unknown): CheckedStructure | undefined {
  if (!isJsonObject(snapshot))
    return undefined
  const { id, sheets, sheetOrder } = snapshot
  if (typeof id !== 'string' || id === '')
    return undefined
  if (!isJsonObject(sheets) || !Object.values(sheets).every(isJsonObject))
    return undefined
  if (!Array.isArray(sheetOrder) || !(sheetOrder as readonly unknown[]).every(sheetId => typeof sheetId === 'string' && Object.hasOwn(sheets, sheetId)))
    return undefined
  return { unitId: id, snapshot }
}

/** 对象或数组的每个值（SDK 按 matrix[row][col] 与 for…in 读单元格，数组的项同样读得到）；别的值没有 */
function valuesOf(value: unknown): readonly unknown[] {
  return typeof value === 'object' && value !== null ? Object.values(value) : []
}

const NO_LINK_VIOLATION: RuleCheck<CellLinkRule> = { ok: true }

/**
 * 工作簿里的链接（sheet@1）：表格的链接只在单元格的富文本里（cell.p.body.customRanges，00 号计划书 §11.2，M0-P2 报告 §2.3），
 * 逐张表（sheets 的每个值，不只 sheetOrder 里的）、逐行、逐个单元格交给 checkCellLinks。行与单元格的容器是对象还是数组都照读：
 * Univer 的 ObjectMatrix 按 matrix[row][col] 与 for…in 读，数组也读得到，扫描不能漏掉
 */
function workbookLinks(checked: CheckedStructure): RuleCheck<CellLinkRule> {
  for (const sheet of valuesOf(checked.snapshot.sheets)) {
    for (const row of valuesOf((sheet as Record<string, unknown>).cellData)) {
      for (const cell of valuesOf(row)) {
        if (!isJsonObject(cell))
          continue
        const check = checkCellLinks(cell.p)
        if (!check.ok)
          return check
      }
    }
  }
  return NO_LINK_VIOLATION
}

/** 各档案的结构与链接的规则 */
export const PROFILE_SNAPSHOT_RULES: Readonly<Record<DocumentProfile, ProfileSnapshotRules>> = {
  'sheet@1': { structure: workbookStructure, links: workbookLinks },
}
