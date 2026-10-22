import type { CreatedDocument, DocumentHistoryDetail, DocumentHistoryListResponse, RestoreDocumentHistoryRequest } from '@nerve-office/contracts'
import { createdDocumentSchema, documentHistoryDetailSchema, documentHistoryListResponseSchema } from '@nerve-office/contracts'
import { apiFetch, apiRequest, ResponseFormatError } from './client.ts'

function historyPath(documentId: string): string {
  return `/api/documents/${documentId}/history`
}
export async function fetchDocumentHistory(documentId: string, cursor: string | null, signal?: AbortSignal): Promise<DocumentHistoryListResponse> {
  const query = cursor === null ? '' : `?${new URLSearchParams({ cursor }).toString()}`
  return apiRequest(`${historyPath(documentId)}${query}`, { schema: documentHistoryListResponseSchema, signal })
}
export async function fetchHistoryDetail(documentId: string, historyId: string, signal?: AbortSignal): Promise<DocumentHistoryDetail> {
  const result = await apiRequest(`${historyPath(documentId)}/${historyId}`, { schema: documentHistoryDetailSchema, signal })
  if (result.id !== historyId)
    throw new ResponseFormatError('历史响应与请求的身份不符')
  return result
}
export async function fetchHistoryContent(documentId: string, historyId: string, signal?: AbortSignal): Promise<string> {
  return apiFetch(`${historyPath(documentId)}/${historyId}/content`, { signal, cache: 'no-store' }, async response => response.text())
}
export async function restoreDocumentHistory(documentId: string, historyId: string, command: RestoreDocumentHistoryRequest): Promise<CreatedDocument> {
  return apiRequest(`${historyPath(documentId)}/${historyId}/restore`, { method: 'POST', body: command, schema: createdDocumentSchema })
}
