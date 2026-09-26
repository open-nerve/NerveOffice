import type { HealthLiveResponse, HealthReadyResponse } from '@nerve-office/contracts'
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common'
import { ApplicationState } from './application-state.ts'

@Controller('health')
export class HealthController {
  constructor(private readonly state: ApplicationState) {}

  /** 进程在运行就返回，退出过程中也一样。 */
  @Get('live')
  live(): HealthLiveResponse {
    return { status: 'ok' }
  }

  /** 可以接收请求时返回；数据库与库结构版本的检查在 S4 加入。 */
  @Get('ready')
  ready(): HealthReadyResponse {
    if (!this.state.accepting)
      throw new ServiceUnavailableException('正在退出')
    return { status: 'ready' }
  }
}
