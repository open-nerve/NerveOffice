import type { ErrorCode, ErrorResponse } from '@nerve-office/contracts'
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common'
import type { Request, Response } from 'express'
import type { DatabaseBusyReason } from '../modules/database/index.ts'
import type { ErrorDetails } from '../shared/errors/app-error.ts'
import { ERROR_CODES } from '@nerve-office/contracts'
import { Catch, HttpException } from '@nestjs/common'
import { CommitLedger, databaseBusyReasonOf } from '../modules/database/index.ts'
import { AppError } from '../shared/errors/app-error.ts'

export interface MappedError {
  readonly status: number
  readonly code: ErrorCode
  readonly message: string
  /** 意外错误：异常与堆栈写进请求日志 */
  readonly unexpected: boolean
  /** 随错误响应下发的响应头（AppError 带的，例如 Retry-After） */
  readonly headers: Readonly<Record<string, string>>
  /** 随错误响应下发的详情（AppError 带的，例如修订号冲突的当前修订号） */
  readonly details?: ErrorDetails
  /**
   * 数据库繁忙（等锁超时、语句超时、超过事务的时限、取不到连接）的原因。这个请求里还没有事务提交过时回 503，记一条 warn，不当作意外错误；
   * 已经有事务提交过时 unexpected 为真：按意外错误回 500（结果未知），另记一条 warn 写明原因，error 与其他意外错误一样只由请求日志记一条
   */
  readonly busy?: DatabaseBusyReason
}

/** 出错的这个请求的情况：异常本身看不出来的部分 */
export interface FailedRequest {
  /** 这个请求里有没有事务已经提交（CommitLedger） */
  readonly committed: boolean
}

/**
 * 数据库繁忙时建议客户端多久之后重试（Retry-After，秒）：取等锁与取连接的默认时限
 * （NERVE_DATABASE_LOCK_TIMEOUT_MS、NERVE_DATABASE_CONNECT_TIMEOUT_MS 的默认值都是 5 秒）。这次请求已经等了这么久没等到；
 * 占着锁或连接的是别的短事务（它们自己也受语句超时与事务中空闲超时的约束），再隔同样长的时间多半已经结束
 */
export const DATABASE_BUSY_RETRY_AFTER_SECONDS = 5

/**
 * 框架抛出的客户端错误，按 HTTP 状态映射到登记的错误码：
 * 没有匹配的路由（404），以及 Nest 把非法的请求路径编码（URIError）换成的 400。
 */
const FRAMEWORK_CLIENT_ERRORS: ReadonlyMap<number, ErrorCode> = new Map([
  [400, 'REQUEST_INVALID'],
  [404, 'NOT_FOUND'],
])

/** 意外错误的回答：只有登记的通用说明 */
const UNEXPECTED: MappedError = { status: ERROR_CODES.INTERNAL_ERROR.status, code: 'INTERNAL_ERROR', message: ERROR_CODES.INTERNAL_ERROR.message, unexpected: true, headers: {} }

/**
 * 把任意异常映射为统一的错误响应（P2 设计 §3.5，ADR-006）。只有 AppError 的说明会返回给客户端。
 *
 * 数据库繁忙（M2-P6 复核 A 的 G-2）在这里统一映射为 503 SERVICE_UNAVAILABLE 带 Retry-After，而不是在事务运行器的边界：
 * 这里是所有请求出错的唯一出口——事务里的写、事务外的读（仓储直接用连接池）、守卫里的会话查询都经过它，
 * 取不到连接与事务外的语句超时也在其中；事务运行器只看得到它自己开的事务。回滚照旧由事务运行器负责，这里只决定怎么回答。
 * 503 的意思是"确定没有生效"（前端据此不提示"可能已经生效"）：只在这个请求里还没有事务提交过时这样回答。
 * 已经有事务提交过（request.committed）时写入已经生效，按意外错误回 500 INTERNAL_ERROR，结果未知（M2-P6 第 3 片复验）。
 * 响应只有登记的通用说明，不带数据库的细节
 */
export function mapException(exception: unknown, request: FailedRequest = { committed: false }): MappedError {
  if (exception instanceof AppError) {
    const mapped = { status: exception.status, code: exception.code, message: exception.message, unexpected: false, headers: exception.headers }
    return exception.details === undefined ? mapped : { ...mapped, details: exception.details }
  }
  const code = exception instanceof HttpException ? FRAMEWORK_CLIENT_ERRORS.get(exception.getStatus()) : undefined
  if (code !== undefined)
    return { status: ERROR_CODES[code].status, code, message: ERROR_CODES[code].message, unexpected: false, headers: {} }
  const busy = databaseBusyReasonOf(exception)
  if (busy !== undefined && request.committed)
    return { ...UNEXPECTED, busy }
  if (busy !== undefined) {
    const { status, message } = ERROR_CODES.SERVICE_UNAVAILABLE
    return { status, code: 'SERVICE_UNAVAILABLE', message, unexpected: false, headers: { 'Retry-After': String(DATABASE_BUSY_RETRY_AFTER_SECONDS) }, busy }
  }
  return UNEXPECTED
}

function asError(exception: unknown): Error {
  return exception instanceof Error ? exception : new Error('抛出的不是 Error', { cause: exception })
}

/**
 * 数据库繁忙的那一条日志，带着原因与数据库报的错（便于看出是哪条语句在等），都记 warn：
 * - 还没有事务提交过（503）：正常的锁竞争也会遇到，不是错误，请求结束的那一条也按 503 带 Retry-After 记成 warn（logging 的 levelFor）；
 * - 已经有事务提交过（500，M2-P6 第 3 片复验）：写入已经生效、客户端得到的是"结果未知"，这里写明是提交之后遇到的繁忙与原因。
 *   它是意外错误，error 与其他意外错误一样只记一条：请求日志按挂上的 response.err 记，连接已经关闭时由下面的"请求中断之后处理失败"记。
 *   这里再记 error 的话，按 error 告警时同一件事会算两次
 */
function logBusy(request: Request, error: Error, mapped: MappedError): void {
  const message = mapped.unexpected ? '事务提交之后遇到数据库繁忙：这个请求的写入已经生效，按意外错误回 500（结果未知）' : '数据库繁忙，回 503 让客户端稍后重试'
  request.log.warn({ err: error, reason: mapped.busy }, message)
}

/**
 * 全局异常过滤器：所有异常都得到 `{ error: { code, message, requestId } }`，AppError 带了详情时再加上 `details`。
 * 每个应用一份，由 HTTP 管线建（configure-http.ts）：数据库繁忙怎么回答，要看这个应用里这个请求有没有事务已经提交（CommitLedger）
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly commits: CommitLedger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const request = http.getRequest<Request>()
    const response = http.getResponse<Response>()
    const mapped = mapException(exception, { committed: this.commits.hasCommitted() })
    if (mapped.busy !== undefined)
      logBusy(request, asError(exception), mapped)
    if (response.writableEnded || response.destroyed) {
      // 连接已经关闭（客户端中途断开）：响应写不出去，请求日志也已经记过"请求中断"（warn）。
      // 意外错误由这里记进这个请求的日志，不能被吞掉（审查 A4）；提交之后的数据库繁忙也是意外错误，同样在这里记 error
      if (mapped.unexpected)
        request.log.error({ err: asError(exception) }, '请求中断之后处理失败')
      return
    }
    if (mapped.unexpected)
      response.err = asError(exception)
    if (response.headersSent) {
      // 响应已经开始发送，无法改写成错误响应：断开连接，让客户端知道它不完整；请求日志随后记下异常
      response.destroy()
      return
    }
    // 请求标识由排在前面的请求日志中间件生成；万一没有，也要给出合法的错误响应
    const requestId = typeof request.id === 'string' ? request.id : 'unknown'
    const error: ErrorResponse['error'] = { code: mapped.code, message: mapped.message, requestId }
    const body: ErrorResponse = { error: mapped.details === undefined ? error : { ...error, details: mapped.details } }
    for (const [name, value] of Object.entries(mapped.headers))
      response.setHeader(name, value)
    response.status(mapped.status).json(body)
  }
}
