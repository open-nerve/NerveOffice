// 编辑器页的接口（P4 设计 §3.3）：元数据、内容（快照的原文与修订号）与保存（gzip 压缩的快照）。
import type { DocumentDetail, SaveContentResponse } from '@nerve-office/contracts'
import type { SaveRequest } from './save-coordinator.ts'
import { documentDetailSchema, revisionFromEtag, saveContentResponseSchema, SNAPSHOT_UPLOAD_CONTENT_TYPE } from '@nerve-office/contracts'
import { apiFetch, apiRequest, readJson, ResponseFormatError } from '../../shared/api/index.ts'

/** 内容的原文（浏览器已按 Content-Encoding 解压）与它的修订号（ETag）：修订号是保存的基准。 */
export interface LoadedContent {
  readonly snapshot: string
  readonly revision: number
}

function documentPath(documentId: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}`
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

export async function saveContent(documentId: string, request: SaveRequest, compressed: Uint8Array<ArrayBuffer>): Promise<SaveContentResponse> {
  const query = new URLSearchParams({
    baseRevision: String(request.baseRevision),
    requestId: request.requestId,
    clientInstanceId: request.clientInstanceId,
    localSeq: String(request.localSeq),
  })
  const path = `${documentPath(documentId)}/content?${query.toString()}`
  const response = await apiFetch(path, { method: 'PUT', body: { contentType: SNAPSHOT_UPLOAD_CONTENT_TYPE, data: compressed } })
  return readJson(response, saveContentResponseSchema, `PUT ${documentPath(documentId)}/content`)
}
