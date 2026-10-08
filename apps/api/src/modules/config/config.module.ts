import type { DynamicModule } from '@nestjs/common'
import type { AppConfig, ServerConfig } from './config.ts'
import { Module } from '@nestjs/common'

/** 注入标记：已校验、已冻结的配置（`@Inject(APP_CONFIG) config: AppConfig`）。 */
export const APP_CONFIG = Symbol('APP_CONFIG')

/**
 * 注入标记：本机密钥的设置（`@Inject(LOCAL_KEYS_CONFIG) config: ServerConfig['localKeys']`，M3-P6 设计 §3.4）：只有应用进程的组装
 * （forServer）提供，只给 local-keys 模块注入（lint 拦下别的模块的引用）。APP_CONFIG 里没有它：别的模块经配置拿不到主密钥
 */
export const LOCAL_KEYS_CONFIG = Symbol('LOCAL_KEYS_CONFIG')

/** 配置在进程入口读取并校验一次，这里只负责提供给其他模块。 */
@Module({})
export class ConfigModule {
  /** 命令行的模块组合：只有 AppConfig（没有主密钥） */
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    }
  }

  /** 应用进程的组装：APP_CONFIG 是去掉主密钥的那一份，主密钥只经 LOCAL_KEYS_CONFIG 给 local-keys 模块 */
  static forServer(config: ServerConfig): DynamicModule {
    const { localKeys, ...app } = config
    const appConfig: AppConfig = Object.freeze(app)
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: APP_CONFIG, useValue: appConfig }, { provide: LOCAL_KEYS_CONFIG, useValue: localKeys }],
      exports: [APP_CONFIG, LOCAL_KEYS_CONFIG],
    }
  }
}
