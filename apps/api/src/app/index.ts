// api 对外的程序接口（P2 设计 §3.2）：命令行与集成测试经这里建应用，走的是与进程入口相同的管线。
export { ConfigError, loadConfig, loadConfigFromEnvironment } from '../modules/config/index.ts'
export type { AppConfig } from '../modules/config/index.ts'
export { AppLogger } from '../modules/logging/index.ts'
export { AppError } from '../shared/errors/app-error.ts'
export { ApplicationRuntime } from './application-runtime.ts'
export type { ShutdownResult } from './application-runtime.ts'
export { createApplication } from './create-application.ts'
export type { ApplicationOptions } from './create-application.ts'
