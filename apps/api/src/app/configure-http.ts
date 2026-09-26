import type { NestExpressApplication } from '@nestjs/platform-express'
import type { Logger } from 'pino'
import type { AppConfig } from '../modules/config/index.ts'
import type { RequestContextStore } from '../modules/logging/index.ts'
import type { InFlightRequests } from './in-flight-requests.ts'
import { StandardSchemaValidationPipe } from '@nestjs/common'
import { createHttpLogger } from '../modules/logging/index.ts'
import { jsonBody, securityHeaders } from '../modules/security/index.ts'
import { notFoundOutsideApi, webHosting } from '../modules/web-hosting/index.ts'
import { HttpErrorFilter } from './error-filter.ts'
import { validationError } from './validation.ts'

export interface HttpPipeline {
  rootLogger: Logger
  requestContext: RequestContextStore
  inFlight: InFlightRequests
}

/**
 * HTTP 管线（P2 设计 §3.2）：顺序在这里一次写定，在 app.init() 之前调用。
 * 这些中间件直接挂在 Express 上，排在 Nest 的路由之前，所以 404 与请求体解析失败的响应同样经过它们。
 */
export function configureHttp(app: NestExpressApplication, config: AppConfig, pipeline: HttpPipeline): void {
  app.set('trust proxy', config.http.trustProxy)
  app.disable('x-powered-by')
  // 在途请求最先计入：退出时要等每一个请求完成
  app.use(pipeline.inFlight.middleware())
  // 请求日志与请求标识紧随其后：所有响应都有日志与请求标识
  app.use(createHttpLogger(pipeline.rootLogger))
  app.use(pipeline.requestContext.middleware())
  app.use(securityHeaders())
  // 托管前端产物（配置了才托管）：在安全响应头之后，页面与 Worker 脚本同样带 CSP；只处理 GET、HEAD 与 /api 以外的地址
  if (config.web.root !== undefined)
    app.use(webHosting(config.web.root))
  // 其余不属于 /api 的请求：统一的 404 错误响应（Nest 的路由只在 /api 下）
  app.use(notFoundOutsideApi())
  app.use(jsonBody(config.http.jsonBodyLimitBytes))
  app.setGlobalPrefix('api')
  app.useGlobalInterceptors(pipeline.inFlight.interceptor())
  app.useGlobalPipes(new StandardSchemaValidationPipe({ exceptionFactory: validationError }))
  app.useGlobalFilters(new HttpErrorFilter())
}
