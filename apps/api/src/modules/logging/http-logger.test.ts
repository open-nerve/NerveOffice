import type { Request, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { levelFor, requestSummary } from './http-logger.ts'

function request(originalUrl: string, route?: string): Request {
  return { method: 'GET', originalUrl, route: route === undefined ? undefined : { path: route } } as unknown as Request
}

function response(statusCode: number, options: { finished?: boolean, err?: Error, headers?: Record<string, string> } = {}): Response {
  // 响应头按小写的名字取（Node 的 getHeader 不区分大小写）
  const headers = new Map(Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]))
  return { statusCode, writableFinished: options.finished ?? true, err: options.err, getHeader: (name: string) => headers.get(name.toLowerCase()) } as unknown as Response
}

describe('levelFor', () => {
  it.each([
    ['/api/documents', response(200), false, 'info'],
    ['/api/documents', response(404), false, 'warn'],
    ['/api/documents', response(500), false, 'error'],
    ['/api/documents', response(200), true, 'error'],
    ['/api/documents', response(200, { err: new Error('响应头发出后出错') }), false, 'error'],
    ['/api/documents', response(200, { finished: false }), false, 'warn'],
    ['/api/health/live', response(200), false, 'silent'],
    ['/api/health/ready?x=1', response(200), false, 'silent'],
    ['/api/health/ready', response(503), false, 'error'],
    // 服务端按约定回答的"繁忙，稍后重试"（503 带 Retry-After：数据库繁忙、等待密码哈希的请求太多）记 warn，不是故障（M2-P6 复核 A 的 G-2）
    ['/api/folders/x', response(503, { headers: { 'Retry-After': '5' } }), false, 'warn'],
    ['/api/auth/login', response(503, { headers: { 'retry-after': '1' } }), false, 'warn'],
    // 带 Retry-After 的不是 503、或者有意外错误时照旧
    ['/api/documents', response(500, { headers: { 'Retry-After': '5' } }), false, 'error'],
    ['/api/documents', response(503, { headers: { 'Retry-After': '5' }, err: new Error('写到一半') }), false, 'error'],
    ['/api/documents', response(503, { headers: { 'Retry-After': '5' } }), true, 'error'],
    ['/api/health/live', response(200, { finished: false }), false, 'warn'],
    // 前端的静态文件与页面：成功记 debug，失败照常
    ['/assets/index-abc.js', response(200), false, 'debug'],
    ['/login', response(304), false, 'debug'],
    ['/assets/missing.js', response(404), false, 'warn'],
  ] as const)('%s（%#）', (url, res, failed, level) => {
    expect(levelFor(request(url), res, failed)).toBe(level)
  })
})

describe('requestSummary', () => {
  it('方法、路由模板、不含查询串的路径、状态码与耗时', () => {
    const summary = requestSummary(request('/api/documents/42?token=secret', '/api/documents/:id'), response(200), 12)
    expect(summary).toEqual({ method: 'GET', route: '/api/documents/:id', path: '/api/documents/42', statusCode: 200, durationMs: 12 })
    expect(JSON.stringify(summary)).not.toContain('secret')
  })

  it('没有匹配的路由时路由模板为空', () => {
    expect(requestSummary(request('/api/nope'), response(404), 1).route).toBeUndefined()
  })

  it('中断的请求不记状态码（只是默认值），另记 aborted', () => {
    expect(requestSummary(request('/api/documents'), response(200, { finished: false }), 5)).toEqual({ method: 'GET', route: undefined, path: '/api/documents', aborted: true, durationMs: 5 })
  })
})
