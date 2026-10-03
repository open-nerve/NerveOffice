// 编辑器页的接口（P4 设计 §3.3）：元数据、内容（快照的原文与修订号）与保存（gzip 压缩的快照）；
// 编辑租约（M3-P1 设计 §3.2、§3.4.7）：申请、心跳续租、释放，保存带上租约的令牌与代次。
import type { AcquiredEditLease, DocumentDetail, RenewedEditLease, SaveContentResponse } from '@nerve-office/contracts'
import type { SaveRequest } from './save-coordinator.ts'
import { acquiredEditLeaseSchema, documentDetailSchema, EDIT_LEASE_HEADER, renewedEditLeaseSchema, revisionFromEtag, saveContentResponseSchema, SNAPSHOT_UPLOAD_CONTENT_TYPE } from '@nerve-office/contracts'
import { apiFetch, apiRequest, readJson, ResponseFormatError } from '../../shared/api/index.ts'

/** 内容的原文（浏览器已按 Content-Encoding 解压）与它的修订号（ETag）：修订号是保存的基准。 */
export interface LoadedContent {
  readonly snapshot: string
  readonly revision: number
}

/** 保存带上的编辑租约：令牌经请求头、代次经查询参数（M3-P1 设计 §3.4.4），出自同一次申请 */
export interface LeaseCredentials {
  readonly token: string
  readonly writeEpoch: number
}

function documentPath(documentId: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}`
}

function leasePath(documentId: string): string {
  return `${documentPath(documentId)}/edit-lease`
}

/** 令牌只经请求头传递，不进地址（规范 §4） */
function leaseHeaders(token: string): Record<string, string> {
  return { [EDIT_LEASE_HEADER]: token }
}

export async function fetchDocument(documentId: string, signal?: AbortSignal): Promise<DocumentDetail> {
  return apiRequest(documentPath(documentId), { schema: documentDetailSchema, signal })
}

export async function fetchContent(documentId: string, signal?: AbortSignal): Promise<LoadedContent> {
  const path = `${documentPath(documentId)}/content`
  const response = await apiFetch(path, { signal })
  const revision = revisionFromEtag(response.headers.get('etag'))
  if (revision === undefined)
    throw new ResponseFormatError(`GET ${path} 的响应没有修订号（ETag）`)
  return { snapshot: await response.text(), revision }
}

/**
 * 快照压缩成 gzip（CompressionStream，主线程；5 MiB 时阻塞接近 100 ms，放进 Worker 是 M4 发件箱的设计）。
 * 全程在内存的字节上做，不经 Blob：WebKit 读取 Blob 要经它的网络进程（离线时读不出来，测试工具也看不到这样的请求体）。
 */
export async function gzipText(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new TextEncoder().encode(text)
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return new Uint8Array(await new Response(source.pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
}

export async function saveContent(documentId: string, request: SaveRequest, compressed: Uint8Array<ArrayBuffer>, lease: LeaseCredentials): Promise<SaveContentResponse> {
  const query = new URLSearchParams({
    baseRevision: String(request.baseRevision),
    requestId: request.requestId,
    clientInstanceId: request.clientInstanceId,
    localSeq: String(request.localSeq),
    writeEpoch: String(lease.writeEpoch),
  })
  const path = `${documentPath(documentId)}/content?${query.toString()}`
  const response = await apiFetch(path, { method: 'PUT', headers: leaseHeaders(lease.token), body: { contentType: SNAPSHOT_UPLOAD_CONTENT_TYPE, data: compressed } })
  return readJson(response, saveContentResponseSchema, `PUT ${documentPath(documentId)}/content`)
}

/** 申请编辑权（201）：clientInstanceId 是本页这次加载的标识，租约绑定它与这次登录。被占用时抛出 EDIT_LEASE_HELD（ApiError） */
export async function acquireEditLease(documentId: string, clientInstanceId: string): Promise<AcquiredEditLease> {
  return apiRequest(leasePath(documentId), { method: 'POST', body: { clientInstanceId }, schema: acquiredEditLeaseSchema })
}

/** 心跳续租（200）：带上距离本页最后一次键盘、鼠标操作的秒数。租约不再有效时抛出 EDIT_LEASE_LOST（ApiError） */
export async function renewEditLease(documentId: string, token: string, idleSeconds: number): Promise<RenewedEditLease> {
  return apiRequest(leasePath(documentId), { method: 'PUT', body: { idleSeconds }, headers: leaseHeaders(token), schema: renewedEditLeaseSchema })
}

/**
 * 尽力释放编辑权（204）：页面隐藏、关闭时也要发出去，用 keepalive；结果不管——没送到时由服务端按到期回收（P1 设计 §3.4.3）。
 * 请求层照常带上 CSRF 令牌（状态变更的请求）。兑现于请求有了结果（成功、失败都算），从不失败：续上时等它放掉再申请
 */
export async function releaseEditLease(documentId: string, token: string): Promise<void> {
  await apiFetch(leasePath(documentId), { method: 'DELETE', headers: leaseHeaders(token), keepalive: true }).then(() => undefined, () => undefined)
}
