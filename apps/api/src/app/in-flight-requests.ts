import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import type { RequestHandler } from 'express'
import type { ServerResponse } from 'node:http'
import type { Observable } from 'rxjs'
import { finalize } from 'rxjs'

/**
 * 在途请求（P2 设计 §3.9）：退出时等它们完成。两种计数都归零才算排空：
 * - 响应：从请求到达到响应结束（或连接关闭），由排在管线最前面的中间件计入；
 * - 处理器：从进入处理器到它结束，由全局拦截器计入。客户端中途断开时响应先"结束"，
 *   处理器却还在执行（可能正占着数据库连接），只看响应会提前关闭连接池（审查 A3）。
 * 开始退出后，还没发出响应头的在途响应与之后的响应都带 Connection: close，长连接在响应之后随之关闭。
 */
export class InFlightRequests {
  readonly #responses = new Set<ServerResponse>()
  #handlers = 0
  #draining = false
  #waiters: (() => void)[] = []

  /** 还在途的响应与处理器（记日志用）。 */
  get pending(): { responses: number, handlers: number } {
    return { responses: this.#responses.size, handlers: this.#handlers }
  }

  /** 排在管线的最前面，每个请求都计入。 */
  middleware(): RequestHandler {
    return (_request, response, next) => {
      this.#responses.add(response)
      if (this.#draining)
        response.setHeader('Connection', 'close')
      const finished = (): void => {
        if (this.#responses.delete(response))
          this.#notifyIfIdle()
      }
      response.once('finish', finished)
      response.once('close', finished)
      next()
    }
  }

  /** 全局拦截器：处理器（含管道）执行期间计入，结束或出错时计出。 */
  interceptor(): HandlerTracker {
    return new HandlerTracker(
      () => {
        this.#handlers += 1
      },
      () => {
        this.#handlers -= 1
        this.#notifyIfIdle()
      },
    )
  }

  beginDraining(): void {
    this.#draining = true
    for (const response of this.#responses) {
      if (!response.headersSent)
        response.setHeader('Connection', 'close')
    }
  }

  /** 在途的响应与处理器都结束时兑现。 */
  async idle(): Promise<void> {
    if (this.#isIdle())
      return
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve)
    })
  }

  #isIdle(): boolean {
    return this.#responses.size === 0 && this.#handlers === 0
  }

  #notifyIfIdle(): void {
    if (!this.#isIdle())
      return
    const waiters = this.#waiters
    this.#waiters = []
    for (const resolve of waiters)
      resolve()
  }
}

/** 处理器计数的拦截器（由 InFlightRequests.interceptor() 创建）。 */
export class HandlerTracker implements NestInterceptor {
  constructor(
    private readonly enter: () => void,
    private readonly exit: () => void,
  ) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    this.enter()
    return next.handle().pipe(finalize(this.exit))
  }
}
