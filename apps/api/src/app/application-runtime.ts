import type { NestExpressApplication } from '@nestjs/platform-express'
import type { AddressInfo } from 'node:net'
import type { AppConfig } from '../modules/config/index.ts'
import { Logger } from '@nestjs/common'
import { ApplicationState } from '../modules/health/index.ts'

export type ShutdownResult = 'graceful' | 'forced'

/** 运行中的应用：监听与退出（P2 设计 §3.9）。 */
export class ApplicationRuntime {
  readonly #logger = new Logger(ApplicationRuntime.name)
  #shutdown: Promise<ShutdownResult> | undefined

  constructor(
    private readonly app: NestExpressApplication,
    private readonly config: AppConfig,
  ) {}

  async listen(): Promise<AddressInfo> {
    await this.app.listen(this.config.http.port, this.config.http.host)
    const address = this.app.getHttpServer().address()
    if (address === null || typeof address === 'string')
      throw new Error('HTTP 服务没有监听在 TCP 端口上')
    return address
  }

  /** 只执行一次；重复调用得到同一个结果。 */
  async shutdown(reason: string): Promise<ShutdownResult> {
    this.#shutdown ??= this.#shutdownOnce(reason)
    return this.#shutdown
  }

  async #shutdownOnce(reason: string): Promise<ShutdownResult> {
    this.#logger.log(`开始退出：${reason}`)
    this.app.get(ApplicationState).beginShutdown()
    await this.app.close()
    this.#logger.log('已退出')
    return 'graceful'
  }
}
