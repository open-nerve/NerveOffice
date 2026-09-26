import type { DynamicModule } from '@nestjs/common'
import { Module } from '@nestjs/common'
import { AppLogger } from './app-logger.ts'

/** 把应用实例的 AppLogger 提供给所有模块（全局）。 */
@Module({})
export class LoggingModule {
  static forRoot(logger: AppLogger): DynamicModule {
    return {
      module: LoggingModule,
      global: true,
      providers: [{ provide: AppLogger, useValue: logger }],
      exports: [AppLogger],
    }
  }
}
