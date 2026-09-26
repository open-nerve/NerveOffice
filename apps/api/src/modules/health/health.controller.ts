import type { HealthLiveResponse, HealthReadyResponse } from '@nerve-office/contracts'
import { Controller, Get } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { Public } from '../../shared/public.ts'
import { DatabaseReadiness } from '../database/index.ts'
import { ApplicationState } from './application-state.ts'

/** 探针给编排工具与反向代理用，不需要登录。 */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly state: ApplicationState,
    private readonly database: DatabaseReadiness,
  ) {}

  /** 进程在运行就返回，退出过程中也一样。 */
  @Get('live')
  live(): HealthLiveResponse {
    return { status: 'ok' }
  }

  /** 接收请求中、数据库连得上、库结构版本一致时返回；否则 503，说明里写明哪一项不满足（P2 设计 §3.9）。 */
  @Get('ready')
  async ready(): Promise<HealthReadyResponse> {
    if (!this.state.accepting)
      throw new AppError('SERVICE_UNAVAILABLE', '正在退出')
    const database = await this.database.check()
    if (!database.ready)
      throw new AppError('SERVICE_UNAVAILABLE', database.reason)
    return { status: 'ready' }
  }
}
