import type { LoggerService } from '@nestjs/common'
import type { Level, Logger } from 'pino'
import type { RequestContextStore } from './request-context.ts'

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
  if (strings.length >= 2)
    return { stack: strings.at(-2), context: strings.at(-1) }
  const [only] = strings
  if (only === undefined)
    return {}
  return STACK_TRACE.test(only) ? { stack: only } : { context: only }
}

function describe(message: unknown): string {
  if (typeof message === 'string')
    return message
  if (typeof message === 'number' || typeof message === 'boolean' || typeof message === 'bigint')
    return message.toString()
  return JSON.stringify(message) ?? ''
}

/** Nest 的内部日志写进同一个 pino：请求内写入该请求的子日志（带请求标识），请求外写入根日志。 */
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
      logger[level]({ ...fields, err: message }, message.message)
    else if (typeof message === 'object' && message !== null)
      logger[level]({ ...fields, ...message })
    else
      logger[level](fields, describe(message))
  }
}
