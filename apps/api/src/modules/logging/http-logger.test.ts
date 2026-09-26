import type { Request, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { levelFor, requestSummary } from './http-logger.ts'

function request(originalUrl: string, route?: string): Request {
  return { method: 'GET', originalUrl, route: route === undefined ? undefined : { path: route } } as unknown as Request
}

describe('levelFor', () => {
  it.each([
    ['/api/documents', 200, false, 'info'],
    ['/api/documents', 404, false, 'warn'],
    ['/api/documents', 500, false, 'error'],
    ['/api/documents', 200, true, 'error'],
    ['/api/health/live', 200, false, 'silent'],
    ['/api/health/ready?x=1', 200, false, 'silent'],
    ['/api/health/ready', 503, false, 'error'],
  ] as const)('%s %d（出错：%s）记 %s', (url, status, failed, level) => {
    expect(levelFor(request(url), status, failed)).toBe(level)
  })
})

describe('requestSummary', () => {
  it('方法、路由模板、不含查询串的路径、状态码与耗时', () => {
    const summary = requestSummary(request('/api/documents/42?token=secret', '/api/documents/:id'), { statusCode: 200 } as Response, 12)
    expect(summary).toEqual({ method: 'GET', route: '/api/documents/:id', path: '/api/documents/42', statusCode: 200, durationMs: 12 })
    expect(JSON.stringify(summary)).not.toContain('secret')
  })

  it('没有匹配的路由时路由模板为空', () => {
    expect(requestSummary(request('/api/nope'), { statusCode: 404 } as Response, 1).route).toBeUndefined()
  })
})
