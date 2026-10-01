import { describe, expect, it } from 'vitest'
import { LOGGED_QUERY_MAX_LENGTH, safeErrorMessage, serializeError, truncatedQuery } from './error-serializer.ts'
import { drizzleError, pgError, SECRET_VALUE } from './logging.test-support.ts'

describe('serializeError', () => {
  it('数据库错误只留类型、带占位符的 SQL、SQLSTATE 与表名；参数、detail、带值的消息都不写', () => {
    const serialized = serializeError(drizzleError())
    expect(serialized).toMatchObject({
      type: 'DrizzleQueryError',
      message: '数据库查询失败',
      query: 'select $1::uuid',
      paramCount: 1,
      cause: { type: 'DatabaseError', sqlState: '22P02', table: 'audit_events', routine: 'string_to_uuid' },
    })
    expect(JSON.stringify(serialized)).not.toContain(SECRET_VALUE)
  })

  it('很长的 SQL 只留开头（LOGGED_QUERY_MAX_LENGTH 个字符）并注明原来的长度；参数只记个数（M2-P6 复核 A 的 G-7）', () => {
    // 一串 id 展开成几万个参数的语句：开头足以定位是哪一处
    const placeholders = Array.from({ length: 65_536 }, (_, index) => `$${index + 1}`).join(', ')
    const query = `delete from "documents" where "documents"."id" in (${placeholders})`
    const error = Object.assign(new Error(`Failed query: ${query}\nparams: ${SECRET_VALUE}`), { query, params: Array.from({ length: 65_536 }).fill(SECRET_VALUE) })
    const serialized = serializeError(error) as Record<string, unknown>
    const logged = String(serialized.query)
    expect(logged.startsWith('delete from "documents" where "documents"."id" in ($1, $2, ')).toBe(true)
    expect(logged).toBe(`${query.slice(0, LOGGED_QUERY_MAX_LENGTH)}…（已截断，共 ${query.length} 个字符）`)
    expect(logged.length).toBeLessThan(LOGGED_QUERY_MAX_LENGTH + 40)
    expect(serialized.paramCount).toBe(65_536)
    expect(JSON.stringify(serialized)).not.toContain(SECRET_VALUE)
  })

  it('原因里的 SQL 同样截断：事务运行器等外层把数据库的错误包在 cause 里，那一层的语句照样只留开头（M2-P6 第 3 片复验）', () => {
    const query = `select * from "documents" where "documents"."id" in (${Array.from({ length: 10_000 }, (_, index) => `$${index + 1}`).join(', ')})`
    const inner = Object.assign(new Error(`Failed query: ${query}`), { query, params: [SECRET_VALUE] })
    const serialized = serializeError(new Error('外层', { cause: new Error('中间', { cause: inner }) })) as { cause: { cause: { query: string, paramCount: number } } }
    expect(serialized.cause.cause.query).toBe(`${query.slice(0, LOGGED_QUERY_MAX_LENGTH)}…（已截断，共 ${query.length} 个字符）`)
    expect(serialized.cause.cause.paramCount).toBe(1)
    expect(JSON.stringify(serialized)).not.toContain(SECRET_VALUE)
  })

  it('不超过上限的 SQL 原样保留', () => {
    expect(LOGGED_QUERY_MAX_LENGTH).toBe(4_096)
    const exact = 'x'.repeat(LOGGED_QUERY_MAX_LENGTH)
    expect(truncatedQuery(exact)).toBe(exact)
    expect(truncatedQuery(`${exact}y`)).toBe(`${exact}…（已截断，共 ${LOGGED_QUERY_MAX_LENGTH + 1} 个字符）`)
  })

  it('其他异常保留类型、消息、堆栈与自己的属性，原因逐层处理', () => {
    const error = Object.assign(new Error('外层', { cause: pgError() }), { code: 'E_OUTER' })
    const serialized = serializeError(error) as Record<string, unknown>
    expect(serialized).toMatchObject({ type: 'Error', message: '外层', code: 'E_OUTER', cause: { type: 'DatabaseError', sqlState: '22P02' } })
    expect(String(serialized.stack)).toContain('外层')
    expect(JSON.stringify(serialized)).not.toContain(SECRET_VALUE)
  })

  it('原因链有上限，不会无限展开', () => {
    let error = new Error('底层')
    for (let level = 0; level < 20; level++)
      error = new Error(`第 ${level} 层`, { cause: error })
    expect(JSON.stringify(serializeError(error)).match(/"type"/g)?.length).toBeLessThanOrEqual(6)
  })

  it('抛出的不是 Error 时原样返回', () => {
    expect(serializeError('字符串')).toBe('字符串')
  })
})

describe('safeErrorMessage', () => {
  it('数据库错误换成不带值的说明，其他异常原样', () => {
    expect(safeErrorMessage(drizzleError())).toBe('数据库查询失败')
    expect(safeErrorMessage(pgError())).toBe('数据库报错（SQLSTATE 22P02）')
    expect(safeErrorMessage(new Error('普通的错误'))).toBe('普通的错误')
  })
})
