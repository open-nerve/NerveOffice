import type { NestExpressApplication } from '@nestjs/platform-express'
import type { DestinationStream } from 'pino'
import type { AppConfig } from '../modules/config/index.ts'
import type { AdditionalModules } from './app.module.ts'
import { NestFactory } from '@nestjs/core'
import { AppLogger, createRootLogger, NestPinoLogger, RequestContextStore } from '../modules/logging/index.ts'
import { AppModule } from './app.module.ts'
import { ApplicationRuntime } from './application-runtime.ts'
import { configureHttp } from './configure-http.ts'

export interface ApplicationOptions {
  /** 日志的输出；默认同步写标准输出。集成测试传内存流 */
  logDestination?: DestinationStream
  /** 附加的模块：集成测试用来挂只在测试里存在的控制器 */
  additionalModules?: AdditionalModules
}

/** 按配置建应用（P2 设计 §3.2）。进程入口与集成测试都经这里，走的是同一条管线。 */
export async function createApplication(config: AppConfig, options: ApplicationOptions = {}): Promise<ApplicationRuntime> {
  const rootLogger = createRootLogger({ level: config.log.level, destination: options.logDestination })
  const requestContext = new RequestContextStore()
  const logger = new AppLogger(rootLogger, requestContext)
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register({ config, logger, additionalModules: options.additionalModules }), {
    // 请求体由自己的解析器处理，上限取自配置
    bodyParser: false,
    // 初始化失败时抛出异常，由调用方处理，而不是直接退出进程
    abortOnError: false,
    // 框架自己的日志（启动、路由映射等）经适配写进同一个 pino
    logger: new NestPinoLogger(rootLogger, requestContext),
  })
  configureHttp(app, config, { rootLogger, requestContext })
  await app.init()
  return new ApplicationRuntime(app, config, rootLogger)
}
