import { describe, expect, it } from 'vitest'
import { safeErrorMessage, serializeError } from './error-serializer.ts'
import { drizzleError, pgError, SECRET_VALUE } from './logging.test-support.ts'

describe('serializeError', () => {
  it('数据库错误只留类型、带占位符的 SQL、SQLSTATE 与表名；参数、detail、带值的消息都不写', () => {
    const serialized = serializeError(drizzleError())
    expect(serialized).toMatchObject({
      type: 'DrizzleQueryError',
      message: '数据库查询失败',
      query: 'select $1::uuid',
      cause: { type: 'DatabaseError', sqlState: '22P02', table: 'audit_events', routine: 'string_to_uuid' },
    })
    expect(JSON.stringify(serialized)).not.toContain(SECRET_VALUE)
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
