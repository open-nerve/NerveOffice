// 插件档案的资源规则（00 号计划书 §8.2、§11.2，插件档案 v1 §3，M3-P3 设计 §3.2）：前后端共用的纯数据与纯函数，不依赖 Univer。
// - 白名单：档案注册的插件声明的资源。web 的档案（editor/profile/sheet-profile.ts）按这里的名称声明各组的资源，单元测试核对两边一致；
// - 必须为空：保护类（保护规则不是安全边界，界面也隐藏了解除入口）与区域主题（界面在没有注册的 sheets-table 里）；
// - 已知资源只核对最小的结构：data 是空串或 JSON、顶层是对象、每个键下的值是这类资源该有的种类（数组或对象）。种类出自各插件的
//   toJson 与 onLoad（refer/univer 1.0）：种类不对时 SDK 加载就出错（例如条件格式展开每个键下的规则表，筛选按对象反序列化）。
//   逐字段的结构不做：没有证据支撑时误拒的风险高（M0-P2 报告 §3，M3 总设计 §7）。
// "空"按深层为空判断：null、空串、空对象、空数组，或者每一层都为空——规则删光之后的区域保护是 { 工作表 id: [] }，不能误拒（M0 的 resource-guard）。
// 按档案组织：以后的 doc@1（M6）在 PROFILE_RESOURCES 里加一项
import type { DocumentProfile } from './documents.ts'
import type { SnapshotRule } from './snapshot-rules.ts'
import { compareCodeUnits, isEmptyLeaf, isJsonObject } from './json-values.ts'

/** 资源 data 解析后，顶层每个键下的值的种类 */
export type ResourceEntryKind = 'array' | 'object'

/** 一项资源的规则 */
export interface ResourceRule {
  /**
   * 顶层每个键下的值的种类。键多是工作表 id；定义名称的键是名称的 id，工作表保护与保护点的键是 unitId，
   * 区域主题的键是它的两张表（rangeThemeStyleRuleMap、rangeThemeStyleMapJson）
   */
  readonly entries: ResourceEntryKind
  /** 必须为空（深层为空） */
  readonly mustBeEmpty: boolean
}

/**
 * 各档案的资源白名单与规则（插件档案 v1 §3；sheet@1 自 M1-P4 起没有 SHEET_AuthzIoMockService_PLUGIN）。
 * 种类：条件格式、数据验证是 { 工作表 id: 规则[] }；定义名称是 { 名称 id: 名称 }；浮动图片是 { 工作表 id: { data, order } }；
 * 筛选是 { 工作表 id: 筛选 }；备注是 { 工作表 id: { 行: { 列: 备注 } } }；区域保护是 { 工作表 id: 规则[] }；
 * 工作表保护与保护点是 { unitId: 规则[] }；区域主题是 { rangeThemeStyleRuleMap: {…}, rangeThemeStyleMapJson: {…} }
 */
export const PROFILE_RESOURCES = {
  'sheet@1': {
    SHEET_CONDITIONAL_FORMATTING_PLUGIN: { entries: 'array', mustBeEmpty: false },
    SHEET_DATA_VALIDATION_PLUGIN: { entries: 'array', mustBeEmpty: false },
    SHEET_DEFINED_NAME_PLUGIN: { entries: 'object', mustBeEmpty: false },
    SHEET_DRAWING_PLUGIN: { entries: 'object', mustBeEmpty: false },
    SHEET_FILTER_PLUGIN: { entries: 'object', mustBeEmpty: false },
    SHEET_NOTE_PLUGIN: { entries: 'object', mustBeEmpty: false },
    SHEET_RANGE_PROTECTION_PLUGIN: { entries: 'array', mustBeEmpty: true },
    SHEET_WORKSHEET_PROTECTION_PLUGIN: { entries: 'array', mustBeEmpty: true },
    SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN: { entries: 'array', mustBeEmpty: true },
    SHEET_RANGE_THEME_MODEL_PLUGIN: { entries: 'object', mustBeEmpty: true },
  },
} as const satisfies Readonly<Record<DocumentProfile, Readonly<Record<string, ResourceRule>>>>

/** 档案 P 的资源名（白名单里的一项）：web 的档案按它声明各组的资源，写错名字类型检查就不通过 */
export type ProfileResourceName<P extends DocumentProfile> = Extract<keyof (typeof PROFILE_RESOURCES)[P], string>

/** 档案的资源白名单，按名称排序（UTF-16 码元的顺序） */
export function profileResourceNames(profile: DocumentProfile): string[] {
  return Object.keys(PROFILE_RESOURCES[profile]).sort(compareCodeUnits)
}

/**
 * 深层为空：null、空串、空数组、空对象，或者每一层都为空（例如 { "sheet-1": [] }、[{}, [null]]）。数字（包括 0）、布尔值
 * （包括 false）与非空的字符串都不为空。逐层迭代（不递归），任何深度都不会爆栈
 */
export function isDeepEmpty(value: unknown): boolean {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const item = pending.pop()
    if (isEmptyLeaf(item))
      continue
    if (typeof item !== 'object')
      return false
    for (const child of Array.isArray(item) ? item : Object.values(item as object))
      pending.push(child)
  }
  return true
}

/** checkResources 可能给出的规则 */
export type ResourceRuleId = Extract<SnapshotRule, 'resources' | 'resource-duplicate' | 'resource-unknown' | 'resource-data' | 'resource-not-empty'>

/**
 * 资源检查的结果。通过时给出这一版里在的资源名（present，不缩水按它核对）与其中非空的资源名（nonEmpty，随内容存下，下一次保存按它核对），
 * 都按名称排序；不通过时给出违反的规则与那一项资源的名称（日志用；resources 的结构不对时可能没有名称）
 */
export type ResourceCheck
  = | { readonly ok: true, readonly present: readonly string[], readonly nonEmpty: readonly string[] }
    | { readonly ok: false, readonly rule: ResourceRuleId, readonly resource?: string | undefined }

/** 资源的 data 解析一次：空串是空；其余必须是 JSON（解析不了是 undefined）。里面的字符串不再当 JSON 解析 */
function parseData(data: string): { readonly value: unknown } | undefined {
  if (data === '')
    return { value: '' }
  try {
    return { value: JSON.parse(data) as unknown }
  }
  catch {
    return undefined
  }
}

/** 已知资源的最小结构：空串，或者顶层是对象、每个键下的值是该有的种类 */
function hasResourceShape(value: unknown, kind: ResourceEntryKind): boolean {
  if (value === '')
    return true
  if (!isJsonObject(value))
    return false
  return Object.values(value).every(item => kind === 'array' ? Array.isArray(item) : isJsonObject(item))
}

/**
 * 按档案检查快照的 resources（00 号计划书 §11.2 的资源一条）：输入是解析之后的值（没有 resources 时传 undefined，按没有资源处理），
 * 任何输入都不抛出。按下面的先后，第一条不满足的就是结果：
 * 1. resources：是数组，每一项是对象、name 与 data 都是字符串（SDK 的 toJson 只写这两个；多出的键不看）；
 * 2. resource-duplicate：名称不重复（SDK 加载同名资源时只取第一条，重复的条目能让伪造的数据生效）；
 * 3. resource-unknown：名称在档案的白名单里；
 * 4. resource-data：data 是空串或 JSON，顶层是对象，每个键下的值是这类资源该有的种类；
 * 5. resource-not-empty：必须为空的资源深层为空。
 * 不缩水（上一版非空的资源这一版都在）要上一版，见 shrunkResources
 */
export function checkResources(resources: unknown, profile: DocumentProfile): ResourceCheck {
  if (resources === undefined)
    return { ok: true, present: [], nonEmpty: [] }
  if (!Array.isArray(resources))
    return { ok: false, rule: 'resources' }
  const entries: { readonly name: string, readonly data: string }[] = []
  for (const entry of resources as readonly unknown[]) {
    if (!isJsonObject(entry) || typeof entry.name !== 'string' || typeof entry.data !== 'string')
      return { ok: false, rule: 'resources', resource: isJsonObject(entry) && typeof entry.name === 'string' ? entry.name : undefined }
    entries.push({ name: entry.name, data: entry.data })
  }
  const seen = new Set<string>()
  for (const { name } of entries) {
    if (seen.has(name))
      return { ok: false, rule: 'resource-duplicate', resource: name }
    seen.add(name)
  }
  const rules: Readonly<Record<string, ResourceRule>> = PROFILE_RESOURCES[profile]
  const known: { readonly name: string, readonly data: string, readonly rule: ResourceRule }[] = []
  for (const { name, data } of entries) {
    const rule = Object.hasOwn(rules, name) ? rules[name] : undefined
    if (rule === undefined)
      return { ok: false, rule: 'resource-unknown', resource: name }
    known.push({ name, data, rule })
  }
  const parsed: { readonly name: string, readonly empty: boolean, readonly mustBeEmpty: boolean }[] = []
  for (const { name, data, rule } of known) {
    const value = parseData(data)
    if (value === undefined || !hasResourceShape(value.value, rule.entries))
      return { ok: false, rule: 'resource-data', resource: name }
    parsed.push({ name, empty: isDeepEmpty(value.value), mustBeEmpty: rule.mustBeEmpty })
  }
  for (const { name, empty, mustBeEmpty } of parsed) {
    if (mustBeEmpty && !empty)
      return { ok: false, rule: 'resource-not-empty', resource: name }
  }
  return {
    ok: true,
    present: parsed.map(item => item.name).sort(compareCodeUnits),
    nonEmpty: parsed.filter(item => !item.empty).map(item => item.name).sort(compareCodeUnits),
  }
}

/**
 * 不缩水（00 号计划书 §8.2，M3-P3 设计 §3.3）：上一版非空的资源里、在档案白名单之内的，这一版都要在（变空不算缩水：用户删光规则时
 * 资源合法地变空）。返回不在了的资源名（按名称排序），空数组表示没有缩水。白名单之外的（例如 M1-P4 去掉的 SHEET_AuthzIoMockService_PLUGIN）
 * 不算缩水：SDK 不再产生它，这一版没有它是对的
 */
export function shrunkResources(previousNonEmpty: readonly string[], present: readonly string[], profile: DocumentProfile): string[] {
  const rules: Readonly<Record<string, ResourceRule>> = PROFILE_RESOURCES[profile]
  const now = new Set(present)
  return [...new Set(previousNonEmpty)].filter(name => Object.hasOwn(rules, name) && !now.has(name)).sort(compareCodeUnits)
}
