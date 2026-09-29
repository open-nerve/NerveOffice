import { z } from 'zod'
import { uuidSchema } from '../ids/ids.ts'
import { SPACE_TYPES } from '../spaces/spaces.ts'
import { codePointLength, hasControlCharacters } from '../text/text.ts'

/** 文档类型：M1 只有表格，M6 加上文字文档（doc）。新增取值时，同时用迁移更新 documents.type 的 CHECK 约束。 */
export const DOCUMENT_TYPES = ['sheet'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

/** 文档状态：M2 加上回收站。新增取值时，同时用迁移更新 documents.status 的 CHECK 约束。 */
export const DOCUMENT_STATUSES = ['active'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

/**
 * 插件档案（00 号计划书 §8.2）：一种文档类型固定使用的插件、注册顺序与影响数据的配置，标识带版本。
 * 新增取值时，同时用迁移更新 documents.profile 的 CHECK 约束；已有的档案不改内容，变更就发新版本。
 */
export const DOCUMENT_PROFILES = ['sheet@1'] as const
export type DocumentProfile = (typeof DOCUMENT_PROFILES)[number]

/** 新建各类型的文档时使用的档案。 */
export const DOCUMENT_PROFILE_OF: Readonly<Record<DocumentType, DocumentProfile>> = { sheet: 'sheet@1' }

/**
 * 平台格式版本（00 号计划书 §8.1）：本平台快照信封的格式，与 SDK 版本独立。
 * 新增取值时，同时用迁移更新 documents.format_version 的 CHECK 约束。
 */
export const PLATFORM_FORMAT_VERSIONS = [1] as const
export type PlatformFormatVersion = (typeof PLATFORM_FORMAT_VERSIONS)[number]

/** 新写入的文档使用的格式版本。 */
export const PLATFORM_FORMAT_VERSION: PlatformFormatVersion = 1

/** 标题的上限（字符数，按码点计）。 */
export const DOCUMENT_TITLE_MAX_LENGTH = 200

/** 新建时没有给标题，用这个。 */
export const DEFAULT_DOCUMENT_TITLES: Readonly<Record<DocumentType, string>> = { sheet: '未命名表格' }

/** 标题：去掉首尾空白之后 1–200 个字符，不含控制字符。 */
export const documentTitleSchema = z.string()
  .trim()
  .refine(value => codePointLength(value) >= 1 && codePointLength(value) <= DOCUMENT_TITLE_MAX_LENGTH, `标题为 1–${DOCUMENT_TITLE_MAX_LENGTH} 个字符`)
  .refine(value => !hasControlCharacters(value), '标题不能包含控制字符')

export const DOCUMENT_LIST_DEFAULT_LIMIT = 50
export const DOCUMENT_LIST_MAX_LIMIT = 100

/**
 * 列表的查询参数：按哪个空间列出、每页条数与上一页给出的游标（不透明的字符串）。
 * 没有 spaceId 时是本人的个人空间（M1 兼容，M2 总设计 §6.4）。
 */
export const documentListQuerySchema = z.strictObject({
  spaceId: uuidSchema.optional(),
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

/** 文档所在的空间：编辑器页的返回链接回到这里（M2-P2 设计 §3.10）。 */
export const documentSpaceSchema = z.object({
  id: z.uuid(),
  type: z.enum(SPACE_TYPES),
  name: z.string(),
})

export type DocumentSpace = z.infer<typeof documentSpaceSchema>

/**
 * 文档的元数据与调用者的权限（GET /api/documents/{id}，新建的响应）。
 * 档案与格式版本不按已知的取值校验：客户端自己核对，不认识的显示"格式不受支持"，而不是当作响应不合法（P4 设计 §3.7.1）。
 */
export const documentDetailSchema = documentSummarySchema.extend({
  spaceId: z.uuid(),
  space: documentSpaceSchema,
  /** 当前修订号：新建为 1，每次保存加一 */
  revision: z.number().int().min(1),
  profile: z.string().min(1),
  formatVersion: z.number().int().min(1),
  permissions: z.object({ canEdit: z.boolean() }),
})

export type DocumentDetail = z.infer<typeof documentDetailSchema>

/** 路径里的文档 id。 */
export const documentIdSchema = uuidSchema

/**
 * 新建文档（POST /api/documents）。requestId 由客户端为每一次新建生成：网络错误后用同一个 requestId 重试，
 * 服务端只建一份（P4 设计 §3.4）。spaceId 是建在哪个空间（M2-P2），没有时建在本人的个人空间（M1 兼容）。
 */
export const createDocumentRequestSchema = z.strictObject({
  type: z.enum(DOCUMENT_TYPES),
  title: documentTitleSchema.optional(),
  requestId: uuidSchema,
  spaceId: uuidSchema.optional(),
})

export type CreateDocumentRequest = z.input<typeof createDocumentRequestSchema>
