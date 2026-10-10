import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { apiError, installFakeApi, json } from '../testing/fake-api.test-support.ts'
import { ApiError, apiFetch, apiRequest, isAccessDenied, isAuthenticationError, isMissingResource, isPermissionDeniedError, isTransientError, NetworkError, readJson, ResponseFormatError, retryAfterOf, serverTimeOf, setCsrfToken } from './client.ts'

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
    await expect(apiRequest('/api/item', { schema: itemSchema })).rejects.toMatchObject({ status: 502, code: 'UNKNOWN', retryAfterSeconds: undefined })
  })

  it('错误响应不是约定的格式、带着 Retry-After（例如反向代理自己回的 503，审查 A10）：照样读出 Retry-After 与 Date', async () => {
    const date = 'Mon, 05 Oct 2026 08:00:00 GMT'
    installFakeApi({ 'PUT /api/blob': () => new Response('<html>503 Service Unavailable</html>', { status: 503, headers: { 'retry-after': '30', date } }) })
    await expect(apiFetch('/api/blob', { method: 'PUT' }, () => undefined)).rejects.toMatchObject({ status: 503, code: 'UNKNOWN', retryAfterSeconds: 30, serverTime: Date.parse(date) })
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

describe('apiFetch（不是 JSON 的请求与响应）', () => {
  it('作用域内读取正文与响应头并返回数据；状态变更的请求带 CSRF 令牌与给定的内容类型', async () => {
    const api = installFakeApi({ 'PUT /api/blob': () => new Response('ok', { status: 200, headers: { etag: '"3"' } }) })
    setCsrfToken('csrf-2')
    const result = await apiFetch('/api/blob', { method: 'PUT', body: { contentType: 'application/gzip', data: new Uint8Array([1, 2, 3]) } }, async response => ({ etag: response.headers.get('etag'), text: await response.text() }))
    expect(result).toEqual({ etag: '"3"', text: 'ok' })
    expect(api.requests[0]?.headers).toMatchObject({ 'content-type': 'application/gzip', 'x-csrf-token': 'csrf-2', 'accept': 'application/json' })
  })

  it('错误响应：带上 details（结构按错误码约定）', async () => {
    const details = { currentRevision: 4, source: null }
    installFakeApi({ 'PUT /api/blob': () => json(409, { error: { code: 'DOCUMENT_REVISION_CONFLICT', message: '冲突', requestId: 'req-1', details } }) })
    await expect(apiFetch('/api/blob', { method: 'PUT' }, () => undefined)).rejects.toMatchObject({ status: 409, code: 'DOCUMENT_REVISION_CONFLICT', details })
  })

  it('网络失败：NetworkError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    await expect(apiFetch('/api/blob', {}, () => undefined)).rejects.toBeInstanceOf(NetworkError)
  })

  it('另外的请求头照样带上，覆盖不了请求层自己的那几个；keepalive 交给 fetch（M3-P1：编辑租约的令牌、关闭页面时的释放）', async () => {
    let init: RequestInit | undefined
    const api = installFakeApi({
      'DELETE /api/lease': (received) => {
        init = received
        return new Response(null, { status: 204 })
      },
    })
    setCsrfToken('csrf-3')
    await apiFetch('/api/lease', { method: 'DELETE', headers: { 'x-edit-lease': 'token-1', 'x-csrf-token': 'forged', 'accept': 'text/plain' }, keepalive: true }, () => undefined)
    expect(api.requests[0]?.headers).toMatchObject({ 'x-edit-lease': 'token-1', 'x-csrf-token': 'csrf-3', 'accept': 'application/json' })
    expect(init?.keepalive).toBe(true)
    await apiRequest('/api/lease', { method: 'DELETE', headers: { 'x-edit-lease': 'token-2' }, schema: z.undefined() })
    expect(api.requests[1]?.headers['x-edit-lease']).toBe('token-2')
    expect(init?.keepalive).toBeUndefined()
  })

  it('错误响应带上服务端回答的时刻（响应头 Date）；没有或读不出来时为 undefined', async () => {
    const body = { error: { code: 'EDIT_LEASE_HELD', message: '别人正在编辑', requestId: 'req-2' } }
    installFakeApi({
      'POST /api/dated': () => json(409, body, { date: 'Sun, 04 Oct 2026 03:00:00 GMT' }),
      'POST /api/undated': () => json(409, body),
      'POST /api/garbled': () => json(409, body, { date: 'yesterday-ish' }),
    })
    await expect(apiFetch('/api/dated', { method: 'POST' }, () => undefined)).rejects.toMatchObject({ serverTime: Date.UTC(2026, 9, 4, 3, 0, 0) })
    await expect(apiFetch('/api/undated', { method: 'POST' }, () => undefined)).rejects.toMatchObject({ code: 'EDIT_LEASE_HELD', serverTime: undefined })
    await expect(apiFetch('/api/garbled', { method: 'POST' }, () => undefined)).rejects.toMatchObject({ code: 'EDIT_LEASE_HELD', serverTime: undefined })
  })

  it('条件请求（acceptNotModified，M3-P2 设计 §3.2）：304 原样交回、不算失败；没说接受 304 时照常是失败', async () => {
    const api = installFakeApi({ 'GET /api/content': () => new Response(null, { status: 304, headers: { etag: '"3"' } }) })
    const result = await apiFetch('/api/content', { headers: { 'if-none-match': '"3"' }, acceptNotModified: true }, response => response.status)
    expect(result).toBe(304)
    expect(api.requests[0]?.headers).toMatchObject({ 'if-none-match': '"3"' })
    await expect(apiFetch('/api/content', { headers: { 'if-none-match': '"3"' } }, () => undefined)).rejects.toMatchObject({ status: 304, code: 'UNKNOWN' })
  })

  it('接受 304 只放过 304：别的失败照常抛出', async () => {
    installFakeApi({ 'GET /api/content': () => apiError(404, 'NOT_FOUND') })
    await expect(apiFetch('/api/content', { acceptNotModified: true }, () => undefined)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })

  it('成功的响应里服务端回答的时刻（serverTimeOf，编辑状态的最后活动按它算）：读响应头 Date；没有或读不出来时为 undefined', () => {
    expect(serverTimeOf(new Response(null, { headers: { date: 'Sun, 04 Oct 2026 03:00:00 GMT' } }))).toBe(Date.UTC(2026, 9, 4, 3, 0, 0))
    expect(serverTimeOf(new Response(null))).toBeUndefined()
    expect(serverTimeOf(new Response(null, { headers: { date: 'yesterday-ish' } }))).toBeUndefined()
  })
})

describe('readJson', () => {
  it('按契约读出正文；不一致时 ResponseFormatError，说明里带上是哪个请求', async () => {
    await expect(readJson(json(200, { name: 'x' }), itemSchema, 'GET /api/item')).resolves.toEqual({ name: 'x' })
    await expect(readJson(json(200, { name: 1 }), itemSchema, 'GET /api/item')).rejects.toThrow('GET /api/item 的响应与契约不一致')
  })
})

describe('错误的分类', () => {
  it('未登录与登录已过期要回到登录页', () => {
    expect(isAuthenticationError(new ApiError(401, 'UNAUTHENTICATED', 'x'))).toBe(true)
    expect(isAuthenticationError(new ApiError(401, 'SESSION_EXPIRED', 'x'))).toBe(true)
    expect(isAuthenticationError(new ApiError(401, 'INVALID_CREDENTIALS', 'x'))).toBe(false)
    expect(isAuthenticationError(new Error('x'))).toBe(false)
  })

  it('没有权限：只认 PERMISSION_DENIED', () => {
    expect(isPermissionDeniedError(new ApiError(403, 'PERMISSION_DENIED', 'x'))).toBe(true)
    expect(isPermissionDeniedError(new ApiError(403, 'CSRF_TOKEN_INVALID', 'x'))).toBe(false)
    expect(isPermissionDeniedError(new Error('x'))).toBe(false)
  })

  it('不存在或看不到：NOT_FOUND，以及地址里的 id 不合法（REQUEST_INVALID）；其他错误不算（审查 B13）', () => {
    expect(isMissingResource(new ApiError(404, 'NOT_FOUND', 'x'))).toBe(true)
    expect(isMissingResource(new ApiError(400, 'REQUEST_INVALID', 'x'))).toBe(true)
    expect(isMissingResource(new ApiError(403, 'PERMISSION_DENIED', 'x'))).toBe(false)
    expect(isMissingResource(new ApiError(500, 'INTERNAL_ERROR', 'x'))).toBe(false)
    expect(isMissingResource(new NetworkError('x'))).toBe(false)
  })

  it('按访问权限被拒绝：看不到（NOT_FOUND）与不能做（PERMISSION_DENIED）；请求内容不合法与其他错误不算（M2-P2 复验）', () => {
    expect(isAccessDenied(new ApiError(404, 'NOT_FOUND', 'x'))).toBe(true)
    expect(isAccessDenied(new ApiError(403, 'PERMISSION_DENIED', 'x'))).toBe(true)
    expect(isAccessDenied(new ApiError(400, 'REQUEST_INVALID', 'x'))).toBe(false)
    expect(isAccessDenied(new ApiError(409, 'SPACE_NAME_TAKEN', 'x'))).toBe(false)
    expect(isAccessDenied(new NetworkError('x'))).toBe(false)
  })

  it('网络失败与 5xx 可以重试，4xx 不重试', () => {
    expect(isTransientError(new NetworkError('x'))).toBe(true)
    expect(isTransientError(new ApiError(503, 'SERVICE_UNAVAILABLE', 'x'))).toBe(true)
    expect(isTransientError(new ApiError(404, 'NOT_FOUND', 'x'))).toBe(false)
    expect(isTransientError(new Error('x'))).toBe(false)
  })
})

describe('Retry-After（秒数或者 HTTP 日期）', () => {
  const respond = (headers: Record<string, string>): Response => new Response(null, { status: 503, headers })

  it.each<[string, Record<string, string>, number | undefined]>([
    ['秒数', { 'retry-after': '120' }, 120],
    ['HTTP 日期：按同一个响应的 Date 算出相隔几秒（向上取整）', { 'retry-after': 'Mon, 05 Oct 2026 08:01:30 GMT', 'date': 'Mon, 05 Oct 2026 08:00:00 GMT' }, 90],
    ['HTTP 日期、没有 Date：不拿浏览器的时钟比，不认（日期远在将来也不认）', { 'retry-after': 'Thu, 01 Jan 2099 00:00:00 GMT' }, undefined],
    ['HTTP 日期已经过了', { 'retry-after': 'Mon, 05 Oct 2026 07:59:00 GMT', 'date': 'Mon, 05 Oct 2026 08:00:00 GMT' }, undefined],
    ['0', { 'retry-after': '0' }, undefined],
    ['负数', { 'retry-after': '-5' }, undefined],
    ['读不出来', { 'retry-after': 'later' }, undefined],
    ['没有', {}, undefined],
  ])('%s', (_case, headers, expected) => {
    expect(retryAfterOf(respond(headers))).toBe(expected)
  })
})
