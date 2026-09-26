import type { Abstract, Type } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import type { AddressInfo } from 'node:net'
import type { Logger } from 'pino'
import type { AppConfig } from '../modules/config/index.ts'
import type { InFlightRequests } from './in-flight-requests.ts'
import type { ShutdownResult } from './shutdown.ts'
import { ApplicationState } from '../modules/health/index.ts'
import { shutdownGracefully } from './shutdown.ts'

/** 运行中的应用：监听与退出（P2 设计 §3.9）。 */
export class ApplicationRuntime {
  #shutdown: Promise<ShutdownResult> | undefined

  constructor(
    private readonly app: NestExpressApplication,
    private readonly config: AppConfig,
    /** 应用的根日志 */
    readonly logger: Logger,
    private readonly inFlight: InFlightRequests,
  ) {}

  async listen(): Promise<AddressInfo> {
    await this.app.listen(this.config.http.port, this.config.http.host)
    const address = this.app.getHttpServer().address()
    if (address === null || typeof address === 'string')
      throw new Error('HTTP 服务没有监听在 TCP 端口上')
    return address
  }

  /** 取应用里的服务（命令行与集成测试用）。 */
  get<T>(token: Type<T> | Abstract<T> | symbol): T {
    return this.app.get<T>(token)
  }

  /** 只执行一次；重复调用得到同一个结果。 */
  async shutdown(reason: string): Promise<ShutdownResult> {
    this.#shutdown ??= this.#shutdownOnce(reason)
    return this.#shutdown
  }

  async #shutdownOnce(reason: string): Promise<ShutdownResult> {
    this.logger.info({ reason, inFlight: this.inFlight.size }, '开始退出')
    const result = await shutdownGracefully({
      beginShutdown: () => this.app.get(ApplicationState).beginShutdown(),
      inFlight: this.inFlight,
      server: this.app.getHttpServer(),
      closeApplication: async () => this.app.close(),
      timeoutMs: this.config.shutdown.timeoutMs,
      logger: this.logger,
    })
    this.logger.info({ result }, '已退出')
    return result
  }
}
