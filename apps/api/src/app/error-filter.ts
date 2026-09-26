import type { ErrorCode, ErrorResponse } from '@nerve-office/contracts'
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common'
import type { Request, Response } from 'express'
import { ERROR_CODES } from '@nerve-office/contracts'
import { Catch, HttpException } from '@nestjs/common'
import { AppError } from '../shared/errors/app-error.ts'

export interface MappedError {
  readonly status: number
  readonly code: ErrorCode
  readonly message: string
  /** 意外错误：异常与堆栈写进请求日志 */
  readonly unexpected: boolean
}

/**
 * 框架抛出的客户端错误，按 HTTP 状态映射到登记的错误码：
 * 没有匹配的路由（404），以及 Nest 把非法的请求路径编码（URIError）换成的 400。
 */
const FRAMEWORK_CLIENT_ERRORS: ReadonlyMap<number, ErrorCode> = new Map([
  [400, 'REQUEST_INVALID'],
  [404, 'NOT_FOUND'],
])

/** 把任意异常映射为统一的错误响应（P2 设计 §3.5，ADR-006）。只有 AppError 的说明会返回给客户端。 */
export function mapException(exception: unknown): MappedError {
  if (exception instanceof AppError)
    return { status: exception.status, code: exception.code, message: exception.message, unexpected: false }
  const code = exception instanceof HttpException ? FRAMEWORK_CLIENT_ERRORS.get(exception.getStatus()) : undefined
  if (code !== undefined)
    return { status: ERROR_CODES[code].status, code, message: ERROR_CODES[code].message, unexpected: false }
  return { status: ERROR_CODES.INTERNAL_ERROR.status, code: 'INTERNAL_ERROR', message: ERROR_CODES.INTERNAL_ERROR.message, unexpected: true }
}

/** 全局异常过滤器：所有异常都得到 `{ error: { code, message, requestId } }`。 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const request = http.getRequest<Request>()
    const response = http.getResponse<Response>()
    const mapped = mapException(exception)
    if (mapped.unexpected)
      response.err = exception instanceof Error ? exception : new Error('抛出的不是 Error', { cause: exception })
    if (response.headersSent) {
      // 响应已经开始发送，无法改写成错误响应：断开连接，让客户端知道它不完整
      response.destroy()
      return
    }
    // 请求标识由排在最前面的请求日志中间件生成；万一没有，也要给出合法的错误响应
    const requestId = typeof request.id === 'string' ? request.id : 'unknown'
    const body: ErrorResponse = { error: { code: mapped.code, message: mapped.message, requestId } }
    response.status(mapped.status).json(body)
  }
}
