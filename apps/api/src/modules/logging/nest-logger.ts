import type { LoggerService } from '@nestjs/common'
import type { Level, Logger } from 'pino'
import type { RequestContextStore } from './request-context.ts'
import { framesOnly, safeErrorMessage } from './error-serializer.ts'

const STACK_TRACE = /\n\s+at /

/**
 * Nest 的调用约定：最后一个字符串参数是上下文（类名）；
 * error 与 fatal 在上下文之前还可能有堆栈，只有一个参数时按内容判断它是堆栈还是上下文。
 */
export function contextAndStack(level: Level, params: readonly unknown[]): { context?: string, stack?: string } {
  const strings = params.filter((param): param is string => typeof param === 'string')
  if (level !== 'error' && level !== 'fatal') {
    const context = strings.at(-1)
    return context === undefined ? {} : { context }
  }
  // 堆栈只留调用帧：它的开头就是异常消息，数据库错误的消息带着参数（复验 N4）
  if (strings.length >= 2)
    return { stack: framesOnly(strings.at(-2)), context: strings.at(-1) }
  const [only] = strings
  if (only === undefined)
    return {}
  return STACK_TRACE.test(only) ? { stack: framesOnly(only) } : { context: only }
}

function describe(message: unknown): string {
  if (typeof message === 'string')
    return message
  if (typeof message === 'number' || typeof message === 'boolean' || typeof message === 'bigint')
    return message.toString()
  return JSON.stringify(message) ?? ''
}

/**
 * Nest 的内部日志写进同一个 pino：请求内写入该请求的子日志（带请求标识），请求外写入根日志。
 * 脱敏（复验 N4）：Error 的消息与堆栈参数按 serializeError 的规则处理；
 * 但 Nest 已经拼好的字符串消息（例如把异常的消息写进一句话）无法识别，只能靠业务代码不把数据库错误交给 Nest 记录（全局异常过滤器自己记）。
 */
export class NestPinoLogger implements LoggerService {
  constructor(
    private readonly root: Logger,
    private readonly requestContext: RequestContextStore,
  ) {}

  log(message: unknown, ...params: unknown[]): void {
    this.#write('info', message, params)
  }

  error(message: unknown, ...params: unknown[]): void {
    this.#write('error', message, params)
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.#write('warn', message, params)
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.#write('debug', message, params)
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.#write('trace', message, params)
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.#write('fatal', message, params)
  }

  #write(level: Level, message: unknown, params: readonly unknown[]): void {
    const logger = this.requestContext.current()?.logger ?? this.root
    if (!logger.isLevelEnabled(level))
      return
    const fields = contextAndStack(level, params)
    if (message instanceof Error)
      logger[level]({ ...fields, err: message }, safeErrorMessage(message))
    else if (typeof message === 'object' && message !== null)
      logger[level]({ ...fields, ...message })
    else
      logger[level](fields, describe(message))
  }
}
