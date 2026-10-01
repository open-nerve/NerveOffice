import type { CopyDocumentRequest, CreatedDocument, CreateDocumentRequest, DocumentDetail, DocumentListResponse, MoveDocumentRequest, UpdateDocumentRequest } from '@nerve-office/contracts'
import { createdDocumentSchema, documentDetailSchema, documentListResponseSchema } from '@nerve-office/contracts'
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { apiRequest } from '../../shared/api/index.ts'

export const DOCUMENTS_QUERY_KEY = ['documents'] as const

export async function fetchSpaceDocuments(spaceId: string, folderId: string | null, cursor: string | null, signal?: AbortSignal): Promise<DocumentListResponse> {
  const query = new URLSearchParams({ spaceId })
  // 省略 folderId 就是空间的根目录（契约 documentListQuerySchema）：根目录的地址因此与 M2-P4 之前一样
  if (folderId !== null)
    query.set('folderId', folderId)
  if (cursor !== null)
    query.set('cursor', cursor)
  return apiRequest(`/api/documents?${query.toString()}`, { schema: documentListResponseSchema, signal })
}

/** 一个空间里各层文档列表在请求缓存里的共同前缀：空间看不到了时，空间页连同它一起去掉（M2-P2 审查 B1） */
export function spaceDocumentsQueryKey(spaceId: string) {
  return [...DOCUMENTS_QUERY_KEY, 'space', spaceId] as const
}

/** 一个空间里某个文件夹的文档列表；folderId 为 null 表示空间的根目录 */
export function folderDocumentsQueryKey(spaceId: string, folderId: string | null) {
  return [...spaceDocumentsQueryKey(spaceId), folderId ?? 'root'] as const
}

/** 一个空间里某个文件夹的文档，按游标逐页加载（US-M1-03，M2-P2 设计 §3.5，M2-P4 按目录过滤）。 */
export function folderDocumentsQueryOptions(spaceId: string, folderId: string | null) {
  return infiniteQueryOptions({
    queryKey: folderDocumentsQueryKey(spaceId, folderId),
    queryFn: async ({ pageParam, signal }) => fetchSpaceDocuments(spaceId, folderId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
  })
}

/** 按 id 取的文档元数据在请求缓存里的共同前缀：整理之后按它整片作废（标题、所在文件夹都可能变了） */
export function documentDetailsQueryKey() {
  return [...DOCUMENTS_QUERY_KEY, 'detail'] as const
}

/**
 * 一份文档的元数据与我在它上面的权限（M2-P4 设计 §3.7）。
 * 列表的条目只有摘要（契约 documentSummarySchema，没有权限位），所以行内的"操作"展开时才按 id 取这一份：
 * 能做哪些操作一律以服务端给的 permissions 为准，界面不自己按角色推算；顺带也拿到它现在所在的文件夹（移动时要用）。
 */
export function documentQueryOptions(documentId: string) {
  return queryOptions({
    queryKey: [...documentDetailsQueryKey(), documentId],
    queryFn: async ({ signal }): Promise<DocumentDetail> => apiRequest(`/api/documents/${documentId}`, { schema: documentDetailSchema, signal }),
  })
}

/**
 * 新建文档（US-M1-04，M2-P2 设计 §3.6）：同一个 requestId 重试只建一份。
 * replayed 为真：同一个 requestId 的那一次之前已经建好了，这次给出的是那一份现在的样子（M2-P6 复核第二批 S-1）
 */
export async function createDocument(request: CreateDocumentRequest): Promise<CreatedDocument> {
  return apiRequest('/api/documents', { method: 'POST', body: request, schema: createdDocumentSchema })
}

/** 改名（US-M2-07）。改名与移动都不改更新时间，列表的排序不因整理而抖动（M2-P4 设计 §3.2）。 */
export async function updateDocument(documentId: string, request: UpdateDocumentRequest): Promise<DocumentDetail> {
  return apiRequest(`/api/documents/${documentId}`, { method: 'PATCH', body: request, schema: documentDetailSchema })
}

/**
 * 移动到某个空间的某个位置（US-M2-07）。目标就是现在所在的空间时，服务端按空间内移动处理，
 * 所以界面上"移动"只用这一个接口，不分空间内与跨空间（契约 moveDocumentRequestSchema）。
 */
export async function moveDocument(documentId: string, request: MoveDocumentRequest): Promise<DocumentDetail> {
  return apiRequest(`/api/documents/${documentId}/move`, { method: 'POST', body: request, schema: documentDetailSchema })
}

/**
 * 复制到某个空间的某个位置（US-M2-08）：同一个 requestId 重试只复制一份；标题默认是"源标题 的副本"。
 * replayed 为真：同一个 requestId 的那一次之前已经复制好了，这次给出的是那一份副本现在的样子（M2-P6 复核第二批 S-1）
 */
export async function copyDocument(documentId: string, request: CopyDocumentRequest): Promise<CreatedDocument> {
  return apiRequest(`/api/documents/${documentId}/copy`, { method: 'POST', body: request, schema: createdDocumentSchema })
}

/** 删除：进所在空间的回收站，没有响应体（US-M2-09）。 */
export async function deleteDocument(documentId: string): Promise<void> {
  await apiRequest(`/api/documents/${documentId}`, { method: 'DELETE', schema: z.undefined() })
}
