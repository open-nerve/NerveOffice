import type { IssuedPasswordReset } from '@nerve-office/contracts'
import type { DynamicModule } from '@nestjs/common'
import type { DestinationStream } from 'pino'
import type { AppConfig } from '../modules/config/index.ts'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AuditModule } from '../modules/audit/index.ts'
import { AuthModule, PasswordResetsService } from '../modules/auth/index.ts'
import { ConfigModule } from '../modules/config/index.ts'
import { DatabaseModule } from '../modules/database/index.ts'
import { AppLogger, createRootLogger, LoggingModule, NestPinoLogger, RequestContextStore } from '../modules/logging/index.ts'
import { SpacesModule } from '../modules/spaces/index.ts'
import { UsersModule } from '../modules/users/index.ts'

/** 命令行用的模块组合：没有 HTTP，只有签发重置链接要用到的模块。 */
@Module({})
class ResetLinkCommandModule {
  static register(config: AppConfig, logger: AppLogger): DynamicModule {
    return {
      module: ResetLinkCommandModule,
      imports: [ConfigModule.forRoot(config), LoggingModule.forRoot(logger), DatabaseModule, AuditModule, SpacesModule, UsersModule, AuthModule],
    }
  }
}

export interface IssueResetLinkOptions {
  /** 日志的输出；默认同步写标准输出。集成测试传内存流 */
  logDestination?: DestinationStream
}

/**
 * 运维命令：为指定账户签发重置链接（M2-P1 设计 §3.9）。唯一的系统管理员忘记密码时用它恢复：
 * 与界面签发走同一个服务（作废旧的、撤销会话、记审计），操作者是系统，来源是命令行。不授予任何角色。
 */
export async function issueResetLink(config: AppConfig, username: string, options: IssueResetLinkOptions = {}): Promise<IssuedPasswordReset & { readonly userId: string }> {
  const rootLogger = createRootLogger({ level: config.log.level, destination: options.logDestination })
  const requestContext = new RequestContextStore()
  const logger = new AppLogger(rootLogger, requestContext)
  const context = await NestFactory.createApplicationContext(ResetLinkCommandModule.register(config, logger), {
    abortOnError: false,
    logger: new NestPinoLogger(rootLogger, requestContext),
  })
  try {
    return await context.get(PasswordResetsService).issueForUsername(username)
  }
  finally {
    await context.close()
  }
}
