import type { RequestHandler } from 'express'
import type { Logger } from 'pino'
import { AsyncLocalStorage } from 'node:async_hooks'
import { requestIdOf } from './request-id.ts'

export interface RequestContext {
  readonly requestId: string
  /** 这个请求的子日志，自动带上请求标识 */
  readonly logger: Logger
}

/** 请求上下文：每个应用实例一份，不用全局单例（同一个进程里可能有多个应用，例如集成测试）。 */
export class RequestContextStore {
  readonly #storage = new AsyncLocalStorage<RequestContext>()

  current(): RequestContext | undefined {
    return this.#storage.getStore()
  }

  /** 排在请求日志之后：之后在这个请求里写的日志都带上请求标识。 */
  middleware(): RequestHandler {
    return (request, _response, next) => {
      this.#storage.run({ requestId: requestIdOf(request), logger: request.log }, next)
    }
  }
}
