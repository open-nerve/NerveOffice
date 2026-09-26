// 测试用：假的 fetch，按"方法 路径"返回响应。没有登记的请求让测试失败，免得悄悄走到真实网络。
import { vi } from 'vitest'

export type Handler = (init: RequestInit | undefined) => Response | Promise<Response>

export interface FakeApi {
  /** 登记或替换一个接口的响应 */
  on: (key: string, handler: Handler) => void
  /** 收到的请求（方法、路径、请求头） */
  readonly requests: { key: string, headers: Record<string, string>, body: unknown }[]
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

export function apiError(status: number, code: string, message = '说明', headers: Record<string, string> = {}): Response {
  return json(status, { error: { code, message, requestId: `req-${code.toLowerCase()}` } }, headers)
}

export function installFakeApi(handlers: Record<string, Handler> = {}): FakeApi {
  const table = new Map(Object.entries(handlers))
  const requests: FakeApi['requests'] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? `${input.pathname}${input.search}` : input.url
    const key = `${init?.method ?? 'GET'} ${path}`
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    requests.push({ key, headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined })
    const handler = table.get(key)
    if (handler === undefined)
      throw new Error(`没有登记的请求：${key}`)
    return handler(init)
  }))
  return { on: (key, handler) => table.set(key, handler), requests }
}
