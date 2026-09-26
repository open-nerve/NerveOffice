import type { NestExpressApplication } from '@nestjs/platform-express'
import type { Logger } from 'pino'
import type { AppConfig } from '../modules/config/index.ts'
import type { RequestContextStore } from '../modules/logging/index.ts'
import { StandardSchemaValidationPipe } from '@nestjs/common'
import { createHttpLogger } from '../modules/logging/index.ts'
import { jsonBody, securityHeaders } from '../modules/security/index.ts'
import { HttpErrorFilter } from './error-filter.ts'
import { validationError } from './validation.ts'

export interface HttpLogging {
  rootLogger: Logger
  requestContext: RequestContextStore
}

/**
 * HTTP 管线（P2 设计 §3.2）：顺序在这里一次写定，在 app.init() 之前调用。
 * 这些中间件直接挂在 Express 上，排在 Nest 的路由之前，所以 404 与请求体解析失败的响应同样经过它们。
 */
export function configureHttp(app: NestExpressApplication, config: AppConfig, logging: HttpLogging): void {
  app.set('trust proxy', config.http.trustProxy)
  app.disable('x-powered-by')
  // 请求日志与请求标识排在最前面：所有响应都有日志与请求标识
  app.use(createHttpLogger(logging.rootLogger))
  app.use(logging.requestContext.middleware())
  app.use(securityHeaders())
  app.use(jsonBody(config.http.jsonBodyLimitBytes))
  app.setGlobalPrefix('api')
  app.useGlobalPipes(new StandardSchemaValidationPipe({ exceptionFactory: validationError }))
  app.useGlobalFilters(new HttpErrorFilter())
}
