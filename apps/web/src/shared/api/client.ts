// 请求层（规范 §2.4，P3 设计 §3.7）：页面经这里访问接口，不在组件里直接 fetch。
import type { z } from 'zod'
import { CSRF_TOKEN_HEADER, errorResponseSchema } from '@nerve-office/contracts'

export interface ApiErrorDetails {
  readonly requestId?: string
  /** 响应头 Retry-After（秒）：429，与服务繁忙的 503（快照检查池满、每个账户 2 份、数据库繁忙，M3-P3）；自动保存按它退避（M3-P4） */
  readonly retryAfterSeconds?: number
  /** 错误响应的 details：结构按错误码约定，使用方按错误码用 contracts 里的结构再校验（ADR-006） */
  readonly details?: Readonly<Record<string, unknown>>
  /** 服务端回答的时刻（响应头 Date，毫秒时间戳，精确到秒） */
  readonly serverTime?: number
}

/**
 * 服务端按约定返回的错误。code 是错误码：可能是前端还不认识的（服务端比前端新），
 * 为 UNKNOWN 时表示响应不是约定的格式（例如反向代理的错误页）。
 */
export class ApiError extends Error {
  override readonly name = 'ApiError'
  readonly status: number
  readonly code: string
  readonly requestId: string | undefined
  readonly retryAfterSeconds: number | undefined
  readonly details: Readonly<Record<string, unknown>> | undefined
  /**
   * 服务端回答这次请求的时刻（响应头 Date；没有或读不出来时为 undefined）。details 里服务端的时间（例如别人的最后活动时间）
   * 拿它来比，算出"多久之前"，不拿浏览器的时钟去比：浏览器的时钟可能不准（M3 总设计 §2.1）
   */
  readonly serverTime: number | undefined

  constructor(status: number, code: string, message: string, details: ApiErrorDetails = {}) {
    super(message)
    this.status = status
    this.code = code
    this.requestId = details.requestId
    this.retryAfterSeconds = details.retryAfterSeconds
    this.details = details.details
    this.serverTime = details.serverTime
  }
}

/** 请求没能到达服务端，或者没有收到响应（断网、服务不可达）。 */
export class NetworkError extends Error {
  override readonly name = 'NetworkError'
}

/** 成功的响应与契约的结构不一致：前后端版本不一致，或者服务端的缺陷。不渲染出错的数据。 */
export class ResponseFormatError extends Error {
  override readonly name = 'ResponseFormatError'
}

const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** 由登录与会话接口给出；状态变更的请求带上它。只放在内存里，刷新页面后由会话接口重新给出 */
let csrfToken: string | undefined

export function setCsrfToken(token: string | undefined): void {
  csrfToken = token
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface RequestOptions<T> {
  method?: HttpMethod
  body?: unknown
  /** 另外的请求头（例如编辑租约的令牌）：不能覆盖请求层自己的那几个（接受的类型、内容类型、CSRF 令牌） */
  headers?: Readonly<Record<string, string>>
  signal?: AbortSignal
  /** 成功响应的结构（契约）；没有响应体的接口用 z.undefined() */
  schema: z.ZodType<T>
}

/** 不是 JSON 的请求与响应（例如表格快照的上传与读取）。 */
export interface RawRequestOptions {
  method?: HttpMethod
  /** 请求体与它的内容类型 */
  body?: { readonly contentType: string, readonly data: Uint8Array<ArrayBuffer> | string }
  /** 期望的响应类型，默认 JSON */
  accept?: string
  /** 另外的请求头（例如编辑租约的令牌）：不能覆盖请求层自己的那几个（接受的类型、内容类型、CSRF 令牌） */
  headers?: Readonly<Record<string, string>>
  /**
   * 页面关闭之后请求照样发出（fetch 的 keepalive）：关闭页面时尽力释放编辑租约用，结果没人看（M3-P1 设计 §3.4.7）。
   * 浏览器限制这类请求的请求体（合计 64 KiB），只用于没有请求体或请求体很小的请求
   */
  keepalive?: boolean
  /**
   * 条件请求（请求头带 If-None-Match）：304 Not Modified 不是失败，原样交回响应（没有正文），由调用方认出"没有变化"
   * （M3-P2 设计 §3.2，内容的读取）
   */
  acceptNotModified?: boolean
  signal?: AbortSignal
}

/** 响应头 Date 的时刻（毫秒时间戳）；没有或读不出来时为 undefined。成功的响应要它时（例如编辑状态里的最后活动时间）也用它 */
export function serverTimeOf(response: Response): number | undefined {
  const time = Date.parse(response.headers.get('date') ?? '')
  return Number.isFinite(time) ? time : undefined
}

/**
 * 响应头 Retry-After（秒）：秒数，或者 HTTP 日期（反向代理可能这样写）——日期按同一个响应的 Date 算出相隔几秒（向上取整），不拿浏览器的
 * 时钟去比（它可能不准），没有 Date 时不认。没有、读不出来或者不是正数时为 undefined
 */
export function retryAfterOf(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim() ?? ''
  if (value === '')
    return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds))
    return seconds > 0 ? seconds : undefined
  const at = Date.parse(value)
  const now = serverTimeOf(response)
  if (!Number.isFinite(at) || now === undefined)
    return undefined
  const delay = Math.ceil((at - now) / 1000)
  return delay > 0 ? delay : undefined
}

async function errorFrom(response: Response): Promise<ApiError> {
  // 响应头一律照读：错误响应不是约定的格式（例如反向代理自己回的 503、429）时也带上 Retry-After 与 Date，调用方照样按它等（审查 A10）
  const headers: ApiErrorDetails = { retryAfterSeconds: retryAfterOf(response), serverTime: serverTimeOf(response) }
  const parsed = errorResponseSchema.safeParse(await response.json().catch(() => undefined))
  if (!parsed.success)
    return new ApiError(response.status, 'UNKNOWN', `服务端返回了意外的响应（HTTP ${response.status}）`, headers)
  const { code, message, requestId, details } = parsed.data.error
  return new ApiError(response.status, code, message, { ...headers, requestId, details })
}

/**
 * 同源请求，返回成功的响应本身：调用方自己读正文与响应头（例如快照的字节与 ETag）。
 * 状态变更的请求带 CSRF 令牌。失败时抛出 ApiError 或 NetworkError；取消（signal）时原样抛出。
 */
export async function apiFetch(path: string, options: RawRequestOptions = {}): Promise<Response> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { ...options.headers, accept: options.accept ?? 'application/json' }
  if (options.body !== undefined)
    headers['content-type'] = options.body.contentType
  if (UNSAFE_METHODS.has(method) && csrfToken !== undefined)
    headers[CSRF_TOKEN_HEADER] = csrfToken

  let response: Response
  try {
    response = await fetch(path, { method, headers, credentials: 'same-origin', body: options.body?.data, keepalive: options.keepalive, signal: options.signal })
  }
  catch (error) {
    if (options.signal?.aborted === true)
      throw error
    throw new NetworkError('网络请求失败', { cause: error })
  }
  if (response.status === 304 && options.acceptNotModified === true)
    return response
  if (!response.ok)
    throw await errorFrom(response)
  return response
}

/** 按契约读出成功响应的 JSON 正文；与契约不一致时抛出 ResponseFormatError（label 写进说明，例如"GET /api/x"）。 */
export async function readJson<T>(response: Response, schema: z.ZodType<T>, label: string): Promise<T> {
  const body: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined)
  const parsed = schema.safeParse(body)
  if (!parsed.success)
    throw new ResponseFormatError(`${label} 的响应与契约不一致`, { cause: parsed.error })
  return parsed.data
}

/** 同源的 JSON 请求；失败时抛出 ApiError、NetworkError 或 ResponseFormatError。取消（signal）时原样抛出。 */
export async function apiRequest<T>(path: string, options: RequestOptions<T>): Promise<T> {
  const method = options.method ?? 'GET'
  const body = options.body === undefined ? undefined : { contentType: 'application/json', data: JSON.stringify(options.body) }
  const response = await apiFetch(path, { method, body, headers: options.headers, signal: options.signal })
  return readJson(response, options.schema, `${method} ${path}`)
}

/** 未登录或登录已过期：页面要回到登录页。 */
export function isAuthenticationError(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.code === 'UNAUTHENTICATED' || error.code === 'SESSION_EXPIRED')
}

/** CSRF 令牌不对：页面拿着的会话已经过时（例如别的标签页换了人登录），要重新确认会话。 */
export function isCsrfTokenError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === 'CSRF_TOKEN_INVALID'
}

/** 没有权限：服务端逐请求检查（例如只给系统管理员的管理接口）。 */
export function isPermissionDeniedError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === 'PERMISSION_DENIED'
}

/**
 * 要的内容不存在，或者看不到（两者同一个错误码，US-M1-08）；地址里的 id 不合法（400）也按不存在处理。
 * 空间、成员页、文档与管理界面的账户都用同一句说明（M2-P2 审查 B13）
 */
export function isMissingResource(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.code === 'NOT_FOUND' || error.code === 'REQUEST_INVALID')
}

/**
 * 要的内容不存在，或者看不到了（404 NOT_FOUND）。与 isMissingResource 不同，不含 400：地址里的 id 不合法才按不存在处理，
 * 保存这类请求的 400 是请求本身的问题，不能说成"已经被删除、移走"（M2-P6 复核第二批 G-5）
 */
export function isNotFoundError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === 'NOT_FOUND'
}

/**
 * 操作按访问权限被拒绝：看不到了（404，与不存在一致），或者看得到却不能做（403）。页面上显示的权限可能已经过时
 * （例如空间刚被归档、刚被移出），页面据此重新请求（M2-P2 复验）。请求内容不合法（400）不算：那是请求本身的问题
 */
export function isAccessDenied(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.code === 'NOT_FOUND' || error.code === 'PERMISSION_DENIED')
}

/**
 * 请求确定没有生效：服务端在写入之前就拒绝了（4xx）。其余的失败（网络、5xx、回包读不出来）结果未知，服务端可能已经处理，
 * 重试要沿用同一个 requestId（新建表格、保存）
 */
export function isDefiniteRejection(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status >= 400 && error.status < 500
}

/**
 * 写操作的结果未知：请求可能已经生效，只是没有收到确定的回答（网络中断、服务端或代理出错、回包读不出来）。
 * 与 isDefiniteRejection 的区别只在一处：服务端自己回答的 503 SERVICE_UNAVAILABLE 结果是确定的"没有生效"——
 * 等待密码哈希的请求太多（DEF-015）发生在写入之前；数据库繁忙（等锁超时、语句超时、取不到连接）时事务整体回滚
 * （M2-P6 第 3 片复核 A 的 G-2），而且服务端只在这个请求里还没有事务提交过时才回 503，提交之后遇到繁忙回 500
 * （M2-P6 第 3 片复验）。界面据此提示"可能已经生效"（M2-P6 复核 G-1、G-2）
 */
export function isUnknownOutcome(error: unknown): boolean {
  if (error instanceof ApiError)
    return error.status >= 500 && error.code !== 'SERVICE_UNAVAILABLE'
  return true
}

/** 可以自动重试的失败：网络问题与服务端的临时错误。其他错误重试也没用。 */
export function isTransientError(error: unknown): boolean {
  return error instanceof NetworkError || (error instanceof ApiError && error.status >= 500)
}
