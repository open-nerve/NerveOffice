import type { DestinationStream, Logger } from 'pino'
import type { LogLevel } from '../config/index.ts'
import { destination, pino, stdTimeFunctions } from 'pino'
import { REDACTED } from '../../shared/secret.ts'
import { serializeError } from './error-serializer.ts'

/**
 * 日志里一律脱敏的键名（规范 §6、§7），覆盖顶层与两层嵌套。
 * 请求头、请求体本来就不记录；这里是写应用日志时的兜底。连接串等配置里的机密另用 Secret 包装（shared/secret.ts）。
 * 清单变更经审查，由测试验证。
 */
export const REDACTED_KEYS = [
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'sessionToken',
  'leaseToken',
  'csrfToken',
  'secret',
  'apiKey',
  'privateKey',
  'cookie',
  'authorization',
  'databaseUrl',
  'connectionString',
  'snapshot',
] as const

export const REDACTION_CENSOR = REDACTED

const REDACTED_PATHS = REDACTED_KEYS.flatMap(key => [key, `*.${key}`, `*.*.${key}`])

/** 异常的序列化：数据库错误不带参数与行里的值（审查 A2）。请求日志（pino-http）也要用同一个。 */
export const LOG_SERIALIZERS = { err: serializeError }

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
    serializers: LOG_SERIALIZERS,
    redact: { paths: REDACTED_PATHS, censor: REDACTION_CENSOR },
  }, options.destination ?? destination({ fd: 1, sync: true }))
}
