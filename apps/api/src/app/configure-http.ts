import type { NestExpressApplication } from '@nestjs/platform-express'
import type { Logger } from 'pino'
import type { RequestIdentities } from '../modules/auth/index.ts'
import type { AppConfig } from '../modules/config/index.ts'
import type { CommitLedger } from '../modules/database/index.ts'
import type { AppLogger, RequestContextStore } from '../modules/logging/index.ts'
import type { InFlightRequests } from './in-flight-requests.ts'
import { StandardSchemaValidationPipe } from '@nestjs/common'
import { createHttpLogger } from '../modules/logging/index.ts'
import { jsonBody, proxyTrustCheck, securityHeaders } from '../modules/security/index.ts'
import { notFoundOutsideApi, webHosting } from '../modules/web-hosting/index.ts'
import { HttpErrorFilter } from './error-filter.ts'
import { validationError } from './validation.ts'

export interface HttpPipeline {
  rootLogger: Logger
  /** 管线里的中间件记日志用 */
  logger: AppLogger
  requestContext: RequestContextStore
  /** 这个应用里每个请求有没有事务已经提交（database 模块的 CommitLedger，M2-P6 第 3 片复验） */
  commits: CommitLedger
  /** 这个应用里每个请求经会话守卫认证的身份（auth 模块的 RequestIdentities，M2 Codex 评审 CX1） */
  identities: RequestIdentities
  inFlight: InFlightRequests
}

/**
 * HTTP 管线（P2 设计 §3.2）：顺序在这里一次写定，在 app.init() 之前调用。
 * 这些中间件直接挂在 Express 上，排在 Nest 的路由之前，所以 404 与请求体解析失败的响应同样经过它们。
 */
export function configureHttp(app: NestExpressApplication, config: AppConfig, pipeline: HttpPipeline): void {
  app.set('trust proxy', config.http.trustProxy)
  app.disable('x-powered-by')
  // 不要 Express 按响应体自动算的弱 ETag（M3-P6 审查 A8）：接口的响应都是 no-store，ETag 没有用处；响应体里有原始密钥（取用本机密钥）、
  // 租约令牌、一次性链接时，它（W/"长度-SHA-1 的前 27 个字符"）就是这些机密的稳定指纹，记响应头的中间层（代理的访问日志、HAR）会留下它。
  // 读取内容的 ETag 是修订号，由那个接口自己写（documents 的 ContentResponseInterceptor）；静态文件的 ETag 由 express.static 自己管。都不受影响
  app.set('etag', false)
  // 在途请求最先计入：退出时要等每一个请求完成
  app.use(pipeline.inFlight.middleware())
  // 请求日志与请求标识紧随其后：所有响应都有日志与请求标识
  app.use(createHttpLogger(pipeline.rootLogger))
  app.use(pipeline.requestContext.middleware())
  // 每个请求一份"有没有事务已经提交"的记录，排在请求上下文之后：事务运行器在提交之后记账，异常过滤器据此决定数据库繁忙时
  // 回 503（确定没有生效）还是 500（写入已经生效，结果未知）
  app.use(pipeline.commits.middleware())
  // 每个请求一份"会话守卫判断过的身份"的记录（M2 Codex 评审 CX1）：守卫认证通过之后记下，只读快照的开场核对据此在快照里再查一次
  app.use(pipeline.identities.middleware())
  // 代理未被信任时告警一次（DEF-014）：在请求上下文之后，日志带着请求标识
  app.use(proxyTrustCheck(config.http, pipeline.logger.with({ module: 'security' })))
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
  app.useGlobalFilters(new HttpErrorFilter(pipeline.commits))
}
