import type { Request, Response } from 'express'
import type { LevelWithSilent, Logger } from 'pino'
import { REQUEST_ID_HEADER } from '@nerve-office/contracts'
import { pinoHttp, stdSerializers } from 'pino-http'
import { resolveRequestId } from './request-id.ts'
import { requestUserId } from './request-user.ts'
import { LOG_SERIALIZERS } from './root-logger.ts'

const HEALTH_PROBES = '/api/health/'

function pathOf(request: Request): string {
  return request.originalUrl.split('?')[0] ?? ''
}

function routeOf(request: Request): string | undefined {
  const route: unknown = request.route
  return typeof route === 'object' && route !== null && 'path' in route && typeof route.path === 'string' ? route.path : undefined
}

/** 响应没有写完连接就关了：客户端中途断开（或被强制断开），状态码只是默认值，没有意义（审查 A4）。 */
function aborted(response: Response): boolean {
  return !response.writableFinished
}

/** 出错（包括异常过滤器挂上的 response.err）与 5xx 记 error，4xx 与中断的请求记 warn；探针的成功请求不记，免得刷屏。 */
export function levelFor(request: Request, response: Response, failed: boolean): LevelWithSilent {
  if (failed || response.err !== undefined || response.statusCode >= 500)
    return 'error'
  if (response.statusCode >= 400 || aborted(response))
    return 'warn'
  return pathOf(request).startsWith(HEALTH_PROBES) ? 'silent' : 'info'
}

/** 请求结束时记录的字段（规范 §7）。不记请求头、请求体、响应体与查询串。中断的请求不记状态码，另记 aborted。 */
export function requestSummary(request: Request, response: Response, durationMs: number): Record<string, unknown> {
  const outcome = aborted(response) ? { aborted: true } : { statusCode: response.statusCode }
  return { method: request.method, route: routeOf(request), path: pathOf(request), ...outcome, durationMs }
}

/** 请求日志与请求标识，排在管线的最前面（P2 设计 §3.2、§3.4）。 */
export function createHttpLogger(logger: Logger): ReturnType<typeof pinoHttp<Request, Response>> {
  return pinoHttp<Request, Response>({
    logger,
    // pino-http 建的子日志会用它自己的序列化覆盖根日志的：显式交给它完整的一套，异常用与根日志相同的（审查 A2），
    // 并且不再套一层标准的；请求与响应沿用它自带的标准序列化（它在内部建子日志时会用到）
    serializers: { req: stdSerializers.req, res: stdSerializers.res, ...LOG_SERIALIZERS },
    wrapSerializers: false,
    // 请求内的日志只绑定请求标识，不带整个请求对象
    quietReqLogger: true,
    quietResLogger: true,
    customAttributeKeys: { reqId: 'requestId', responseTime: 'durationMs' },
    genReqId: (request, response) => {
      const id = resolveRequestId(request.headers[REQUEST_ID_HEADER])
      response.setHeader(REQUEST_ID_HEADER, id)
      return id
    },
    // 请求结束时再取：认证通过的请求带上 userId（规范 §7）
    customProps: (request) => {
      const userId = requestUserId(request)
      return userId === undefined ? {} : { userId }
    },
    customLogLevel: (request, response, error) => levelFor(request, response, error !== undefined),
    customSuccessObject: (request, response, value: { durationMs: number }) => requestSummary(request, response, value.durationMs),
    customErrorObject: (request, response, _error, value: { durationMs: number }) => ({
      ...requestSummary(request, response, value.durationMs),
      // 只有异常过滤器判定为意外错误时（response.err），才带上异常与堆栈；预期中的 5xx（例如未就绪）不带
      ...(response.err === undefined ? {} : { err: response.err }),
    }),
    customSuccessMessage: (_request, response) => (aborted(response) ? '请求中断' : '请求完成'),
    customErrorMessage: () => '请求失败',
  })
}
