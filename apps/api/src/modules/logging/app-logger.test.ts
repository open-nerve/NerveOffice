import type { Request, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { AppLogger } from './app-logger.ts'
import { captureLogs } from './logging.test-support.ts'
import { RequestContextStore } from './request-context.ts'
import { createRootLogger } from './root-logger.ts'

function setup() {
  const logs = captureLogs()
  const root = createRootLogger({ level: 'debug', destination: logs.destination })
  const requestContext = new RequestContextStore()
  return { logs, root, requestContext, logger: new AppLogger(root, requestContext) }
}

describe('AppLogger', () => {
  it('消息在前、字段在后；各级别写到根日志', () => {
    const { logs, logger } = setup()
    logger.debug('调试', { step: 1 })
    logger.info('完成')
    logger.warn('注意', { count: 2 })
    logger.error('失败', { err: new Error('原因') })
    expect(logs.entries()).toMatchObject([
      { level: 'debug', msg: '调试', step: 1 },
      { level: 'info', msg: '完成' },
      { level: 'warn', msg: '注意', count: 2 },
      { level: 'error', msg: '失败', err: { message: '原因' } },
    ])
  })

  it('with() 带上固定字段，不影响原来的日志', () => {
    const { logs, logger } = setup()
    const audit = logger.with({ module: 'audit' })
    audit.info('写入', { action: 'x' })
    logger.info('原来的')
    expect(logs.entries()).toMatchObject([{ module: 'audit', action: 'x' }, { msg: '原来的' }])
    expect(logs.entries()[1]).not.toHaveProperty('module')
  })

  it('请求内写入该请求的子日志，带上请求标识；脱敏照常生效', () => {
    const { logs, root, requestContext, logger } = setup()
    const request = { id: 'req-7', log: root.child({ requestId: 'req-7' }) } as unknown as Request
    requestContext.middleware()(request, {} as Response, () => {
      logger.info('请求内', { password: 'p' })
    })
    expect(logs.entries()).toMatchObject([{ msg: '请求内', requestId: 'req-7', password: '[已脱敏]' }])
  })
})
