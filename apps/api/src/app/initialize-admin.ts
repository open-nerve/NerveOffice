import type { DynamicModule } from '@nestjs/common'
import type { DestinationStream } from 'pino'
import type { AppConfig } from '../modules/config/index.ts'
import type { AdminInitializationInput, InitializedAdmin } from '../modules/users/index.ts'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AuditModule } from '../modules/audit/index.ts'
import { ConfigModule } from '../modules/config/index.ts'
import { DatabaseModule } from '../modules/database/index.ts'
import { AppLogger, createRootLogger, LoggingModule, NestPinoLogger, RequestContextStore } from '../modules/logging/index.ts'
import { SpacesModule } from '../modules/spaces/index.ts'
import { AdminInitializationService, UsersModule } from '../modules/users/index.ts'

/** 命令行用的模块组合：没有 HTTP，只有初始化管理员要用到的模块。 */
@Module({})
class AdminCommandModule {
  static register(config: AppConfig, logger: AppLogger): DynamicModule {
    return {
      module: AdminCommandModule,
      imports: [ConfigModule.forRoot(config), LoggingModule.forRoot(logger), DatabaseModule, AuditModule, SpacesModule, UsersModule],
    }
  }
}

export interface InitializeAdminOptions {
  /** 日志的输出；默认同步写标准输出。集成测试传内存流 */
  logDestination?: DestinationStream
}

/**
 * 初始化首个系统管理员（P3 设计 §3.4）：建一个不带 HTTP 的应用上下文，与 HTTP 服务同一套配置与日志；
 * 执行完关闭上下文，连接池随之关闭。
 */
export async function initializeAdmin(config: AppConfig, input: AdminInitializationInput, options: InitializeAdminOptions = {}): Promise<InitializedAdmin> {
  const rootLogger = createRootLogger({ level: config.log.level, destination: options.logDestination })
  const requestContext = new RequestContextStore()
  const logger = new AppLogger(rootLogger, requestContext)
  const context = await NestFactory.createApplicationContext(AdminCommandModule.register(config, logger), {
    abortOnError: false,
    logger: new NestPinoLogger(rootLogger, requestContext),
  })
  try {
    return await context.get(AdminInitializationService).initialize(input)
  }
  finally {
    await context.close()
  }
}
