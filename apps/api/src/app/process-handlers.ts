import type { EventEmitter } from 'node:events'
import type { Logger } from 'pino'
import type { ShutdownResult } from './shutdown.ts'

export interface ProcessHandlerOptions {
  /** 进程（测试里换成普通的事件对象） */
  process: Pick<EventEmitter, 'on'>
  exit: (code: number) => void
  logger: Logger
}

/** 未捕获的异常与未处理的 Promise 拒绝：记 fatal 后退出，退出码 1（P2 设计 §3.9）。应用建好之前就安装。 */
export function handleFatalErrors(options: ProcessHandlerOptions): void {
  options.process.on('uncaughtException', (error: unknown) => {
    options.logger.fatal({ err: error }, '未捕获的异常')
    options.exit(1)
  })
  options.process.on('unhandledRejection', (reason: unknown) => {
    options.logger.fatal({ err: reason }, '未处理的 Promise 拒绝')
    options.exit(1)
  })
}

/** SIGTERM、SIGINT：优雅退出，正常退出码 0、强制退出码 1；退出过程中再收到信号就立即退出，退出码 1。 */
export function handleShutdownSignals(shutdown: (reason: string) => Promise<ShutdownResult>, options: ProcessHandlerOptions): void {
  let shuttingDown = false
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    options.process.on(signal, () => {
      if (shuttingDown) {
        options.logger.warn({ signal }, '退出过程中再次收到信号，立即退出')
        options.exit(1)
        return
      }
      shuttingDown = true
      shutdown(signal).then(
        result => options.exit(result === 'graceful' ? 0 : 1),
        (error: unknown) => {
          options.logger.fatal({ err: error }, '退出失败')
          options.exit(1)
        },
      )
    })
  }
}
