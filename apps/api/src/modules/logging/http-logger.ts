import type { Request, Response } from 'express'
import type { LevelWithSilent, Logger } from 'pino'
import { REQUEST_ID_HEADER } from '@nerve-office/contracts'
import { pinoHttp } from 'pino-http'
import { resolveRequestId } from './request-id.ts'

const HEALTH_PROBES = '/api/health/'

function pathOf(request: Request): string {
  return request.originalUrl.split('?')[0] ?? ''
}

function routeOf(request: Request): string | undefined {
  const route: unknown = request.route
  return typeof route === 'object' && route !== null && 'path' in route && typeof route.path === 'string' ? route.path : undefined
}

/** 5xx 与出错记 error，4xx 记 warn；探针的成功请求不记，免得刷屏。 */
export function levelFor(request: Request, statusCode: number, failed: boolean): LevelWithSilent {
  if (failed || statusCode >= 500)
    return 'error'
  if (statusCode >= 400)
    return 'warn'
  return pathOf(request).startsWith(HEALTH_PROBES) ? 'silent' : 'info'
}

/** 请求结束时记录的字段（规范 §7）。不记请求头、请求体、响应体与查询串。 */
export function requestSummary(request: Request, response: Response, durationMs: number): Record<string, unknown> {
  return { method: request.method, route: routeOf(request), path: pathOf(request), statusCode: response.statusCode, durationMs }
}

/** 请求日志与请求标识，排在管线的最前面（P2 设计 §3.2、§3.4）。 */
export function createHttpLogger(logger: Logger): ReturnType<typeof pinoHttp<Request, Response>> {
  return pinoHttp<Request, Response>({
    logger,
    // 请求内的日志只绑定请求标识，不带整个请求对象
    quietReqLogger: true,
    quietResLogger: true,
    customAttributeKeys: { reqId: 'requestId', responseTime: 'durationMs' },
    genReqId: (request, response) => {
      const id = resolveRequestId(request.headers[REQUEST_ID_HEADER])
      response.setHeader(REQUEST_ID_HEADER, id)
      return id
    },
    customLogLevel: (request, response, error) => levelFor(request, response.statusCode, error !== undefined),
    customSuccessObject: (request, response, value: { durationMs: number }) => requestSummary(request, response, value.durationMs),
    customErrorObject: (request, response, _error, value: { durationMs: number }) => ({
      ...requestSummary(request, response, value.durationMs),
      // 只有异常过滤器判定为意外错误时（response.err），才带上异常与堆栈；预期中的 5xx（例如未就绪）不带
      ...(response.err === undefined ? {} : { err: response.err }),
    }),
    customSuccessMessage: () => '请求完成',
    customErrorMessage: () => '请求失败',
  })
}
