import type { DestinationStream, Logger } from 'pino'
import type { LogLevel } from '../config/index.ts'
import { destination, pino, stdTimeFunctions } from 'pino'
import { REDACTED } from '../../shared/secret.ts'
import { safeErrorMessage, serializeError } from './error-serializer.ts'

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

/**
 * 只传了一个参数时，pino 会拿来作消息的异常：直接传入的 Error，或者 `{ err }` 里的 Error。
 * 对象里自带 msg 时 pino 不会拿异常的消息作消息（与 pino 的 write() 一致）。
 */
function errorUsedAsMessage(value: unknown): Error | undefined {
  if (value instanceof Error)
    return value
  if (typeof value === 'object' && value !== null && !('msg' in value && value.msg !== undefined) && 'err' in value && value.err instanceof Error)
    return value.err
  return undefined
}

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
    hooks: {
      // 只传异常、不给消息时（logger.error(err)、logger.error({ err })），pino 用异常原来的消息作 msg；
      // 数据库错误的消息带着值，换成不带值的说明（复验 F4）。子日志（含 pino-http 为每个请求建的）同样经过这里
      logMethod(args, method) {
        const error = args.length === 1 ? errorUsedAsMessage(args[0]) : undefined
        if (error === undefined)
          method.apply(this, args)
        else
          method.call(this, args[0] as object, safeErrorMessage(error))
      },
    },
  }, options.destination ?? destination({ fd: 1, sync: true }))
}
