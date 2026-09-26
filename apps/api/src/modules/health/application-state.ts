import { Injectable } from '@nestjs/common'

/** 应用的运行状态：开始退出后，就绪探针失败，编排工具不再把请求发过来（P2 设计 §3.9）。 */
@Injectable()
export class ApplicationState {
  #accepting = true

  get accepting(): boolean {
    return this.#accepting
  }

  beginShutdown(): void {
    this.#accepting = false
  }
}
