import type { DynamicModule, ModuleMetadata } from '@nestjs/common'
import type { AppConfig } from '../modules/config/index.ts'
import type { AppLogger } from '../modules/logging/index.ts'
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AuditModule } from '../modules/audit/index.ts'
import { AuthModule, CsrfGuard, SessionGuard } from '../modules/auth/index.ts'
import { ConfigModule } from '../modules/config/index.ts'
import { DatabaseModule } from '../modules/database/index.ts'
import { DocumentsModule } from '../modules/documents/index.ts'
import { HealthModule } from '../modules/health/index.ts'
import { LoggingModule } from '../modules/logging/index.ts'
import { SpacesModule } from '../modules/spaces/index.ts'
import { UsersModule } from '../modules/users/index.ts'

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
        SpacesModule,
        UsersModule,
        AuthModule,
        DocumentsModule,
        ...(options.additionalModules ?? []),
      ],
      // 全局守卫，按注册的顺序执行（P3 设计 §3.5）：先认证（默认拒绝，@Public() 除外），再 CSRF 与 Origin 检查
      providers: [
        { provide: APP_GUARD, useExisting: SessionGuard },
        { provide: APP_GUARD, useExisting: CsrfGuard },
      ],
    }
  }
}
