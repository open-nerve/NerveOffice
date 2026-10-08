import type { DynamicModule, ModuleMetadata } from '@nestjs/common'
import type { ServerConfig } from '../modules/config/index.ts'
import type { AppLogger } from '../modules/logging/index.ts'
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AdminModule } from '../modules/admin/index.ts'
import { AuditModule } from '../modules/audit/index.ts'
import { AuthModule, CsrfGuard, SessionGuard } from '../modules/auth/index.ts'
import { ConfigModule } from '../modules/config/index.ts'
import { DatabaseModule } from '../modules/database/index.ts'
import { DocumentsModule } from '../modules/documents/index.ts'
import { HealthModule } from '../modules/health/index.ts'
import { JobsModule } from '../modules/jobs/index.ts'
import { LocalKeysModule } from '../modules/local-keys/index.ts'
import { LoggingModule } from '../modules/logging/index.ts'
import { SpacesModule } from '../modules/spaces/index.ts'
import { UsersModule } from '../modules/users/index.ts'
import { WorkspaceModule } from '../modules/workspace/index.ts'

export type AdditionalModules = NonNullable<ModuleMetadata['imports']>

export interface AppModuleOptions {
  /** 应用进程的配置：带着本机密钥的主密钥（只经 LOCAL_KEYS_CONFIG 给 local-keys 模块，M3-P6 设计 §3.4） */
  config: ServerConfig
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
        ConfigModule.forServer(options.config),
        LoggingModule.forRoot(options.logger),
        DatabaseModule,
        AuditModule,
        HealthModule,
        SpacesModule,
        UsersModule,
        AuthModule,
        DocumentsModule,
        LocalKeysModule,
        WorkspaceModule,
        AdminModule,
        JobsModule,
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
