import type { Request, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { levelFor, requestSummary } from './http-logger.ts'

function request(originalUrl: string, route?: string): Request {
  return { method: 'GET', originalUrl, route: route === undefined ? undefined : { path: route } } as unknown as Request
}

function response(statusCode: number, options: { finished?: boolean, err?: Error } = {}): Response {
  return { statusCode, writableFinished: options.finished ?? true, err: options.err } as unknown as Response
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
