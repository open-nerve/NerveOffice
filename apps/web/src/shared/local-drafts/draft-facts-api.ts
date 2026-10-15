import type { DocumentDraftFact } from '@nerve-office/contracts'
import { documentDraftFactsQuerySchema, documentDraftFactsResponseSchema, DRAFT_FACTS_MAX_IDS } from '@nerve-office/contracts'
import { apiRequest, ResponseFormatError } from '../api/index.ts'

/** 批量只读事实；少一条与无权不是一回事。长目录串行取，不并发占用服务端。 */
export async function readDraftFacts(ids: readonly string[]): Promise<ReadonlyMap<string, DocumentDraftFact>> {
  const unique = [...new Set(ids)]
  const facts = new Map<string, DocumentDraftFact>()
  for (let offset = 0; offset < unique.length; offset += DRAFT_FACTS_MAX_IDS) {
    const batch = unique.slice(offset, offset + DRAFT_FACTS_MAX_IDS)
    const input = documentDraftFactsQuerySchema.safeParse({ ids: batch.join(',') })
    if (!input.success)
      throw new ResponseFormatError('本机草稿的文档标识无法确认')
    const query = new URLSearchParams({ ids: input.data.ids.join(',') })
    const response = await apiRequest(`/api/documents/draft-facts?${query}`, { schema: documentDraftFactsResponseSchema })
    const received = new Map(response.items.map(item => [item.id, item]))
    if (received.size !== batch.length || batch.some(id => !received.has(id)))
      throw new ResponseFormatError('草稿文档事实的响应与查询不一致')
    for (const id of batch) {
      const fact = received.get(id)
      if (fact !== undefined)
        facts.set(id, fact)
    }
  }
  return facts
}
