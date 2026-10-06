// 编辑租约（M3-P1）：保存要求租约之后（S4），集成测试发保存之前先申请——令牌放请求头（x-edit-lease），申请得到的代次与
// 申请时的标签页放进保存的查询参数（writeEpoch、clientInstanceId）。现有用例的保存都经 saveContent：用例本身的断言不变，
// 它们要验证的仍是租约之外的步骤（权限、幂等、修订号、锁）。另有心跳、结局与租约行的读取（收回写入权的用例），
// 以及改写租约行时间的两个辅助（到期、空闲），不等真实的时间。
// M3-P3 起申请、心跳与保存都带页面的构建与数据格式（support/client-format.ts）：这里的请求扮演现在的页面。
import type { ClientFormat } from '@nerve-office/contracts'
import type { TestDatabase } from './database.ts'
import type { LoggedIn } from './session-client.ts'
import { randomUUID } from 'node:crypto'
import { acquiredEditLeaseSchema, EDIT_LEASE_HEADER, editLeaseLostDetailsSchema, errorResponseSchema } from '@nerve-office/contracts'
import { expect } from 'vitest'
import { acquireBody, clientFormatQuery, renewBody } from './client-format.ts'
import { parseExact } from './contracts.ts'
import { asUser } from './session-client.ts'

/** 申请到的编辑租约：令牌、这一代的代次与申请时的标签页（统一成小写，与服务端记下的一样） */
export interface HeldLease {
  readonly token: string
  readonly writeEpoch: number
  readonly clientInstanceId: string
}

function leasePath(documentId: string): string {
  return `/api/documents/${documentId}/edit-lease`
}

/** 申请编辑权：成功（201）时是租约；申请不了（看不到、只能查看、别人正在编辑、没有登录）时为 undefined */
export async function tryAcquireLease(baseUrl: string, user: LoggedIn, documentId: string, clientInstanceId: string = randomUUID()): Promise<HeldLease | undefined> {
  const response = await asUser(baseUrl, user, leasePath(documentId), { method: 'POST', body: acquireBody(clientInstanceId) })
  if (response.status !== 201) {
    await response.arrayBuffer()
    return undefined
  }
  const acquired = parseExact(acquiredEditLeaseSchema, await response.json())
  return { token: acquired.token, writeEpoch: acquired.writeEpoch, clientInstanceId: clientInstanceId.toLowerCase() }
}

/** 申请编辑权，要求成功：交错的用例在持锁之前先申请好，让被测的保存（而不是申请）停在锁上 */
export async function acquireLease(baseUrl: string, user: LoggedIn, documentId: string, clientInstanceId?: string): Promise<HeldLease> {
  const lease = await tryAcquireLease(baseUrl, user, documentId, clientInstanceId)
  expect(lease, `申请 ${documentId} 的编辑权应当成功`).toBeDefined()
  if (lease === undefined)
    throw new Error(`没有申请到 ${documentId} 的编辑权`)
  return lease
}

/** 释放：不看结果（与页面关闭时的释放一样，接口一律 204；登录已经失效、文档读不到时是 401、404） */
export async function releaseLease(baseUrl: string, user: LoggedIn, documentId: string, lease: HeldLease): Promise<void> {
  await (await asUser(baseUrl, user, leasePath(documentId), { method: 'DELETE', headers: { [EDIT_LEASE_HEADER]: lease.token } })).arrayBuffer()
}

/** 心跳续租（页面每 10 秒一次）：带着这份租约的令牌，上报没有空闲 */
export async function renewLease(baseUrl: string, user: LoggedIn, documentId: string, lease: HeldLease): Promise<Response> {
  return asUser(baseUrl, user, leasePath(documentId), { method: 'PUT', body: renewBody(0), headers: { [EDIT_LEASE_HEADER]: lease.token } })
}

/**
 * 一次心跳、保存或申请的结局，写成一行便于逐个比较：成功时只有状态码（"200"）；失败时是状态码与错误码（"403 PERMISSION_DENIED"），
 * 编辑权已失效时带上原因（"409 EDIT_LEASE_LOST:revoked"）
 */
export async function outcomeOf(response: Response): Promise<string> {
  if (response.ok) {
    await response.arrayBuffer()
    return String(response.status)
  }
  const { error } = parseExact(errorResponseSchema, await response.json())
  const reason = error.code === 'EDIT_LEASE_LOST' ? `:${String(parseExact(editLeaseLostDetailsSchema, error.details).reason)}` : ''
  return `${response.status} ${error.code}${reason}`
}

/** 一份文档上的租约行（持有者、明确结束的原因、这一代的代次）与文档现在的代次 */
export interface LeaseState {
  readonly holderId: string
  readonly endReason: string | null
  readonly leaseEpoch: number
  readonly documentEpoch: number
}

export async function leaseStateOf(database: TestDatabase, documentId: string): Promise<LeaseState | undefined> {
  return database.query(async client => (await client.query<LeaseState>(
    `SELECT l.holder_id AS "holderId", l.end_reason AS "endReason", l.write_epoch AS "leaseEpoch", d.write_epoch AS "documentEpoch"
     FROM document_edit_leases l JOIN documents d ON d.id = l.document_id WHERE l.document_id = $1`,
    [documentId],
  )).rows[0])
}

/** 格式合法、谁的也不是的令牌 */
const STRAY_TOKEN = `${'s'.repeat(41)}-_`

/**
 * 谁的也不是的租约：申请不了的人照样发保存。服务端先判断访问与编辑权、再查重放，都在租约之前，
 * 所以这些用例（404、403、重放、请求不合法）的结果与带不带租约无关
 */
export function strayLease(clientInstanceId: string = randomUUID()): HeldLease {
  return { token: STRAY_TOKEN, writeEpoch: 0, clientInstanceId }
}

/** 一次保存：gzip 压缩的快照之外的参数 */
export interface SaveOptions {
  readonly baseRevision: number | string
  readonly requestId?: string
  readonly localSeq?: number | string
  /**
   * 用这份租约：几次并发的保存共用同一个页面的租约；交错的用例在持锁之前先申请好。
   * 没给时先以这个人申请、保存之后释放（见 saveContent）
   */
  readonly lease?: HeldLease
  /** 没给租约时申请用的标签页（用例要核对保存的来源时给定）；默认每次一个新的 */
  readonly clientInstanceId?: string
  /** 覆盖查询参数（反向用例：不合法的参数；"公式待更新"） */
  readonly query?: Readonly<Record<string, string>>
  /** 页面上报的构建与数据格式（M3-P3）：默认是现在的页面；旧页面给 {}（什么也不报）或者改写其中的一项 */
  readonly clientFormat?: ClientFormat
  /** 另加或覆盖的请求头（反向用例：Origin、CSRF 令牌、租约令牌） */
  readonly headers?: Readonly<Record<string, string | undefined>>
}

/** 保存的地址：查询参数里带着租约的代次与标签页，与现在的页面的构建与数据格式（M3-P3） */
export function contentPathWithLease(documentId: string, lease: HeldLease, options: SaveOptions): string {
  const query = new URLSearchParams({
    baseRevision: String(options.baseRevision),
    requestId: options.requestId ?? randomUUID(),
    clientInstanceId: lease.clientInstanceId,
    localSeq: String(options.localSeq ?? 1),
    writeEpoch: String(lease.writeEpoch),
    ...clientFormatQuery(options.clientFormat),
    ...options.query,
  })
  return `/api/documents/${documentId}/content?${query.toString()}`
}

/**
 * 发一次保存（M3-P1 S4 起保存要求编辑租约）。给了租约就用它；没给时先以这个人（这个标签页）申请，用申请到的租约保存，
 * 再释放——一次保存就是一段最短的编辑，之后别人、或同一个人的别的标签页照样能申请（原来用两个标签页交替保存的用例因此照常进行）。
 * 申请不了（看不到、只能查看、别人正在编辑、没有登录）时用谁的也不是的租约发出去：那些用例验证的是先于租约的判断
 */
export async function saveContent(baseUrl: string, user: LoggedIn, documentId: string, gzipped: Uint8Array, options: SaveOptions): Promise<Response> {
  const own = options.lease === undefined ? await tryAcquireLease(baseUrl, user, documentId, options.clientInstanceId) : undefined
  const lease = options.lease ?? own ?? strayLease(options.clientInstanceId)
  const response = await asUser(baseUrl, user, contentPathWithLease(documentId, lease, options), {
    method: 'PUT',
    binary: { contentType: 'application/gzip', bytes: gzipped },
    headers: { [EDIT_LEASE_HEADER]: lease.token, ...options.headers },
  })
  // 保存的事务在响应之前已经结束：这时释放，不影响调用方读这次的响应
  if (own !== undefined)
    await releaseLease(baseUrl, user, documentId, own)
  return response
}

/**
 * 时间过去了 seconds 秒：这份文档的租约行上的时间一起往前挪（表上的约束照样成立），不等真实的时间。
 * 到期、空闲与提醒都按数据库的 now() 与租约行上的时间判断（P1 设计 §3.4.1），挪租约行就是让时间过去。
 * 明确结束的时刻与 M3-P5 的请求编辑（发出、有效期、谢绝）、交出之后的保留也按同样的规则判断，一起挪；空的列挪了还是空的
 */
export async function passLeaseTime(database: TestDatabase, documentId: string, seconds: number): Promise<void> {
  const columns = ['acquired_at', 'renewed_at', 'expires_at', 'last_active_at', 'ended_at', 'requested_at', 'request_expires_at', 'request_declined_at', 'reserved_until']
  await database.query(async client => client.query(
    `UPDATE document_edit_leases SET ${columns.map(column => `${column} = ${column} - make_interval(secs => $2)`).join(', ')} WHERE document_id = $1`,
    [documentId, seconds],
  ))
}

/**
 * 最后一次操作之后又过了 seconds 秒、心跳照常（M3-P5）：最后活动与申请的时间往前挪，续租的时间、到期不动——
 * 与 idleLeaseFor（直接定成"seconds 秒之前"）不同，它保留这一行原来的空闲（例如续上时带来的），在它之上再加
 */
export async function passIdleTime(database: TestDatabase, documentId: string, seconds: number): Promise<void> {
  await database.query(async client => client.query(
    `UPDATE document_edit_leases SET last_active_at = last_active_at - make_interval(secs => $2), acquired_at = acquired_at - make_interval(secs => $2)
     WHERE document_id = $1`,
    [documentId, seconds],
  ))
}

/** 最后一次操作在 seconds 秒之前（心跳还在：续租的时间、到期不动；申请的时间不晚于它） */
export async function idleLeaseFor(database: TestDatabase, documentId: string, seconds: number): Promise<void> {
  await database.query(async client => client.query(
    `UPDATE document_edit_leases SET last_active_at = now() - make_interval(secs => $2), acquired_at = least(acquired_at, now() - make_interval(secs => $2))
     WHERE document_id = $1`,
    [documentId, seconds],
  ))
}
