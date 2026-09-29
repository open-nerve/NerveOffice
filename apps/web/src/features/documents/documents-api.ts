import type { CreateDocumentRequest, DocumentDetail, DocumentListResponse } from '@nerve-office/contracts'
import { documentDetailSchema, documentListResponseSchema } from '@nerve-office/contracts'
import { infiniteQueryOptions } from '@tanstack/react-query'
import { apiRequest } from '../../shared/api/index.ts'

export const DOCUMENTS_QUERY_KEY = ['documents'] as const

export async function fetchSpaceDocuments(spaceId: string, cursor: string | null, signal?: AbortSignal): Promise<DocumentListResponse> {
  const query = new URLSearchParams({ spaceId })
  if (cursor !== null)
    query.set('cursor', cursor)
  return apiRequest(`/api/documents?${query.toString()}`, { schema: documentListResponseSchema, signal })
}

/** 一个空间里的文档列表在请求缓存里的键：空间看不到了时，空间页连同它一起去掉（M2-P2 审查 B1） */
export function spaceDocumentsQueryKey(spaceId: string) {
  return [...DOCUMENTS_QUERY_KEY, 'space', spaceId] as const
}

/** 一个空间里的文档，按游标逐页加载（US-M1-03，M2-P2 设计 §3.5）。 */
export function spaceDocumentsQueryOptions(spaceId: string) {
  return infiniteQueryOptions({
    queryKey: spaceDocumentsQueryKey(spaceId),
    queryFn: async ({ pageParam, signal }) => fetchSpaceDocuments(spaceId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
  })
}

/** 新建文档（US-M1-04，M2-P2 设计 §3.6）：同一个 requestId 重试只建一份。 */
export async function createDocument(request: CreateDocumentRequest): Promise<DocumentDetail> {
  return apiRequest('/api/documents', { method: 'POST', body: request, schema: documentDetailSchema })
}
