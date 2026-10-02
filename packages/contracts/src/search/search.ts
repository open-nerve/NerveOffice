import { z } from 'zod'
import { DOCUMENT_ACCESS_VIA, DOCUMENT_TITLE_MAX_LENGTH, documentSpaceSchema, documentSummarySchema } from '../documents/documents.ts'
import { FOLDER_MAX_DEPTH } from '../folders/folders.ts'
import { codePointLength } from '../text/text.ts'
import { userSummarySchema } from '../users/users.ts'

/** 搜索每页的条数（M2-P4 设计 §3.4 第 5 条）：固定大小，与列表一样是 keyset 分页。 */
export const SEARCH_PAGE_SIZE = 50

/**
 * 关键词：去掉首尾空白之后 1–DOCUMENT_TITLE_MAX_LENGTH 个字符（上限与标题一致，再长也不可能匹配到）。
 * 只有空白的关键词会搜出全部文档，所以在契约层就拒绝（400），不落到服务端。
 * 里面的 `\`、`%`、`_` 都当字面量，转义在服务端做（SQL 的 LIKE 是服务端的事，界面不必知道）。
 */
export const searchKeywordSchema = z.string()
  .trim()
  .refine(value => codePointLength(value) >= 1 && codePointLength(value) <= DOCUMENT_TITLE_MAX_LENGTH, `关键词为 1–${DOCUMENT_TITLE_MAX_LENGTH} 个字符`)

/**
 * 按标题搜索我能访问的文档（GET /api/search）：关键词与上一页给出的游标（不透明的字符串）。
 * 范围是"我能看到的空间"里正常状态的文档，不含回收站里的（M2-P4 设计 §3.5）；每页条数固定，不由客户端指定。
 */
export const searchQuerySchema = z.strictObject({
  query: searchKeywordSchema,
  cursor: z.string().min(1).max(512).optional(),
})

export type SearchQuery = z.infer<typeof searchQuerySchema>

/**
 * 搜索结果里文档所在的空间：文档详情的那三项（id、类型、名称），个人空间另带所有者（"人"的结构，M2-P5 设计 §3.2、§3.5）。
 * 有了单独授权，搜索结果里会出现别人的个人空间，不能再一律当成"我的空间"；个人空间存的名称是所有者建号时的显示名、可以伪造
 * （规范 §2.4），界面按所有者的人名呈现（人名组件），不显示存的名称。团队空间没有所有者。
 * 只做加法：名称照旧给出（与文档详情一致），旧页面照常工作
 */
export const searchSpaceSchema = z.discriminatedUnion('type', [
  documentSpaceSchema.extend({ type: z.literal('team') }),
  documentSpaceSchema.extend({ type: z.literal('personal'), owner: userSummarySchema }),
])

export type SearchSpace = z.infer<typeof searchSpaceSchema>

/**
 * 搜索结果的一条：文档的摘要，加上它在哪里——所在的空间，以及从空间根目录到它所在文件夹的名称。
 * 凭单独授权命中（accessVia 为 grant：我在那个空间里没有角色）的一条不给目录结构（M2-P5 设计 §3.4(2)）：
 * folderId 为 null，folderPath 是空数组。响应的结构宽松，见 auth 的会话信息。
 */
export const searchResultSchema = documentSummarySchema.extend({
  space: searchSpaceSchema,
  /** 所在的文件夹；在空间的根目录下、或者凭授权命中时为 null */
  folderId: z.uuid().nullable(),
  /**
   * 从空间的根目录到它所在文件夹的名称，按从浅到深的顺序；在空间的根目录下、或者凭授权命中时是空数组。
   * 最长 FOLDER_MAX_DEPTH 段（文件夹最多这么多层）
   */
  folderPath: z.array(z.string()).max(FOLDER_MAX_DEPTH),
  /** 看得到它的途径（与文档详情的 accessVia 相同） */
  accessVia: z.enum(DOCUMENT_ACCESS_VIA),
})

export type SearchResult = z.infer<typeof searchResultSchema>

/** 按更新时间从新到旧（不做相关度排序，M2-P4 设计 §3.4 第 5 条）；还有下一页时给出游标。 */
export const searchResponseSchema = z.object({
  items: z.array(searchResultSchema),
  nextCursor: z.string().nullable(),
})

export type SearchResponse = z.infer<typeof searchResponseSchema>
