import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { apiError, installFakeApi, json } from '../testing/fake-api.test-support.ts'
import { ApiError, apiRequest, isAuthenticationError, isTransientError, NetworkError, ResponseFormatError, setCsrfToken } from './client.ts'

const itemSchema = z.strictObject({ name: z.string() })

beforeEach(() => {
  setCsrfToken(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apiRequest', () => {
  it('成功：按契约校验并返回数据；同源请求，接受 JSON', async () => {
    const api = installFakeApi({ 'GET /api/item': () => json(200, { name: '周报' }) })
    await expect(apiRequest('/api/item', { schema: itemSchema })).resolves.toEqual({ name: '周报' })
    expect(api.requests[0]?.headers).toMatchObject({ accept: 'application/json' })
  })

  it('状态变更的请求带 CSRF 令牌与 JSON 请求体；GET 不带令牌', async () => {
    const api = installFakeApi({ 'POST /api/item': () => json(200, { name: 'x' }), 'GET /api/item': () => json(200, { name: 'x' }) })
    setCsrfToken('csrf-1')
    await apiRequest('/api/item', { method: 'POST', body: { name: 'x' }, schema: itemSchema })
    await apiRequest('/api/item', { schema: itemSchema })
    expect(api.requests[0]).toMatchObject({ headers: { 'x-csrf-token': 'csrf-1', 'content-type': 'application/json' }, body: { name: 'x' } })
    expect(api.requests[1]?.headers['x-csrf-token']).toBeUndefined()
  })

  it('204：没有响应体', async () => {
    installFakeApi({ 'POST /api/logout': () => new Response(null, { status: 204 }) })
    await expect(apiRequest('/api/logout', { method: 'POST', schema: z.undefined() })).resolves.toBeUndefined()
  })

  it('错误响应：带错误码、请求标识与 Retry-After 的 ApiError', async () => {
    installFakeApi({ 'POST /api/auth/login': () => apiError(429, 'TOO_MANY_ATTEMPTS', '尝试次数过多', { 'retry-after': '120' }) })
    const error = await apiRequest('/api/auth/login', { method: 'POST', body: {}, schema: itemSchema }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 429, code: 'TOO_MANY_ATTEMPTS', requestId: 'req-too_many_attempts', retryAfterSeconds: 120 })
  })

  it('错误响应不是约定的格式（例如反向代理的错误页）：UNKNOWN', async () => {
    installFakeApi({ 'GET /api/item': () => new Response('<html>502 Bad Gateway</html>', { status: 502 }) })
    await expect(apiRequest('/api/item', { schema: itemSchema })).rejects.toMatchObject({ status: 502, code: 'UNKNOWN' })
  })

  it('成功的响应与契约不一致：ResponseFormatError，不交出错的数据', async () => {
    installFakeApi({ 'GET /api/item': () => json(200, { name: 1 }) })
    await expect(apiRequest('/api/item', { schema: itemSchema })).rejects.toBeInstanceOf(ResponseFormatError)
  })

  it('网络失败：NetworkError；主动取消时原样抛出', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    await expect(apiRequest('/api/item', { schema: itemSchema })).rejects.toBeInstanceOf(NetworkError)
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError')
    }))
    await expect(apiRequest('/api/item', { schema: itemSchema, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('错误的分类', () => {
  it('未登录与登录已过期要回到登录页', () => {
    expect(isAuthenticationError(new ApiError(401, 'UNAUTHENTICATED', 'x'))).toBe(true)
    expect(isAuthenticationError(new ApiError(401, 'SESSION_EXPIRED', 'x'))).toBe(true)
    expect(isAuthenticationError(new ApiError(401, 'INVALID_CREDENTIALS', 'x'))).toBe(false)
    expect(isAuthenticationError(new Error('x'))).toBe(false)
  })

  it('网络失败与 5xx 可以重试，4xx 不重试', () => {
    expect(isTransientError(new NetworkError('x'))).toBe(true)
    expect(isTransientError(new ApiError(503, 'SERVICE_UNAVAILABLE', 'x'))).toBe(true)
    expect(isTransientError(new ApiError(404, 'NOT_FOUND', 'x'))).toBe(false)
    expect(isTransientError(new Error('x'))).toBe(false)
  })
})
