import type { CreatedDocument, CreateDocumentRequest } from '@nerve-office/contracts'
import { createdDocumentSchema } from '@nerve-office/contracts'
import { apiRequest } from './client.ts'

/** 平台与 CSV 创建共用同一协议；窄模块不把平台列表、路由和查询组件带进编辑器入口。 */
export async function createDocument(request: CreateDocumentRequest): Promise<CreatedDocument> {
  return apiRequest('/api/documents', { method: 'POST', body: request, schema: createdDocumentSchema })
}
