import type { DestinationStream, Logger } from 'pino'
import type { LogLevel } from '../config/index.ts'
import { destination, pino, stdTimeFunctions } from 'pino'

/**
 * 日志里一律脱敏的键名（规范 §6、§7），覆盖顶层与两层嵌套。
 * 请求头、请求体本来就不记录；这里是写应用日志时的兜底。清单变更经审查，由测试验证。
 */
export const REDACTED_KEYS = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'sessionToken',
  'secret',
  'cookie',
  'authorization',
  'databaseUrl',
  'connectionString',
  'snapshot',
] as const

export const REDACTION_CENSOR = '[已脱敏]'

const REDACTED_PATHS = REDACTED_KEYS.flatMap(key => [key, `*.${key}`, `*.*.${key}`])

export interface RootLoggerOptions {
  level: LogLevel
  /** 默认同步写标准输出：进程退出前的最后几行（例如启动失败的原因）不会丢 */
  destination?: DestinationStream
}

/** 根日志：JSON，每行一条，时间用 ISO 8601，级别写文字（P2 设计 §3.4）。 */
export function createRootLogger(options: RootLoggerOptions): Logger {
  return pino({
    level: options.level,
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: label => ({ level: label }) },
    redact: { paths: REDACTED_PATHS, censor: REDACTION_CENSOR },
  }, options.destination ?? destination({ fd: 1, sync: true }))
}
