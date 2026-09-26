// api 对外的程序接口（P2 设计 §3.2）：main、命令行与集成测试都经这里建应用。
export { ConfigError, loadConfig, loadConfigFromEnvironment } from '../modules/config/index.ts'
export type { AppConfig } from '../modules/config/index.ts'
export { ApplicationRuntime } from './application-runtime.ts'
export type { ShutdownResult } from './application-runtime.ts'
export { createApplication } from './create-application.ts'
export type { ApplicationOptions } from './create-application.ts'
