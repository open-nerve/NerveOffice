import type { RequestHandler } from 'express'
import type { ServerResponse } from 'node:http'

/**
 * 在途请求（P2 设计 §3.9）：退出时等它们完成。
 * 开始退出后，还没发出响应头的在途响应与之后的响应都带 Connection: close，长连接在响应之后随之关闭。
 */
export class InFlightRequests {
  readonly #responses = new Set<ServerResponse>()
  #draining = false
  #waiters: (() => void)[] = []

  get size(): number {
    return this.#responses.size
  }

  /** 排在管线的最前面，每个请求都计入。 */
  middleware(): RequestHandler {
    return (_request, response, next) => {
      this.#responses.add(response)
      if (this.#draining)
        response.setHeader('Connection', 'close')
      const finished = (): void => {
        if (this.#responses.delete(response) && this.#responses.size === 0)
          this.#notifyIdle()
      }
      response.once('finish', finished)
      response.once('close', finished)
      next()
    }
  }

  beginDraining(): void {
    this.#draining = true
    for (const response of this.#responses) {
      if (!response.headersSent)
        response.setHeader('Connection', 'close')
    }
  }

  /** 在途请求都完成时兑现。 */
  async idle(): Promise<void> {
    if (this.#responses.size === 0)
      return
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve)
    })
  }

  #notifyIdle(): void {
    const waiters = this.#waiters
    this.#waiters = []
    for (const resolve of waiters)
      resolve()
  }
}
