import type { ArgumentsHost } from '@nestjs/common'
import type { Request, Response } from 'express'
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { CommitLedger, LateTransactionStartError, POOL_TIMEOUT_MESSAGE } from '../modules/database/index.ts'
import { AppError } from '../shared/errors/app-error.ts'
import { DATABASE_BUSY_RETRY_AFTER_SECONDS, HttpErrorFilter, mapException } from './error-filter.ts'

/** 与 pg 的 DatabaseError 同样的形状，包在 drizzle 的错误里（消息与参数带着值，不能出现在响应里） */
function databaseError(code: string): Error {
  const cause = Object.assign(new Error(`canceling statement: 内部细节 ${code}`), { code, severity: 'ERROR' })
  return Object.assign(new Error('Failed query: select pg_advisory_xact_lock($1)\nparams: 内部细节', { cause }), { query: 'select pg_advisory_xact_lock($1)', params: ['内部细节'] })
}

describe('mapException', () => {
  it('AppError：它自己的错误码、状态与说明', () => {
    expect(mapException(new AppError('SERVICE_UNAVAILABLE', '正在退出'))).toEqual({ status: 503, code: 'SERVICE_UNAVAILABLE', message: '正在退出', unexpected: false, headers: {} })
  })

  it('AppError 带的详情原样带出；不带时没有这个字段', () => {
    const details = { currentRevision: 4, source: null }
    expect(mapException(new AppError('DOCUMENT_REVISION_CONFLICT', undefined, { details }))).toMatchObject({ status: 409, details })
    expect(mapException(new AppError('NOT_FOUND'))).not.toHaveProperty('details')
  })

  it('没有匹配的路由 → NOT_FOUND，用默认说明，不用框架的说明', () => {
    expect(mapException(new NotFoundException('Cannot GET /api/x'))).toEqual({ status: 404, code: 'NOT_FOUND', message: '请求的资源不存在或无权访问', unexpected: false, headers: {} })
  })

  it('框架换成的 400（例如非法的路径编码）→ REQUEST_INVALID，不回显原始说明', () => {
    const mapped = mapException(new BadRequestException('URI malformed: %E0%A4%A'))
    expect(mapped).toMatchObject({ status: 400, code: 'REQUEST_INVALID', unexpected: false })
    expect(mapped.message).not.toContain('%E0')
  })

  it('其他 HttpException 按意外错误处理：业务代码应当抛 AppError', () => {
    expect(mapException(new ForbiddenException())).toMatchObject({ status: 500, code: 'INTERNAL_ERROR', unexpected: true })
  })

  it('数据库繁忙（等锁超时、语句超时、超过事务的时限、取不到连接）→ 503 SERVICE_UNAVAILABLE 带 Retry-After，只回通用说明，不算意外错误（M2-P6 复核 A 的 G-2；事务的时限是 M3-P5 复验 C1）', () => {
    const busy = { status: 503, code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试', unexpected: false, headers: { 'Retry-After': String(DATABASE_BUSY_RETRY_AFTER_SECONDS) } }
    expect(mapException(databaseError('55P03'))).toEqual({ ...busy, busy: 'lock_timeout' })
    expect(mapException(databaseError('57014'))).toEqual({ ...busy, busy: 'statement_timeout' })
    expect(mapException(databaseError('25P04'))).toEqual({ ...busy, busy: 'transaction_timeout' })
    // 限时的事务开始得太晚、不开始（M3-P5 再复核 D1）：同样是超过事务的时限
    expect(mapException(new LateTransactionStartError(10_001, 10_000))).toEqual({ ...busy, busy: 'transaction_timeout' })
    expect(mapException(new Error(POOL_TIMEOUT_MESSAGE))).toEqual({ ...busy, busy: 'pool_timeout' })
    expect(DATABASE_BUSY_RETRY_AFTER_SECONDS).toBe(5)
    // 别的数据库错误（死锁、违反约束）仍是意外错误
    expect(mapException(databaseError('40P01'))).toMatchObject({ status: 500, code: 'INTERNAL_ERROR', unexpected: true })
    expect(mapException(databaseError('23505'))).not.toHaveProperty('busy')
    // 业务代码自己抛的 AppError 以它为准，即使原因是数据库繁忙
    expect(mapException(new AppError('NOT_FOUND', undefined, { cause: databaseError('55P03') }))).toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })

  it('这个请求里已经有事务提交过：数据库繁忙不再是"确定没有生效"，按意外错误回 500，不带 Retry-After；原因照样带出（M2-P6 第 3 片复验）', () => {
    const committed = { committed: true }
    const internal = { status: 500, code: 'INTERNAL_ERROR', message: '服务器内部错误，请稍后重试', unexpected: true, headers: {} }
    expect(mapException(databaseError('55P03'), committed)).toEqual({ ...internal, busy: 'lock_timeout' })
    expect(mapException(databaseError('57014'), committed)).toEqual({ ...internal, busy: 'statement_timeout' })
    expect(mapException(new Error(POOL_TIMEOUT_MESSAGE), committed)).toEqual({ ...internal, busy: 'pool_timeout' })
    // 还没有提交过：照旧 503
    expect(mapException(databaseError('55P03'), { committed: false })).toMatchObject({ status: 503, unexpected: false, busy: 'lock_timeout' })
    // 与繁忙无关的回答不受影响
    expect(mapException(new AppError('NOT_FOUND'), committed)).toEqual(mapException(new AppError('NOT_FOUND')))
    expect(mapException(new Error('别的'), committed)).toEqual(mapException(new Error('别的')))
  })

  it('其他异常 → INTERNAL_ERROR，只回通用说明', () => {
    expect(mapException(new Error('数据库密码是 hunter2'))).toEqual({ status: 500, code: 'INTERNAL_ERROR', message: '服务器内部错误，请稍后重试', unexpected: true, headers: {} })
    expect(mapException('抛出的是字符串')).toMatchObject({ code: 'INTERNAL_ERROR', unexpected: true })
  })
})

interface FakeResponse {
  headersSent: boolean
  writableEnded: boolean
  destroyed: boolean
  statusCode?: number
  body?: unknown
  err?: Error
  headers: Record<string, string>
  setHeader: (name: string, value: string) => void
  status: (code: number) => FakeResponse
  json: (body: unknown) => void
  destroy: () => void
}

function fakeResponse(headersSent = false, closed = false): FakeResponse {
  const response: FakeResponse = {
    headersSent,
    writableEnded: false,
    destroyed: closed,
    headers: {},
    setHeader: (name, value) => {
      response.headers[name] = value
    },
    status: (code) => {
      response.statusCode = code
      return response
    },
    json: (body) => {
      response.body = body
    },
    destroy: vi.fn(),
  }
  return response
}

function hostFor(request: object, response: FakeResponse): ArgumentsHost {
  return { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as unknown as ArgumentsHost
}

/** 在一个请求的记录里执行 work（与 HTTP 管线里同一个中间件）；committed 为真时先记一笔提交 */
function inRequest(commits: CommitLedger, committed: boolean, work: () => void): void {
  commits.middleware()({} as Request, {} as Response, () => {
    if (committed)
      commits.recordCommit()
    work()
  })
}

describe('HttpErrorFilter', () => {
  const commits = new CommitLedger()
  const filter = new HttpErrorFilter(commits)

  it('AppError 带的响应头随错误响应下发', () => {
    const response = fakeResponse()
    filter.catch(new AppError('TOO_MANY_ATTEMPTS', undefined, { headers: { 'Retry-After': '120' } }), hostFor({ id: 'req-0' }, response))
    expect(response.statusCode).toBe(429)
    expect(response.headers).toEqual({ 'Retry-After': '120' })
  })

  it('写出统一的错误响应，带请求标识', () => {
    const response = fakeResponse()
    filter.catch(new AppError('NOT_FOUND'), hostFor({ id: 'req-1' }, response))
    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ error: { code: 'NOT_FOUND', message: '请求的资源不存在或无权访问', requestId: 'req-1' } })
    expect(response.err).toBeUndefined()
  })

  it('AppError 带了详情时，错误响应里加上 details', () => {
    const response = fakeResponse()
    const details = { currentRevision: 7, source: { clientInstanceId: '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d', localSeq: 3 } }
    filter.catch(new AppError('DOCUMENT_REVISION_CONFLICT', undefined, { details }), hostFor({ id: 'req-d' }, response))
    expect(response.statusCode).toBe(409)
    expect(response.body).toEqual({ error: { code: 'DOCUMENT_REVISION_CONFLICT', message: '别处保存了更新的版本，本次保存没有写入', requestId: 'req-d', details } })
  })

  it('意外错误把异常挂到 response.err，由请求日志记下异常与堆栈', () => {
    const error = new Error('内部细节')
    const response = fakeResponse()
    filter.catch(error, hostFor({ id: 'req-2' }, response))
    expect(response.statusCode).toBe(500)
    expect(response.err).toBe(error)
    expect(JSON.stringify(response.body)).not.toContain('内部细节')
  })

  it('数据库繁忙：503 带 Retry-After，响应里没有数据库的细节；不挂 response.err，记一条 warn（原因与数据库报的错），不记 error', () => {
    const response = fakeResponse()
    const log = { warn: vi.fn(), error: vi.fn() }
    const error = databaseError('55P03')
    filter.catch(error, hostFor({ id: 'req-busy', log }, response))
    expect(response.statusCode).toBe(503)
    expect(response.headers).toEqual({ 'Retry-After': '5' })
    expect(response.body).toEqual({ error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试', requestId: 'req-busy' } })
    expect(JSON.stringify(response.body)).not.toMatch(/内部细节|55P03|advisory|lock/)
    expect(response.err).toBeUndefined()
    expect(log.warn).toHaveBeenCalledExactlyOnceWith({ err: error, reason: 'lock_timeout' }, expect.stringContaining('数据库繁忙'))
    expect(log.error).not.toHaveBeenCalled()
  })

  it('同一个请求里已经有事务提交过再遇到数据库繁忙：500（结果未知），不带 Retry-After；挂上 response.err，error 由请求日志据此记一条；这里只记一条 warn（写明是提交之后、带着原因），不另记 error（M2-P6 第 3 片复验）', () => {
    const response = fakeResponse()
    const log = { warn: vi.fn(), error: vi.fn() }
    const error = databaseError('55P03')
    inRequest(commits, true, () => filter.catch(error, hostFor({ id: 'req-after-commit', log }, response)))
    expect(response.statusCode).toBe(500)
    expect(response.headers).toEqual({})
    expect(response.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误，请稍后重试', requestId: 'req-after-commit' } })
    expect(response.err).toBe(error)
    expect(log.warn).toHaveBeenCalledExactlyOnceWith({ err: error, reason: 'lock_timeout' }, expect.stringContaining('事务提交之后遇到数据库繁忙'))
    expect(log.error).not.toHaveBeenCalled()
  })

  it('请求里还没有事务提交过：数据库繁忙照旧 503（记录是按请求的：前一个请求提交过不算）', () => {
    const response = fakeResponse()
    const log = { warn: vi.fn(), error: vi.fn() }
    inRequest(commits, true, () => {})
    inRequest(commits, false, () => filter.catch(databaseError('57014'), hostFor({ id: 'req-before-commit', log }, response)))
    expect(response.statusCode).toBe(503)
    expect(response.headers).toEqual({ 'Retry-After': '5' })
    expect(log.error).not.toHaveBeenCalled()
  })

  it('提交之后遇到数据库繁忙而连接已经关闭：不写响应；warn 写明是提交之后与原因，error 与其他意外错误一样记一条"请求中断之后处理失败"', () => {
    const log = { warn: vi.fn(), error: vi.fn() }
    const error = new Error(POOL_TIMEOUT_MESSAGE)
    const response = fakeResponse(false, true)
    inRequest(commits, true, () => filter.catch(error, hostFor({ id: 'req-after-commit-2', log }, response)))
    expect(response.body).toBeUndefined()
    expect(log.warn).toHaveBeenCalledExactlyOnceWith({ err: error, reason: 'pool_timeout' }, expect.stringContaining('事务提交之后遇到数据库繁忙'))
    expect(log.error).toHaveBeenCalledExactlyOnceWith({ err: error }, '请求中断之后处理失败')
  })

  it('数据库繁忙而连接已经关闭：不写响应，warn 照样记下', () => {
    const log = { warn: vi.fn(), error: vi.fn() }
    filter.catch(new Error(POOL_TIMEOUT_MESSAGE), hostFor({ id: 'req-busy-2', log }, fakeResponse(false, true)))
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: 'pool_timeout' }), expect.stringContaining('数据库繁忙'))
    expect(log.error).not.toHaveBeenCalled()
  })

  it('抛出的不是 Error 时包成 Error，原值放在 cause 里', () => {
    const response = fakeResponse()
    filter.catch({ weird: true }, hostFor({ id: 'req-3' }, response))
    expect(response.err?.cause).toEqual({ weird: true })
  })

  it('响应已经开始发送时断开连接', () => {
    const response = fakeResponse(true)
    filter.catch(new Error('写到一半'), hostFor({ id: 'req-4' }, response))
    expect(response.destroy).toHaveBeenCalledOnce()
    expect(response.body).toBeUndefined()
  })

  it('连接已经关闭（客户端中途断开）：不写响应；意外错误记进这个请求的日志，不被吞掉', () => {
    const response = fakeResponse(false, true)
    const log = { error: vi.fn() }
    const error = new Error('断开之后处理失败')
    filter.catch(error, hostFor({ id: 'req-5', log }, response))
    expect(response.body).toBeUndefined()
    expect(log.error).toHaveBeenCalledWith({ err: error }, '请求中断之后处理失败')
    filter.catch(new AppError('NOT_FOUND'), hostFor({ id: 'req-6', log }, fakeResponse(false, true)))
    expect(log.error).toHaveBeenCalledOnce()
  })

  it('万一没有请求标识，仍给出合法的错误响应', () => {
    const response = fakeResponse()
    filter.catch(new AppError('REQUEST_INVALID'), hostFor({}, response))
    expect(response.body).toMatchObject({ error: { requestId: 'unknown' } })
  })
})
