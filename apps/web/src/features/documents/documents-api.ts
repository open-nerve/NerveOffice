import type { DocumentListResponse } from '@nerve-office/contracts'
import { documentListResponseSchema } from '@nerve-office/contracts'
import { infiniteQueryOptions } from '@tanstack/react-query'
import { apiRequest } from '../../shared/api/index.ts'

export const PERSONAL_DOCUMENTS_QUERY_KEY = ['documents', 'personal'] as const

export async function fetchPersonalDocuments(cursor: string | null, signal?: AbortSignal): Promise<DocumentListResponse> {
  const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`
  return apiRequest(`/api/documents${query}`, { schema: documentListResponseSchema, signal })
}

/** 个人空间的文档，按游标逐页加载（US-M1-03）。 */
export function personalDocumentsQueryOptions() {
  return infiniteQueryOptions({
    queryKey: PERSONAL_DOCUMENTS_QUERY_KEY,
    queryFn: async ({ pageParam, signal }) => fetchPersonalDocuments(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
  })
}
