import type { ClearDocumentHistoryResponse, CreatedDocument, DocumentHistoryDetail, DocumentHistoryListResponse, RestoreDocumentHistoryRequest } from '@nerve-office/contracts'
import { clearDocumentHistoryResponseSchema, createdDocumentSchema, documentHistoryDetailSchema, documentHistoryListResponseSchema } from '@nerve-office/contracts'
import { apiFetch, apiRequest, ResponseFormatError } from './client.ts'

function historyPath(documentId: string): string {
  return `/api/documents/${documentId}/history`
}
export async function clearDocumentHistory(documentId: string): Promise<ClearDocumentHistoryResponse> {
  return apiRequest(historyPath(documentId), { method: 'DELETE', schema: clearDocumentHistoryResponseSchema })
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
/**
 * 历史正文收到了响应却读不出来（M5R-M-05）：浏览器在解 gzip 失败时这样报，按数据问题处理（预览显示“无法预览”）。
 * 读正文途中断网也表现为同样的 TypeError，无法区分；这种少见情况同样显示“无法预览”，刷新即可。
 * 取消与超时不受影响：请求时限先确定对外结果，再让正文流失败（request-deadline.ts）
 */
export class HistoryContentError extends Error {
  override readonly name = 'HistoryContentError'
}

export async function fetchHistoryContent(documentId: string, historyId: string, signal?: AbortSignal): Promise<string> {
  return apiFetch(`${historyPath(documentId)}/${historyId}/content`, { signal, cache: 'no-store' }, async (response) => {
    try {
      return await response.text()
    }
    catch (error) {
      throw new HistoryContentError('历史正文无法读出', { cause: error })
    }
  })
}
export async function restoreDocumentHistory(documentId: string, historyId: string, command: RestoreDocumentHistoryRequest): Promise<CreatedDocument> {
  return apiRequest(`${historyPath(documentId)}/${historyId}/restore`, { method: 'POST', body: command, schema: createdDocumentSchema })
}
