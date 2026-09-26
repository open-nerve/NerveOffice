import type { Level, Logger } from 'pino'
import type { RequestContextStore } from './request-context.ts'

type Fields = Record<string, unknown>

/**
 * 应用代码写日志用它（经依赖注入取得，每个应用实例一份）：请求内写入该请求的子日志（带请求标识），请求外写入根日志。
 * 不用 @nestjs/common 的 Logger：它经进程级的静态实例转发，同一个进程里后建的应用会接管先建的应用的日志（lint 禁止）。
 */
export class AppLogger {
  constructor(
    private readonly root: Logger,
    private readonly requestContext: RequestContextStore,
    private readonly bindings: Fields = {},
  ) {}

  /** 带上固定字段的日志，例如 `logger.with({ module: 'audit' })` */
  with(bindings: Fields): AppLogger {
    return new AppLogger(this.root, this.requestContext, { ...this.bindings, ...bindings })
  }

  debug(message: string, fields?: Fields): void {
    this.#write('debug', message, fields)
  }

  info(message: string, fields?: Fields): void {
    this.#write('info', message, fields)
  }

  warn(message: string, fields?: Fields): void {
    this.#write('warn', message, fields)
  }

  /** 异常写在 `err` 字段里：`logger.error('写入失败', { err: error })` */
  error(message: string, fields?: Fields): void {
    this.#write('error', message, fields)
  }

  #write(level: Level, message: string, fields: Fields = {}): void {
    const logger = this.requestContext.current()?.logger ?? this.root
    logger[level]({ ...this.bindings, ...fields }, message)
  }
}
