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
 * 历史正文连续两次收到了响应却读不出来（M5R-M-05）：按数据问题处理（预览显示“无法预览”，终态）。
 * 浏览器解 gzip 失败与读正文途中断网都表现为读正文时的 TypeError，单次分不清，所以 fetchHistoryContent 先完整重读一次
 * （S14 审查 FE3）：断网仍在时重读的请求本身失败，归为网络错误（预览会自动重试）；网络已恢复则照常读出。
 * 取消与超时不受影响：请求时限先确定对外结果，再让正文流失败（request-deadline.ts），不会走到重读
 */
export class HistoryContentError extends Error {
  override readonly name = 'HistoryContentError'
}

async function readHistoryContent(documentId: string, historyId: string, signal: AbortSignal | undefined): Promise<string> {
  return apiFetch(`${historyPath(documentId)}/${historyId}/content`, { signal, cache: 'no-store' }, async (response) => {
    try {
      return await response.text()
    }
    catch (error) {
      throw new HistoryContentError('历史正文无法读出', { cause: error })
    }
  })
}

export async function fetchHistoryContent(documentId: string, historyId: string, signal?: AbortSignal): Promise<string> {
  try {
    return await readHistoryContent(documentId, historyId, signal)
  }
  catch (error) {
    if (!(error instanceof HistoryContentError))
      throw error
    return readHistoryContent(documentId, historyId, signal)
  }
}
export async function restoreDocumentHistory(documentId: string, historyId: string, command: RestoreDocumentHistoryRequest): Promise<CreatedDocument> {
  return apiRequest(`${historyPath(documentId)}/${historyId}/restore`, { method: 'POST', body: command, schema: createdDocumentSchema })
}
