// 快照检查里服务端自己的规则（M3-P3 设计 §3.3，00 号计划书 §11.2）：与文档无关，只看快照本身，都是纯函数、不抛出。
// 资源的规则在 contracts 的 profile-resources.ts（checkResources），链接地址的判定在 link-address.ts（checkCellLinks），
// 平台图片地址在 asset-address.ts；这里是嵌套与数量、工作簿的结构、图片地址出现在哪里、链接出现在哪里。
// 规则按档案组织（PROFILE_SNAPSHOT_RULES）：结构与链接的位置随文档类型而变，M6 的 doc@1 加一项；嵌套、数量与图片地址不分档案。
// 嵌套与数量在解析之前按文字数（measureJsonText）：JSON.parse 本身不限层数，5 MiB 的 [[[…]]] 解析时 V8 的堆上约 150 MiB、
// 堆外再约 300 MiB（DEF-018 的测量），超过上限的文字根本不交给它。之后的遍历一律迭代
import type { DocumentProfile, EntryCount, JsonLimitRule } from '@nerve-office/contracts'
import type { WorkbookLinkCheck } from './snapshot-link-check.ts'
import { measureJsonText, RESOURCE_DATA_DEPTH } from '@nerve-office/contracts'
import { checkWorkbookLinks } from './snapshot-link-check.ts'

export { hasForeignImage } from './snapshot-image-locations.ts'
// 保留已有服务端出口，所有调用者继续使用同一计量实现。
export { measureJsonText, RESOURCE_DATA_DEPTH, SNAPSHOT_MAX_ENTRIES } from '@nerve-office/contracts'

export type { EntryCount, JsonLimitRule } from '@nerve-office/contracts'

/** JSON 的对象：不是 null、不是数组 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 资源 data 里的 JSON：每项资源（resources 是数组、这一项是对象、data 是非空的字符串）先按文字数嵌套与元素（从 RESOURCE_DATA_DEPTH 起、
 * 与外层累加），没超出才解析；解析不了的不算在里面——资源的规则会拒绝它（resource-data），规范化也只解析能解析的。
 * 超出时给出规则，否则给出解析出的各个值
 */
export interface EmbeddedJson {
  readonly resourceIndex: number
  readonly value: unknown
}

export function embeddedJson(snapshot: unknown, count: EntryCount): JsonLimitRule | readonly EmbeddedJson[] {
  const values: EmbeddedJson[] = []
  const resources = isJsonObject(snapshot) ? snapshot.resources : undefined
  if (!Array.isArray(resources))
    return values
  for (const [resourceIndex, entry] of (resources as readonly unknown[]).entries()) {
    if (!isJsonObject(entry) || typeof entry.data !== 'string' || entry.data === '')
      continue
    const limit = measureJsonText(entry.data, RESOURCE_DATA_DEPTH, count)
    if (limit !== undefined)
      return limit
    try {
      values.push({ resourceIndex, value: JSON.parse(entry.data) as unknown })
    }
    catch {
      // 不是 JSON：留给资源的规则
    }
  }
  return values
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
  readonly links: (checked: CheckedStructure) => WorkbookLinkCheck
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

/** 各档案的结构与链接的规则 */
export const PROFILE_SNAPSHOT_RULES: Readonly<Record<DocumentProfile, ProfileSnapshotRules>> = {
  'sheet@1': { structure: workbookStructure, links: checked => checkWorkbookLinks(checked.snapshot) },
}
