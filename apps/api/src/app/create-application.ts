import type { LoggerService } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import type { AppConfig } from '../modules/config/index.ts'
import type { AdditionalModules } from './app.module.ts'
import { ConsoleLogger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.ts'
import { ApplicationRuntime } from './application-runtime.ts'

export interface ApplicationOptions {
  /** Nest 的日志；false 表示不输出 */
  logger?: LoggerService | false
  /** 附加的模块：集成测试用来挂只在测试里存在的控制器 */
  additionalModules?: AdditionalModules
}

/** 按配置建应用（P2 设计 §3.2）。main、命令行与集成测试都经这里，走的是同一条管线。 */
export async function createApplication(config: AppConfig, options: ApplicationOptions = {}): Promise<ApplicationRuntime> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config, options.additionalModules), {
    // 请求体由自己的解析器处理，上限取自配置（S2）
    bodyParser: false,
    // 初始化失败时抛出异常，由调用方处理，而不是直接退出进程
    abortOnError: false,
    logger: options.logger ?? new ConsoleLogger({ json: true }),
  })
  app.setGlobalPrefix('api')
  await app.init()
  return new ApplicationRuntime(app, config)
}
