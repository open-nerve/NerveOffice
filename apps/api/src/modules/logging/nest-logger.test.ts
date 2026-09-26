import type { Request, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { captureLogs, drizzleError, SECRET_VALUE } from './logging.test-support.ts'
import { contextAndStack, NestPinoLogger } from './nest-logger.ts'
import { RequestContextStore } from './request-context.ts'
import { createRootLogger } from './root-logger.ts'

const STACK = 'Error: 出错了\n    at run (file.ts:1:1)'
const FRAMES = '    at run (file.ts:1:1)'

describe('contextAndStack', () => {
  it.each([
    ['info', [], {}],
    ['info', ['AppModule'], { context: 'AppModule' }],
    ['info', [{ extra: 1 }, 'AppModule'], { context: 'AppModule' }],
    ['error', [STACK, 'ExceptionsHandler'], { stack: FRAMES, context: 'ExceptionsHandler' }],
    ['error', [STACK], { stack: FRAMES }],
    ['error', ['ExceptionsHandler'], { context: 'ExceptionsHandler' }],
    ['fatal', [], {}],
  ] as const)('%s %j', (level, params, expected) => {
    expect(contextAndStack(level, params)).toEqual(expected)
  })
})

describe('NestPinoLogger', () => {
  function setup(level: 'info' | 'trace' = 'trace') {
    const logs = captureLogs()
    const root = createRootLogger({ level, destination: logs.destination })
    const requestContext = new RequestContextStore()
    return { logs, root, requestContext, logger: new NestPinoLogger(root, requestContext) }
  }

  it('Nest 的级别映射到 pino，上下文写成字段', () => {
    const { logs, logger } = setup()
    logger.log('已启动', 'NestApplication')
    logger.warn('注意')
    logger.debug('调试')
    logger.verbose('详细')
    expect(logs.entries().map(entry => [entry.level, entry.msg, entry.context])).toEqual([
      ['info', '已启动', 'NestApplication'],
      ['warn', '注意', undefined],
      ['debug', '调试', undefined],
      ['trace', '详细', undefined],
    ])
  })

  it('error 与 fatal 带上堆栈；Error 对象写成 err', () => {
    const { logs, logger } = setup()
    logger.error('处理失败', STACK, 'ExceptionsHandler')
    logger.fatal(new Error('无法继续'))
    const [first, second] = logs.entries()
    expect(first).toMatchObject({ level: 'error', msg: '处理失败', stack: FRAMES, context: 'ExceptionsHandler' })
    expect(second).toMatchObject({ level: 'fatal', msg: '无法继续', err: { message: '无法继续' } })
  })

  it('数据库错误不带参数：Error 的消息换成不带值的说明，堆栈参数只留调用帧（复验 N4）', () => {
    const { logs, logger } = setup()
    const error = drizzleError()
    logger.error(error)
    logger.error('处理失败', error.stack, 'ExceptionsHandler')
    const [first, second] = logs.entries()
    expect(first).toMatchObject({ level: 'error', msg: '数据库查询失败', err: { type: 'DrizzleQueryError' } })
    expect(second).toMatchObject({ level: 'error', msg: '处理失败', context: 'ExceptionsHandler' })
    expect(String(second?.stack)).toMatch(/^\s+at /)
    expect(JSON.stringify(logs.entries())).not.toContain(SECRET_VALUE)
  })

  it('对象消息的字段合并进日志；其他类型的消息转成文字', () => {
    const { logs, logger } = setup()
    logger.log({ msg: '结构化', count: 2 }, 'Ctx')
    logger.log(42)
    expect(logs.entries()).toMatchObject([{ msg: '结构化', count: 2, context: 'Ctx' }, { msg: '42' }])
  })

  it('请求内写入这个请求的子日志，带上请求标识', () => {
    const { logs, root, requestContext, logger } = setup()
    const request = { id: 'req-9', log: root.child({ requestId: 'req-9' }) } as unknown as Request
    requestContext.middleware()(request, {} as Response, () => {
      logger.log('请求内')
    })
    logger.log('请求外')
    expect(logs.entries().map(entry => [entry.msg, entry.requestId])).toEqual([['请求内', 'req-9'], ['请求外', undefined]])
  })

  it('级别关闭时不写', () => {
    const { logs, logger } = setup('info')
    logger.debug('不输出')
    logger.verbose('不输出')
    expect(logs.entries()).toEqual([])
  })
})
