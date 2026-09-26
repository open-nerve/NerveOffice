import type { NestExpressApplication } from '@nestjs/platform-express'
import type { AddressInfo } from 'node:net'
import type { Logger } from 'pino'
import type { AppConfig } from '../modules/config/index.ts'
import { ApplicationState } from '../modules/health/index.ts'

export type ShutdownResult = 'graceful' | 'forced'

/** 运行中的应用：监听与退出（P2 设计 §3.9）。 */
export class ApplicationRuntime {
  #shutdown: Promise<ShutdownResult> | undefined

  constructor(
    private readonly app: NestExpressApplication,
    private readonly config: AppConfig,
    /** 应用的根日志 */
    readonly logger: Logger,
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
    this.logger.info({ reason }, '开始退出')
    this.app.get(ApplicationState).beginShutdown()
    await this.app.close()
    this.logger.info('已退出')
    return 'graceful'
  }
}
