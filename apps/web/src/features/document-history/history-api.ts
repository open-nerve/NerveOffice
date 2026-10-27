import { infiniteQueryOptions } from '@tanstack/react-query'
import { fetchDocumentHistory } from '../../shared/api/document-history.ts'

export function historyQueryOptions(documentId: string) {
  return infiniteQueryOptions({
    queryKey: ['document-history', documentId],
    queryFn: async ({ pageParam, signal }) => fetchDocumentHistory(documentId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
  })
}
