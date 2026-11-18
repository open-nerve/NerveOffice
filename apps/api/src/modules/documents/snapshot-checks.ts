// 快照检查里服务端自己的规则（M3-P3 设计 §3.3，00 号计划书 §11.2）：与文档无关，只看快照本身，都是纯函数、不抛出。
// 资源的规则在 contracts 的 profile-resources.ts（checkResources），链接地址的判定在 link-address.ts（checkCellLinks），
// 平台图片地址在 asset-address.ts；这里是嵌套与数量、工作簿的结构、图片地址出现在哪里、链接出现在哪里。
// 规则按档案组织（PROFILE_SNAPSHOT_RULES）：结构、档案自己的规则、图片与链接的位置、资源与正文的交叉核对随文档类型而变
// （doc@1 的在 snapshot-doc-rules.ts，M6-P1 S4）；嵌套、数量与图片地址的判定不分档案。
// 嵌套与数量在解析之前按文字数（measureJsonText）：JSON.parse 本身不限层数，5 MiB 的 [[[…]]] 解析时 V8 的堆上约 150 MiB、
// 堆外再约 300 MiB（DEF-018 的测量），超过上限的文字根本不交给它。之后的遍历一律迭代
import type { DocumentProfile, EntryCount, JsonLimitRule, RuleCheck, SnapshotImageLocation, SnapshotRule } from '@nerve-office/contracts'
import type { SnapshotLinkCheck } from './snapshot-link-check.ts'
import { measureJsonText, RESOURCE_DATA_DEPTH } from '@nerve-office/contracts'
import { checkDocContent, checkDocLinks, checkDocResources, docStructure } from './snapshot-doc-rules.ts'
import { docImageLocations, snapshotImageLocations } from './snapshot-image-locations.ts'
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

/** 档案自己的规则，排在结构之后、资源之前（SNAPSHOT_RULES 的先后）：文字文档的五条，表格没有 */
export type ProfileContentRule = Extract<SnapshotRule, 'doc-flavor' | 'doc-header-footer' | 'doc-notes' | 'doc-section-break' | 'doc-toc'>

/**
 * 一个档案的规则（资源的规则按档案在 contracts 的 PROFILE_RESOURCES）。整条检查按这个先后调用：structure → content → 资源 →
 * imageLocations → links → consistency（snapshot-inspection.ts）
 */
export interface ProfileSnapshotRules {
  /** 结构：通过时给出 unitId 与快照，不通过时为 undefined（规则 structure） */
  readonly structure: (snapshot: unknown) => CheckedStructure | undefined
  /** 档案自己的规则（ProfileContentRule），第一条不满足的就是结果 */
  readonly content: (checked: CheckedStructure) => RuleCheck<ProfileContentRule>
  /** 地址提取器的图片一半：任何深度上不是平台地址的 source 在哪里（规则 image-source），至多 SNAPSHOT_IMAGE_LOCATION_LIMIT 个 */
  readonly imageLocations: (checked: CheckedStructure, embedded: readonly EmbeddedJson[]) => readonly SnapshotImageLocation[]
  /** 地址提取器的链接一半：扫描这类文档里每一处链接（规则 link-structure、link-address、link-range-id） */
  readonly links: (checked: CheckedStructure) => SnapshotLinkCheck
  /** 资源与正文的交叉核对（规则 resource-mismatch）：资源已经通过资源的规则 */
  readonly consistency: (checked: CheckedStructure, embedded: readonly EmbeddedJson[]) => RuleCheck<'resource-mismatch'>
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

const PASS = { ok: true } as const

/** 各档案的规则：表格没有档案自己的规则与交叉核对；文字文档的见 snapshot-doc-rules.ts（M6-P1 S4） */
export const PROFILE_SNAPSHOT_RULES: Readonly<Record<DocumentProfile, ProfileSnapshotRules>> = {
  'sheet@1': {
    structure: workbookStructure,
    content: () => PASS,
    imageLocations: (checked, embedded) => snapshotImageLocations(checked.snapshot, embedded),
    links: checked => checkWorkbookLinks(checked.snapshot),
    consistency: () => PASS,
  },
  'doc@1': {
    structure: docStructure,
    content: checkDocContent,
    imageLocations: (checked, embedded) => docImageLocations(checked.snapshot, embedded),
    links: checkDocLinks,
    consistency: checkDocResources,
  },
}
