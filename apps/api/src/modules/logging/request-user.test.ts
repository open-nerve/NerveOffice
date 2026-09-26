import type { Request, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { captureLogs } from './logging.test-support.ts'
import { RequestContextStore } from './request-context.ts'
import { identifyRequestUser, requestUserId } from './request-user.ts'
import { createRootLogger } from './root-logger.ts'

describe('identifyRequestUser', () => {
  it('认证之后，请求上下文里取到的日志带上 userId；认证之前写的不带', () => {
    const logs = captureLogs()
    const root = createRootLogger({ level: 'info', destination: logs.destination })
    const request = { id: 'req-1', log: root.child({ requestId: 'req-1' }) } as unknown as Request
    const store = new RequestContextStore()
    store.middleware()(request, {} as Response, () => {
      store.current()?.logger.info('认证之前')
      identifyRequestUser(request, 'user-1')
      store.current()?.logger.info('认证之后')
    })
    expect(logs.entries().map(entry => [entry.msg, entry.requestId, entry.userId])).toEqual([
      ['认证之前', 'req-1', undefined],
      ['认证之后', 'req-1', 'user-1'],
    ])
    expect(requestUserId(request)).toBe('user-1')
  })

  it('没有认证的请求没有用户', () => {
    expect(requestUserId({} as Request)).toBeUndefined()
  })
})
