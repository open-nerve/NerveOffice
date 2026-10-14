// 草稿目录与编辑器共用的内容传输；不申请编辑权，不重写原请求的身份、格式或字节。
import type { CreatedDocument, SaveContentResponse } from '@nerve-office/contracts'
import type { ConflictCopyRequest } from './lost-copy.ts'
import type { SaveRequest } from './save-request.ts'
import { createdDocumentSchema, EDIT_LEASE_HEADER, saveContentResponseSchema, SNAPSHOT_UPLOAD_CONTENT_TYPE } from '@nerve-office/contracts'
import { clientFormatParams } from '../api/client-format.ts'
import { apiFetch, readJson } from '../api/index.ts'

const SNAPSHOT_REQUEST_TIMEOUT_MS = 60_000

function documentPath(documentId: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}`
}

function contentPath(documentId: string): string {
  return `${documentPath(documentId)}/content`
}

function leaseHeaders(token: string): Record<string, string> {
  return { [EDIT_LEASE_HEADER]: token }
}

/** 保存带上的编辑租约：令牌经请求头、代次经查询参数（M3-P1 设计 §3.4.4），出自同一次申请 */
export interface LeaseCredentials {
  readonly token: string
  readonly writeEpoch: number
}

/**
 * 另存为副本（M3-P2 设计 §3.2）：上传本页捕获的快照（gzip，与保存同一个读取方式），服务端按它新建一份文档，给出新文档的详情
 * （与复制相同，带 replayed）。requestId 做幂等：结果未知之后用同一个重试只建一份。带上"公式待更新"与本页的构建与数据格式（M3-P3）
 */
export async function saveConflictCopy(documentId: string, query: ConflictCopyRequest, compressed: Uint8Array<ArrayBuffer>): Promise<CreatedDocument> {
  const search = new URLSearchParams({ requestId: query.requestId, title: query.title, formulasPending: String(query.formulasPending === true), ...clientFormatParams(query.format) })
  const path = `${documentPath(documentId)}/conflict-copies?${search.toString()}`
  return apiFetch(path, { timeoutMs: SNAPSHOT_REQUEST_TIMEOUT_MS, method: 'POST', body: { contentType: SNAPSHOT_UPLOAD_CONTENT_TYPE, data: compressed } }, async response => readJson(response, createdDocumentSchema, `POST ${documentPath(documentId)}/conflict-copies`))
}

/** 保存（带上编辑租约的代次与令牌、"公式待更新"、本页的构建与数据格式）：内容与当前相同时服务端回答 unchanged，照"已保存"处理 */
export async function saveContent(documentId: string, request: SaveRequest, compressed: Uint8Array<ArrayBuffer>, lease: LeaseCredentials): Promise<SaveContentResponse> {
  return putContent(documentId, request, compressed, lease.writeEpoch, lease.token)
}

/**
 * 恢复时只核对旧保存的回执（M4-P3）：原身份、代次、字节、基准、格式与公式标记不改，但不带租约令牌。
 * 服务端重放先于租约校验，已提交且仍可访问时返回原结果；未提交则不能借当前租约变成新保存。
 * 失败照原请求层抛出，网络/超时仍是未知结果；这里不申请租约、不换请求或隐式重试。
 */
export async function replayContent(documentId: string, request: SaveRequest, compressed: Uint8Array<ArrayBuffer>, writeEpoch: number): Promise<SaveContentResponse> {
  return putContent(documentId, request, compressed, writeEpoch)
}

async function putContent(documentId: string, request: SaveRequest, compressed: Uint8Array<ArrayBuffer>, writeEpoch: number, token?: string): Promise<SaveContentResponse> {
  const query = new URLSearchParams({
    baseRevision: String(request.baseRevision),
    requestId: request.requestId,
    clientInstanceId: request.clientInstanceId,
    localSeq: String(request.localSeq),
    writeEpoch: String(writeEpoch),
    formulasPending: String(request.formulasPending),
    ...clientFormatParams(request.format),
  })
  const path = `${contentPath(documentId)}?${query.toString()}`
  return apiFetch(path, { timeoutMs: SNAPSHOT_REQUEST_TIMEOUT_MS, method: 'PUT', headers: token === undefined ? {} : leaseHeaders(token), body: { contentType: SNAPSHOT_UPLOAD_CONTENT_TYPE, data: compressed } }, async response => readJson(response, saveContentResponseSchema, `PUT ${contentPath(documentId)}`))
}
