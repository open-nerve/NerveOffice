// 单独分享的接口（M2-P5 设计 §3.2）：这份文档的授权列表、设置或调整、取消。设置与取消按状态幂等，不带 requestId
// （规范 §4 只要求新建与保存带）：结果未知之后再试是安全的，对话框按共用的做法刷新、说明。
import type { DocumentGrant, GrantRole } from '@nerve-office/contracts'
import { documentGrantListResponseSchema, documentGrantSchema } from '@nerve-office/contracts'
import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { apiRequest } from '../../shared/api/index.ts'

function grantsPath(documentId: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}/grants`
}

function grantPath(documentId: string, userId: string): string {
  return `${grantsPath(documentId)}/${encodeURIComponent(userId)}`
}

/** 一份文档的授权列表在请求缓存里的键：写操作之后按它刷新 */
export function grantsQueryKey(documentId: string) {
  return ['grants', documentId] as const
}

/** 这份文档的授权列表（要有分享的权限才看得到：没有时 403，看不到这份文档时 404） */
export function grantsQueryOptions(documentId: string) {
  return queryOptions({
    queryKey: grantsQueryKey(documentId),
    queryFn: async ({ signal }) => apiRequest(grantsPath(documentId), { schema: documentGrantListResponseSchema, signal }),
    select: response => response.items,
  })
}

/** 设置或调整（同样的角色什么都不写）：响应是这一条授权 */
export async function setGrant(documentId: string, userId: string, role: GrantRole): Promise<DocumentGrant> {
  return apiRequest(grantPath(documentId, userId), { method: 'PUT', body: { role }, schema: documentGrantSchema })
}

/** 取消（没有这条授权时照样成功）：没有响应体 */
export async function revokeGrant(documentId: string, userId: string): Promise<void> {
  await apiRequest(grantPath(documentId, userId), { method: 'DELETE', schema: z.undefined() })
}
