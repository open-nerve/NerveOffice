// 数据库繁忙的识别（M2-P6 复核 A 的 G-2）：等锁超时、语句被取消、连接池等不到空闲连接；包在 drizzle 的错误里也认得出。
// 真实的数据库与连接池报出的错误由集成测试 api/database-busy.test.ts 核对，这里用同样形状的对象。
import { describe, expect, it } from 'vitest'
import { databaseBusyReasonOf, POOL_TIMEOUT_MESSAGE } from './busy-errors.ts'

/** 与 pg 的 DatabaseError 同样的形状：SQLSTATE 与 severity */
function pgError(code: string, severity = 'ERROR'): Error {
  return Object.assign(new Error(`数据库报错 ${code}`), { code, severity })
}

/** drizzle 把驱动的错误包一层，原来的错误在 cause 里 */
function drizzleError(cause: unknown): Error {
  return Object.assign(new Error('Failed query: select 1\nparams: ', { cause }), { query: 'select 1', params: [] })
}

describe('databaseBusyReasonOf', () => {
  it('等锁超时（55P03）、语句被取消（57014）、超过事务的时限（25P04，数据库随之结束会话：严重级别 FATAL，M3-P5 复验 C1）、连接池等不到空闲连接', () => {
    expect(databaseBusyReasonOf(pgError('55P03'))).toBe('lock_timeout')
    expect(databaseBusyReasonOf(pgError('57014'))).toBe('statement_timeout')
    expect(databaseBusyReasonOf(pgError('25P04', 'FATAL'))).toBe('transaction_timeout')
    expect(databaseBusyReasonOf(drizzleError(pgError('25P04', 'FATAL')))).toBe('transaction_timeout')
    expect(databaseBusyReasonOf(new Error(POOL_TIMEOUT_MESSAGE))).toBe('pool_timeout')
  })

  it('包在 drizzle 的错误、再包一层的错误里也认得出', () => {
    expect(databaseBusyReasonOf(drizzleError(pgError('55P03')))).toBe('lock_timeout')
    expect(databaseBusyReasonOf(new Error('外层', { cause: drizzleError(pgError('57014')) }))).toBe('statement_timeout')
    // 连接池上的查询（事务外）取不到连接：drizzle 包着连接池的错误
    expect(databaseBusyReasonOf(drizzleError(new Error(POOL_TIMEOUT_MESSAGE)))).toBe('pool_timeout')
  })

  it('别的数据库错误不算繁忙：死锁（按锁的顺序不会成环，出现就是缺陷）、事务已中止、违反约束、连接断开', () => {
    // 事务中空闲超时（25P03）同样结束会话，但它说明客户端在事务里停住了（缺陷或进程卡住），不是数据库忙：照旧按意外错误
    for (const code of ['40P01', '25P02', '23505', '23514', '57P01', '08006', '25P03'])
      expect(databaseBusyReasonOf(drizzleError(pgError(code))), code).toBeUndefined()
    // 找到数据库报的错误就以它为准，不再往下找
    expect(databaseBusyReasonOf(Object.assign(pgError('25P02'), { cause: pgError('55P03') }))).toBeUndefined()
  })

  it('说明一样但带着错误码的（不是连接池给的）、连接数据库超时、普通的错误与不是错误的值都不算', () => {
    expect(databaseBusyReasonOf(Object.assign(new Error(POOL_TIMEOUT_MESSAGE), { code: 'E_OTHER' }))).toBeUndefined()
    expect(databaseBusyReasonOf(new Error('Connection terminated due to connection timeout'))).toBeUndefined()
    expect(databaseBusyReasonOf(new Error('内部细节'))).toBeUndefined()
    expect(databaseBusyReasonOf('55P03')).toBeUndefined()
    expect(databaseBusyReasonOf(undefined)).toBeUndefined()
    // 带着五位的 code 却不是数据库的错误（没有 severity）
    expect(databaseBusyReasonOf(Object.assign(new Error('x'), { code: '55P03' }))).toBeUndefined()
  })

  it('原因链有上限：埋得太深的不再找（不会无限展开成环的链）', () => {
    let error: Error = pgError('55P03')
    for (let level = 0; level < 10; level += 1)
      error = new Error(`第 ${level} 层`, { cause: error })
    expect(databaseBusyReasonOf(error)).toBeUndefined()
    const cyclic = new Error('自己是自己的原因')
    cyclic.cause = cyclic
    expect(databaseBusyReasonOf(cyclic)).toBeUndefined()
  })
})
