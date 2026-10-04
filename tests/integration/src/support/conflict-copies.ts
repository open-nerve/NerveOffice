// 另存为副本（M3-P2 设计 §3.2）：POST /api/documents/{id}/conflict-copies?requestId&title，正文是 gzip 压缩的快照
// （与保存同一个读取方式），元数据只能放在查询串里。功能用例、"看不到与不存在"的探测与权限矩阵共用这里的写法。
import type { LoggedIn } from './session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { conflictCopyTitle, SHEET_TEMPLATE, SNAPSHOT_UPLOAD_CONTENT_TYPE } from '@nerve-office/contracts'
import { asUser } from './session-client.ts'

/** 页面按所在的时区写到分钟的时间：用例里固定一个 */
export const CONFLICT_COPY_LABEL = '2026-10-04 14:30'

/** 本页捕获的快照：模板换上 unitId，A1 写入 value（"本页的修改"） */
export function pageSnapshot(unitId: string, value = '本页没保存上的修改'): Buffer {
  const sheet = SHEET_TEMPLATE.sheets['sheet-1']
  return Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: unitId, sheets: { 'sheet-1': { ...sheet, cellData: { 0: { 0: { v: value } } } } } }), 'utf8')
}

export interface ConflictCopyRequest {
  readonly requestId?: string
  /** 副本的标题；没给时是 conflictCopyTitle('周报', CONFLICT_COPY_LABEL) */
  readonly title?: string
  /** 另加或覆盖的查询参数（反向用例） */
  readonly query?: Readonly<Record<string, string>>
}

/** 另存为副本的地址：查询参数里带着 requestId 与标题 */
export function conflictCopyPath(documentId: string, request: ConflictCopyRequest = {}): string {
  const query = new URLSearchParams({
    requestId: request.requestId ?? randomUUID(),
    title: request.title ?? conflictCopyTitle('周报', CONFLICT_COPY_LABEL),
    ...request.query,
  })
  return `/api/documents/${documentId}/conflict-copies?${query.toString()}`
}

export interface ConflictCopyBody {
  /** 快照的 JSON 字节；正文是它的 gzip */
  readonly raw?: Buffer
  /** 直接给出正文（反向用例：不是 gzip、几个成员拼起来） */
  readonly bytes?: Uint8Array
  /** 内容类型（反向用例）；默认 application/gzip */
  readonly contentType?: string
  /** 另加或覆盖的请求头（反向用例：Origin、CSRF 令牌、Content-Encoding） */
  readonly headers?: Readonly<Record<string, string | undefined>>
}

/** 发一次另存为副本：正文默认是 pageSnapshot(unitId) 的 gzip */
export async function postConflictCopy(baseUrl: string, user: LoggedIn, documentId: string, unitId: string, request: ConflictCopyRequest & ConflictCopyBody = {}): Promise<Response> {
  const bytes = request.bytes ?? zlib.gzipSync(request.raw ?? pageSnapshot(unitId))
  return asUser(baseUrl, user, conflictCopyPath(documentId, request), {
    method: 'POST',
    binary: { contentType: request.contentType ?? SNAPSHOT_UPLOAD_CONTENT_TYPE, bytes },
    ...(request.headers === undefined ? {} : { headers: { ...request.headers } }),
  })
}
