import { z } from 'zod'

/** 文档类型：M1 只有表格，M6 加上文字文档（doc）。新增取值时，同时用迁移更新 documents.type 的 CHECK 约束。 */
export const DOCUMENT_TYPES = ['sheet'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

/** 文档状态：M2 加上回收站。新增取值时，同时用迁移更新 documents.status 的 CHECK 约束。 */
export const DOCUMENT_STATUSES = ['active'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

/** 标题的上限（字符数，按码点计）。 */
export const DOCUMENT_TITLE_MAX_LENGTH = 200

export const DOCUMENT_LIST_DEFAULT_LIMIT = 50
export const DOCUMENT_LIST_MAX_LIMIT = 100

/** 列表的查询参数：每页条数与上一页给出的游标（不透明的字符串）。 */
export const documentListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(DOCUMENT_LIST_MAX_LIMIT).default(DOCUMENT_LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(512).optional(),
})

export type DocumentListQuery = z.infer<typeof documentListQuerySchema>

/** 文档的摘要：列表的条目。时间是 ISO 8601 的 UTC（规范 §4）。响应的结构宽松，见 auth 的会话信息。 */
export const documentSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  type: z.enum(DOCUMENT_TYPES),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type DocumentSummary = z.infer<typeof documentSummarySchema>

/** 按更新时间从新到旧；还有下一页时给出游标。 */
export const documentListResponseSchema = z.object({
  items: z.array(documentSummarySchema),
  nextCursor: z.string().nullable(),
})

export type DocumentListResponse = z.infer<typeof documentListResponseSchema>

/** 文档的元数据与调用者的权限（GET /api/documents/{id}）。 */
export const documentDetailSchema = documentSummarySchema.extend({
  spaceId: z.uuid(),
  permissions: z.object({ canEdit: z.boolean() }),
})

export type DocumentDetail = z.infer<typeof documentDetailSchema>

/** 路径里的文档 id。 */
export const documentIdSchema = z.uuid()
