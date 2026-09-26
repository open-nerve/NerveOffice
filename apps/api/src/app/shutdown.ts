import type { Server } from 'node:http'
import type { Logger } from 'pino'
import type { InFlightRequests } from './in-flight-requests.ts'

export type ShutdownResult = 'graceful' | 'forced'

export interface ShutdownSteps {
  /** 标记为正在退出：就绪探针改回 503 */
  beginShutdown: () => void
  inFlight: InFlightRequests
  server: Pick<Server, 'close' | 'closeIdleConnections' | 'closeAllConnections'>
  /** 关闭应用：执行各模块的关闭钩子，连接池在这里关闭 */
  closeApplication: () => Promise<void>
  timeoutMs: number
  logger: Logger
}

/** promise 在 deadline（毫秒时间戳）之前兑现时为 true。 */
async function settlesBefore(promise: Promise<unknown>, deadline: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), false)
  })
  try {
    return await Promise.race([promise.then(() => true), timeout])
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * 优雅退出（P2 设计 §3.9，ADR-004）。NestJS 关闭应用时先调用各模块的 onModuleDestroy、再关闭 HTTP 服务，
 * 在途请求会失去数据库；所以这里先排空在途请求，再关闭应用。
 * 1. 标记为正在退出，在途与之后的响应都带 Connection: close；
 * 2. 不再接受新连接；
 * 3. 等在途请求（响应与处理器）完成，关闭它们留下的空闲长连接；超过时限就强制断开，结果记为"强制"；
 * 4. 关闭应用（连接池在这里关闭）。这一步同样受时限约束：超时就不再等，结果记为"强制"，
 *    由进程入口直接退出（审查 A3）。
 */
export async function shutdownGracefully(steps: ShutdownSteps): Promise<ShutdownResult> {
  const deadline = Date.now() + steps.timeoutMs
  steps.beginShutdown()
  steps.inFlight.beginDraining()
  // 回调在所有连接都关闭后调用；服务器没有在监听时回调带错误，同样视为已关闭
  const closed = new Promise<void>((resolve) => {
    steps.server.close(() => resolve())
  })
  const drained = await settlesBefore(steps.inFlight.idle(), deadline)
  steps.server.closeIdleConnections()
  const serverClosed = drained && await settlesBefore(closed, deadline)
  if (!serverClosed) {
    steps.logger.warn({ inFlight: steps.inFlight.pending, timeoutMs: steps.timeoutMs }, '在途请求超过退出时限，强制断开')
    steps.server.closeAllConnections()
    await closed
  }
  const applicationClosed = await settlesBefore(steps.closeApplication(), deadline)
  if (!applicationClosed)
    steps.logger.warn({ timeoutMs: steps.timeoutMs }, '关闭应用超过退出时限，不再等待')
  return serverClosed && applicationClosed ? 'graceful' : 'forced'
}
