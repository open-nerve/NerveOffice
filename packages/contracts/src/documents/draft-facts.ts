import { z } from 'zod'
import { revisionSourceSchema } from './content.ts'
import { DOCUMENT_TYPES, documentIdSchema } from './documents.ts'

export const DRAFT_FACTS_MAX_IDS = 100

/** 原始项数先限量再去重；重复参数被 HTTP 解析成数组，不接受。 */
export const documentDraftFactsQuerySchema = z.strictObject({
  ids: z.string().max(DRAFT_FACTS_MAX_IDS * 37 - 1).transform(value => value.split(',')).pipe(z.array(documentIdSchema).min(1).max(DRAFT_FACTS_MAX_IDS)).transform(ids => [...new Set(ids)]),
})

export type DocumentDraftFactsQuery = z.infer<typeof documentDraftFactsQuerySchema>

/** 不可读项不给标题或修订；未知响应字段按既有契约丢弃。 */
export const documentDraftFactSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('accessible'),
    id: documentIdSchema,
    title: z.string(),
    type: z.enum(DOCUMENT_TYPES),
    canEdit: z.boolean(),
    revision: z.number().int().min(1),
    revisionSource: revisionSourceSchema.nullable(),
    occupied: z.boolean(),
  }),
  z.object({ status: z.literal('unavailable'), id: documentIdSchema }),
])

export type DocumentDraftFact = z.infer<typeof documentDraftFactSchema>

export const documentDraftFactsResponseSchema = z.object({
  items: z.array(documentDraftFactSchema).min(1).max(DRAFT_FACTS_MAX_IDS).refine(items => new Set(items.map(item => item.id)).size === items.length, '同一文档只能有一项事实'),
})

export type DocumentDraftFactsResponse = z.infer<typeof documentDraftFactsResponseSchema>
