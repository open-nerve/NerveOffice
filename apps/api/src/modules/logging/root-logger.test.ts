import { describe, expect, it } from 'vitest'
import { captureLogs, drizzleError, pgError, SECRET_VALUE } from './logging.test-support.ts'
import { createRootLogger, REDACTED_KEYS, REDACTION_CENSOR } from './root-logger.ts'

describe('createRootLogger', () => {
  it('JSON，每行一条：ISO 8601 的时间、文字的级别与消息', () => {
    const logs = captureLogs()
    createRootLogger({ level: 'info', destination: logs.destination }).info({ port: 3000 }, 'HTTP 服务已启动')
    const [entry] = logs.entries()
    expect(entry).toMatchObject({ level: 'info', msg: 'HTTP 服务已启动', port: 3000 })
    expect(new Date(String(entry?.time)).toISOString()).toBe(entry?.time)
  })

  it('按配置的级别过滤', () => {
    const logs = captureLogs()
    const logger = createRootLogger({ level: 'warn', destination: logs.destination })
    logger.info('不输出')
    logger.warn('输出')
    expect(logs.entries().map(entry => entry.msg)).toEqual(['输出'])
  })

  it('脱敏：顶层、一层与两层嵌套里的敏感键名', () => {
    const logs = captureLogs()
    createRootLogger({ level: 'info', destination: logs.destination }).info({
      password: 'p1',
      user: { name: '张三', token: 't1', profile: { secret: 's1' } },
      safe: 'ok',
    }, '登录')
    expect(logs.entries()[0]).toMatchObject({
      password: REDACTION_CENSOR,
      user: { name: '张三', token: REDACTION_CENSOR, profile: { secret: REDACTION_CENSOR } },
      safe: 'ok',
    })
  })

  it('err 字段里的数据库错误不带参数与行里的值：根日志与子日志都经同一个序列化（复验 N3）', () => {
    const logs = captureLogs()
    const root = createRootLogger({ level: 'info', destination: logs.destination })
    root.error({ err: drizzleError() }, '查询失败')
    root.child({ requestId: 'req-1' }).error({ err: drizzleError() }, '查询失败')
    const entries = logs.entries()
    expect(entries).toHaveLength(2)
    for (const entry of entries)
      expect(entry).toMatchObject({ err: { type: 'DrizzleQueryError', message: '数据库查询失败', query: 'select $1::uuid' } })
    expect(JSON.stringify(entries)).not.toContain(SECRET_VALUE)
  })

  it('只传异常、不给消息时，数据库错误的消息同样换成不带值的说明（复验 F4）', () => {
    const logs = captureLogs()
    const root = createRootLogger({ level: 'info', destination: logs.destination })
    root.error({ err: drizzleError() })
    root.error(pgError())
    root.child({ requestId: 'req-1' }).error({ err: pgError() })
    expect(logs.entries().map(entry => entry.msg)).toEqual(['数据库查询失败', '数据库报错（SQLSTATE 22P02）', '数据库报错（SQLSTATE 22P02）'])
    expect(JSON.stringify(logs.entries())).not.toContain(SECRET_VALUE)
  })

  it('其他写法不变：普通异常用它自己的消息；给了消息就用给的；没有异常时不补消息', () => {
    const logs = captureLogs()
    const root = createRootLogger({ level: 'info', destination: logs.destination })
    root.error(new Error('普通的错误'))
    root.error({ err: pgError() }, '写入失败')
    root.info({ port: 3000 })
    root.info('只有消息')
    const [plain, given, noError, onlyMessage] = logs.entries()
    expect(plain).toMatchObject({ msg: '普通的错误', err: { message: '普通的错误' } })
    expect(given).toMatchObject({ msg: '写入失败', err: { sqlState: '22P02' } })
    expect(noError).not.toHaveProperty('msg')
    expect(onlyMessage).toMatchObject({ msg: '只有消息' })
  })

  it.each(REDACTED_KEYS)('清单里的 %s 在各层都被脱敏', (key) => {
    const logs = captureLogs()
    createRootLogger({ level: 'info', destination: logs.destination }).info({ [key]: 'v', a: { [key]: 'v', b: { [key]: 'v' } } })
    const line = JSON.stringify(logs.entries()[0])
    expect(line).not.toContain('"v"')
  })
})
