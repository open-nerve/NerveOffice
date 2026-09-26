import type { DynamicModule } from '@nestjs/common'
import type { AppConfig } from './config.ts'
import { Module } from '@nestjs/common'

/** 注入标记：已校验、已冻结的配置（`@Inject(APP_CONFIG) config: AppConfig`）。 */
export const APP_CONFIG = Symbol('APP_CONFIG')

/** 配置在进程入口读取并校验一次，这里只负责提供给其他模块。 */
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    }
  }
}
