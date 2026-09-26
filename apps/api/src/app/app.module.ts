import type { DynamicModule, ModuleMetadata } from '@nestjs/common'
import type { AppConfig } from '../modules/config/index.ts'
import { Module } from '@nestjs/common'
import { ConfigModule } from '../modules/config/index.ts'
import { HealthModule } from '../modules/health/index.ts'

export type AdditionalModules = NonNullable<ModuleMetadata['imports']>

/** 根模块：按配置组装各模块。 */
@Module({})
export class AppModule {
  static register(config: AppConfig, additionalModules: AdditionalModules = []): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), HealthModule, ...additionalModules],
    }
  }
}
