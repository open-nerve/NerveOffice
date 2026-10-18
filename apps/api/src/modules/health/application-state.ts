import { Injectable } from '@nestjs/common'

/** 应用的运行状态：开始退出后，就绪探针失败，编排工具不再把请求发过来（P2 设计 §3.9）。 */
@Injectable()
export class ApplicationState {
  #accepting = true
  readonly #shutdown = new AbortController()

  /** 排空请求之前通知可取消的长任务；模块销毁钩子在排空后才调用。 */
  get shutdownSignal(): AbortSignal {
    return this.#shutdown.signal
  }

  get accepting(): boolean {
    return this.#accepting
  }

  beginShutdown(): void {
    this.#accepting = false
    this.#shutdown.abort()
  }
}
