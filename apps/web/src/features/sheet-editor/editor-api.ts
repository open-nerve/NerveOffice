// 编辑器页的接口（P4 设计 §3.3）：元数据、内容（快照的原文与修订号）与保存（gzip 压缩的快照）；
// 编辑租约（M3-P1 设计 §3.2、§3.4.7）：申请、心跳续租、释放，保存带上租约的令牌与代次；
// 阅读模式（M3-P2 设计 §3.2）：内容的条件读取（If-None-Match，没有变化时 304）、编辑状态（阅读页每 30 秒一次）、另存为副本；
// 保存协议（M3-P3 设计 §3.5、§3.8）：保存、另存为副本、申请编辑权与心跳都带上本页的构建与数据格式（client-format.ts），
// 保存与另存为副本另带"公式待更新"。打开自检（M3-P4 设计 §3.13）：失败的上报。
import type { AcquiredEditLease, ConflictCopyQuery, CreatedDocument, DocumentDetail, EditStatus, OpenCheckReport, RenewedEditLease, SaveContentResponse } from '@nerve-office/contracts'
import type { SaveRequest } from './save-coordinator.ts'
import { acquiredEditLeaseSchema, createdDocumentSchema, documentDetailSchema, EDIT_LEASE_HEADER, editStatusSchema, renewedEditLeaseSchema, revisionEtag, revisionFromEtag, saveContentResponseSchema, SNAPSHOT_UPLOAD_CONTENT_TYPE } from '@nerve-office/contracts'
import { apiFetch, apiRequest, readJson, ResponseFormatError, serverTimeOf } from '../../shared/api/index.ts'
import { clientFormatParams, PAGE_CLIENT_FORMAT } from './client-format.ts'

/** 内容的原文（浏览器已按 Content-Encoding 解压）与它的修订号（ETag）：修订号是保存的基准。 */
export interface LoadedContent {
  readonly snapshot: string
  readonly revision: number
}

/** 条件读取时服务端的修订号还是给出的那一个（304）：本页手里的就是最新的 */
export const CONTENT_UNCHANGED = 'unchanged'

/** 编辑状态与服务端回答的时刻（响应头 Date：最后活动几分钟之前按它算，不拿浏览器的时钟去比） */
export interface FetchedEditStatus {
  readonly status: EditStatus
  readonly serverTime: number | undefined
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

function contentPath(documentId: string): string {
  return `${documentPath(documentId)}/content`
}

/** 读出内容的原文与修订号（ETag）；没有修订号时 ResponseFormatError */
async function loadedFrom(response: Response, documentId: string): Promise<LoadedContent> {
  const revision = revisionFromEtag(response.headers.get('etag'))
  if (revision === undefined)
    throw new ResponseFormatError(`GET ${contentPath(documentId)} 的响应没有修订号（ETag）`)
  return { snapshot: await response.text(), revision }
}

/** 读内容的全文（打开、放弃本页的修改时） */
export async function fetchContent(documentId: string): Promise<LoadedContent> {
  return loadedFrom(await apiFetch(contentPath(documentId)), documentId)
}

/**
 * 条件读取（If-None-Match，M3-P2 设计 §3.2）：本页手里的是 revision 这一版，服务端的修订号还是它就回 304，这里给出 CONTENT_UNCHANGED，
 * 不传内容；有更新的才读全文。权限照常判断（看不到与不存在一致，404）。阅读者的"有更新"、进入编辑时修订号变了都用它
 */
export async function fetchContentIfChanged(documentId: string, revision: number): Promise<LoadedContent | typeof CONTENT_UNCHANGED> {
  const response = await apiFetch(contentPath(documentId), { headers: { 'if-none-match': revisionEtag(revision) }, acceptNotModified: true })
  return response.status === 304 ? CONTENT_UNCHANGED : loadedFrom(response, documentId)
}

/** 编辑状态（GET，能读就能看）：修订号、正在编辑的人与调用者现在能不能编辑，连同服务端回答的时刻 */
export async function fetchEditStatus(documentId: string): Promise<FetchedEditStatus> {
  const response = await apiFetch(leasePath(documentId))
  return { status: await readJson(response, editStatusSchema, `GET ${leasePath(documentId)}`), serverTime: serverTimeOf(response) }
}

/**
 * 另存为副本（M3-P2 设计 §3.2）：上传本页捕获的快照（gzip，与保存同一个读取方式），服务端按它新建一份文档，给出新文档的详情
 * （与复制相同，带 replayed）。requestId 做幂等：结果未知之后用同一个重试只建一份。带上"公式待更新"与本页的构建与数据格式（M3-P3）
 */
export async function saveConflictCopy(documentId: string, query: ConflictCopyQuery, compressed: Uint8Array<ArrayBuffer>): Promise<CreatedDocument> {
  const search = new URLSearchParams({ requestId: query.requestId, title: query.title, formulasPending: String(query.formulasPending === true), ...clientFormatParams() })
  const path = `${documentPath(documentId)}/conflict-copies?${search.toString()}`
  const response = await apiFetch(path, { method: 'POST', body: { contentType: SNAPSHOT_UPLOAD_CONTENT_TYPE, data: compressed } })
  return readJson(response, createdDocumentSchema, `POST ${documentPath(documentId)}/conflict-copies`)
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

/**
 * 快照 UTF-8 字节的 SHA-256（十六进制）：自动保存会话内去重的键（M3-P4 设计 §3.7）。不用弱哈希——碰撞会让改过的内容不上传，就是丢数据。
 * crypto.subtle 只在安全上下文里有（HTTPS 与本机地址）；没有时抛出，自动保存这一次不去重（照常上传）
 */
export async function snapshotDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** 保存（带上编辑租约的代次与令牌、"公式待更新"、本页的构建与数据格式）：内容与当前相同时服务端回答 unchanged，照"已保存"处理 */
export async function saveContent(documentId: string, request: SaveRequest, compressed: Uint8Array<ArrayBuffer>, lease: LeaseCredentials): Promise<SaveContentResponse> {
  const query = new URLSearchParams({
    baseRevision: String(request.baseRevision),
    requestId: request.requestId,
    clientInstanceId: request.clientInstanceId,
    localSeq: String(request.localSeq),
    writeEpoch: String(lease.writeEpoch),
    formulasPending: String(request.formulasPending),
    ...clientFormatParams(),
  })
  const path = `${contentPath(documentId)}?${query.toString()}`
  const response = await apiFetch(path, { method: 'PUT', headers: leaseHeaders(lease.token), body: { contentType: SNAPSHOT_UPLOAD_CONTENT_TYPE, data: compressed } })
  return readJson(response, saveContentResponseSchema, `PUT ${contentPath(documentId)}`)
}

/**
 * 申请编辑权（201）：clientInstanceId 是本页这次加载的标识，租约绑定它与这次登录；带上本页的构建与数据格式（M3-P3）。
 * 续上时另带本页的空闲秒数（idleSeconds，M3-P5 设计 §3.5：新的一代的最后活动按它往前推）；用户发起的申请不带。
 * 被占用时抛出 EDIT_LEASE_HELD，本页过旧时 CLIENT_OUTDATED，文档比服务端新时 DOCUMENT_TOO_NEW（ApiError）
 */
export async function acquireEditLease(documentId: string, clientInstanceId: string, idleSeconds?: number): Promise<AcquiredEditLease> {
  const body = { clientInstanceId, ...(idleSeconds === undefined ? {} : { idleSeconds }), ...PAGE_CLIENT_FORMAT }
  return apiRequest(leasePath(documentId), { method: 'POST', body, schema: acquiredEditLeaseSchema })
}

/**
 * 心跳续租（200）：带上距离本页最后一次键盘、鼠标操作的秒数与本页的构建与数据格式（M3-P3）。租约不再有效时抛出 EDIT_LEASE_LOST，
 * 本页过旧时 CLIENT_OUTDATED（ApiError）
 */
export async function renewEditLease(documentId: string, token: string, idleSeconds: number): Promise<RenewedEditLease> {
  return apiRequest(leasePath(documentId), { method: 'PUT', body: { idleSeconds, ...PAGE_CLIENT_FORMAT }, headers: leaseHeaders(token), schema: renewedEditLeaseSchema })
}

/**
 * 打开自检失败的上报（204，M3-P4 设计 §3.13）：请求体由 open-check-report.ts 给出（普通的 JSON；不经 apiRequest——那要响应的结构，
 * 这个接口没有响应体，也不引用带 zod 的 openCheckReportSchema）。能读这份文档就能报；服务端去重、按账户限量，标为后台请求（不顺延登录）。
 * 失败时抛出请求层的错误（调用方不看结果、不重试）
 */
export async function reportOpenCheckFailures(documentId: string, report: OpenCheckReport): Promise<void> {
  await apiFetch(`${documentPath(documentId)}/open-check-failures`, { method: 'POST', body: { contentType: 'application/json', data: JSON.stringify(report) } })
}

/**
 * 释放编辑权（204）：页面隐藏、关闭时也要发出去，用 keepalive；那时不看结果——没送到时由服务端按到期回收（P1 设计 §3.4.3）。
 * 请求层照常带上 CSRF 令牌（状态变更的请求）。失败时抛出请求层的错误：续上时要知道放掉了没有，结果未知就不申请（审查 B9）
 */
export async function releaseEditLease(documentId: string, token: string): Promise<void> {
  await apiFetch(leasePath(documentId), { method: 'DELETE', headers: leaseHeaders(token), keepalive: true })
}
