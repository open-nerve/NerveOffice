import { z } from 'zod'
import { uuidSchema } from '../ids/ids.ts'
import { userSummarySchema } from '../users/users.ts'
import { DOCUMENT_TYPES, documentTitleSchema } from './documents.ts'

/** 用户历史固定每页条数；运维检查点不使用这个公开接口。 */
export const HISTORY_PAGE_SIZE = 30
export const historyListQuerySchema = z.strictObject({ cursor: z.string().min(1).max(512).optional() })
export type HistoryListQuery = z.infer<typeof historyListQuerySchema>
export const documentHistoryIdSchema = uuidSchema

/** 格式不认识仍返回元数据，compatibility 只说明服务端格式支持，不保证正文通过完整性检查。 */
export const documentHistorySummarySchema = z.object({
  id: z.uuid(),
  revision: z.number().int().min(1),
  savedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  savedBy: userSummarySchema.nullable(),
  title: z.string(),
  type: z.enum(DOCUMENT_TYPES),
  profile: z.string(),
  formatVersion: z.number().int(),
  sdkVersion: z.string(),
  clientBuild: z.string().nullable(),
  formulasPending: z.boolean(),
  rawBytes: z.number().int().min(1),
  storedBytes: z.number().int().min(1),
  compatibility: z.enum(['supported', 'unsupported']),
})
export type DocumentHistorySummary = z.infer<typeof documentHistorySummarySchema>
export const documentHistoryDetailSchema = documentHistorySummarySchema
export type DocumentHistoryDetail = z.infer<typeof documentHistoryDetailSchema>
export const documentHistoryListResponseSchema = z.object({
  items: z.array(documentHistorySummarySchema),
  nextCursor: z.string().nullable(),
  canClearHistory: z.boolean(),
})
export type DocumentHistoryListResponse = z.infer<typeof documentHistoryListResponseSchema>

export const clearDocumentHistoryResponseSchema = z.object({ cleared: z.number().int().min(0) })
export type ClearDocumentHistoryResponse = z.infer<typeof clearDocumentHistoryResponseSchema>

export const restoreDocumentHistoryRequestSchema = z.strictObject({
  requestId: uuidSchema,
  spaceId: uuidSchema,
  folderId: uuidSchema.optional(),
  title: documentTitleSchema.optional(),
})
export type RestoreDocumentHistoryRequest = z.input<typeof restoreDocumentHistoryRequestSchema>
