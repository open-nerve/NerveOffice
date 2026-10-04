// 快照检查的规则标识（M3-P3 设计 §3.3）：服务端拒绝一份快照（SNAPSHOT_INVALID）时只给出违反的那一条规则的标识，
// 不回显快照的内容（§3.12）；日志记规则与文档 id。页面按规则给出说法（例如链接的几条都说"表格里有不能保存的链接"），
// 不认识的规则照"格式不正确"说。规则的判定：资源在 profile-resources.ts，链接在 link-address.ts，图片地址在 asset-address.ts，
// 其余（正文、嵌套与数量、工作簿的结构、unitId、不缩水）在服务端的快照检查里
import { z } from 'zod'

/**
 * 规则的标识（按检查的先后列出）：
 * - encoding：不是 UTF-8 的文本；json：不是合法的 JSON；
 * - depth：嵌套超过上限（外层与资源 data 里的 JSON 累加）；entries：元素数量超过上限；too-complex：检查用的内存超过上限；
 * - structure：工作簿的结构（顶层是对象、id 是非空字符串、sheetOrder 是字符串数组且每一项都是 sheets 的键、sheets 的值是对象）；
 * - resources：resources 不是数组，或者某一项不是 { name, data }（两个都是字符串）；resource-duplicate：资源名重复；
 *   resource-unknown：资源名不在插件档案的白名单里；resource-data：已知资源的最小结构（data 是空串或 JSON、顶层是对象、
 *   每个键下的值是这类资源该有的种类）；resource-not-empty：必须为空的资源不为空；
 * - image-source：任何深度上名为 source 的字段不是平台的图片地址；
 * - link-structure：单元格的链接区间看不懂（不是数组、某一项不是对象、链接没有字符串的地址）；link-address：链接地址不合法，
 *   或者不是它的规范写法；link-range-id：链接区间的 rangeId 不合写法；
 * - unit-id：快照的 unitId 不是这份文档的；resource-missing：上一版非空的资源这一版不在了（不缩水）。这两条与文档有关，在事务里判断
 */
export const SNAPSHOT_RULES = [
  'encoding',
  'json',
  'depth',
  'entries',
  'too-complex',
  'structure',
  'resources',
  'resource-duplicate',
  'resource-unknown',
  'resource-data',
  'resource-not-empty',
  'image-source',
  'link-structure',
  'link-address',
  'link-range-id',
  'unit-id',
  'resource-missing',
] as const
export type SnapshotRule = (typeof SNAPSHOT_RULES)[number]

/**
 * SNAPSHOT_INVALID 的详情：违反的规则。以后的 Phase 会加规则（M6 的文字文档），而响应的结构是宽松的（请求严格、响应宽松，架构总览 §3）：
 * 不认识的规则（以及缺少规则）解析成 undefined，不让整个解析失败，页面按通用的"格式不正确"处理
 */
export const snapshotInvalidDetailsSchema = z.object({
  rule: z.enum(SNAPSHOT_RULES).optional().catch(undefined),
})

export type SnapshotInvalidDetails = z.infer<typeof snapshotInvalidDetailsSchema>

/** 一条检查的结果：通过，或者违反的规则（R 是这条检查可能给出的规则） */
export type RuleCheck<R extends SnapshotRule> = { readonly ok: true } | { readonly ok: false, readonly rule: R }
