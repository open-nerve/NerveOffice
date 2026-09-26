import type { DynamicModule, ModuleMetadata } from '@nestjs/common'
import type { AppConfig } from '../modules/config/index.ts'
import type { AppLogger } from '../modules/logging/index.ts'
import { Module } from '@nestjs/common'
import { AuditModule } from '../modules/audit/index.ts'
import { ConfigModule } from '../modules/config/index.ts'
import { DatabaseModule } from '../modules/database/index.ts'
import { HealthModule } from '../modules/health/index.ts'
import { LoggingModule } from '../modules/logging/index.ts'

export type AdditionalModules = NonNullable<ModuleMetadata['imports']>

export interface AppModuleOptions {
  config: AppConfig
  logger: AppLogger
  /** 附加的模块：集成测试用来挂只在测试里存在的控制器 */
  additionalModules?: AdditionalModules
}

/** 根模块：按配置组装各模块。 */
@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(options.config),
        LoggingModule.forRoot(options.logger),
        DatabaseModule,
        AuditModule,
        HealthModule,
        ...(options.additionalModules ?? []),
      ],
    }
  }
}
