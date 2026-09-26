// 请求层（规范 §2.4，P3 设计 §3.7）：页面经这里访问接口，不在组件里直接 fetch。
import type { z } from 'zod'
import { CSRF_TOKEN_HEADER, errorResponseSchema } from '@nerve-office/contracts'

export interface ApiErrorDetails {
  readonly requestId?: string
  /** 429 的 Retry-After（秒） */
  readonly retryAfterSeconds?: number
  /** 错误响应的 details：结构按错误码约定，使用方按错误码用 contracts 里的结构再校验（ADR-006） */
  readonly details?: Readonly<Record<string, unknown>>
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

  constructor(status: number, code: string, message: string, details: ApiErrorDetails = {}) {
    super(message)
    this.status = status
    this.code = code
    this.requestId = details.requestId
    this.retryAfterSeconds = details.retryAfterSeconds
    this.details = details.details
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
  signal?: AbortSignal
  /** 成功响应的结构（契约）；没有响应体的接口用 z.undefined() */
  schema: z.ZodType<T>
}

/** 不是 JSON 的请求与响应（例如表格快照的上传与读取）。 */
export interface RawRequestOptions {
  method?: HttpMethod
  /** 请求体与它的内容类型 */
  body?: { readonly contentType: string, readonly data: Blob | string }
  /** 期望的响应类型，默认 JSON */
  accept?: string
  signal?: AbortSignal
}

async function errorFrom(response: Response): Promise<ApiError> {
  const retryAfter = Number(response.headers.get('retry-after'))
  const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
  const parsed = errorResponseSchema.safeParse(await response.json().catch(() => undefined))
  if (!parsed.success)
    return new ApiError(response.status, 'UNKNOWN', `服务端返回了意外的响应（HTTP ${response.status}）`)
  const { code, message, requestId, details } = parsed.data.error
  return new ApiError(response.status, code, message, { requestId, retryAfterSeconds, details })
}

/**
 * 同源请求，返回成功的响应本身：调用方自己读正文与响应头（例如快照的字节与 ETag）。
 * 状态变更的请求带 CSRF 令牌。失败时抛出 ApiError 或 NetworkError；取消（signal）时原样抛出。
 */
export async function apiFetch(path: string, options: RawRequestOptions = {}): Promise<Response> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { accept: options.accept ?? 'application/json' }
  if (options.body !== undefined)
    headers['content-type'] = options.body.contentType
  if (UNSAFE_METHODS.has(method) && csrfToken !== undefined)
    headers[CSRF_TOKEN_HEADER] = csrfToken

  let response: Response
  try {
    response = await fetch(path, { method, headers, credentials: 'same-origin', body: options.body?.data, signal: options.signal })
  }
  catch (error) {
    if (options.signal?.aborted === true)
      throw error
    throw new NetworkError('网络请求失败', { cause: error })
  }
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
  const response = await apiFetch(path, { method, body, signal: options.signal })
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

/** 可以自动重试的失败：网络问题与服务端的临时错误。其他错误重试也没用。 */
export function isTransientError(error: unknown): boolean {
  return error instanceof NetworkError || (error instanceof ApiError && error.status >= 500)
}
