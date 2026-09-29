import { z } from 'zod'
import { DOCUMENT_TITLE_MAX_LENGTH, documentSpaceSchema, documentSummarySchema } from '../documents/documents.ts'
import { FOLDER_MAX_DEPTH } from '../folders/folders.ts'
import { codePointLength } from '../text/text.ts'

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
 * 搜索结果的一条：文档的摘要，加上它在哪里——所在的空间，以及从空间根目录到它所在文件夹的名称。
 * 响应的结构宽松，见 auth 的会话信息。
 */
export const searchResultSchema = documentSummarySchema.extend({
  space: documentSpaceSchema,
  /** 所在的文件夹；在空间的根目录下时为 null */
  folderId: z.uuid().nullable(),
  /**
   * 从空间的根目录到它所在文件夹的名称，按从浅到深的顺序；在空间的根目录下时是空数组。
   * 最长 FOLDER_MAX_DEPTH 段（文件夹最多这么多层）
   */
  folderPath: z.array(z.string()).max(FOLDER_MAX_DEPTH),
})

export type SearchResult = z.infer<typeof searchResultSchema>

/** 按更新时间从新到旧（不做相关度排序，M2-P4 设计 §3.4 第 5 条）；还有下一页时给出游标。 */
export const searchResponseSchema = z.object({
  items: z.array(searchResultSchema),
  nextCursor: z.string().nullable(),
})

export type SearchResponse = z.infer<typeof searchResponseSchema>
