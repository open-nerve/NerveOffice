import type { ArgumentsHost } from '@nestjs/common'
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../shared/errors/app-error.ts'
import { HttpErrorFilter, mapException } from './error-filter.ts'

describe('mapException', () => {
  it('AppError：它自己的错误码、状态与说明', () => {
    expect(mapException(new AppError('SERVICE_UNAVAILABLE', '正在退出'))).toEqual({ status: 503, code: 'SERVICE_UNAVAILABLE', message: '正在退出', unexpected: false, headers: {} })
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

describe('HttpErrorFilter', () => {
  const filter = new HttpErrorFilter()

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

  it('意外错误把异常挂到 response.err，由请求日志记下异常与堆栈', () => {
    const error = new Error('内部细节')
    const response = fakeResponse()
    filter.catch(error, hostFor({ id: 'req-2' }, response))
    expect(response.statusCode).toBe(500)
    expect(response.err).toBe(error)
    expect(JSON.stringify(response.body)).not.toContain('内部细节')
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
