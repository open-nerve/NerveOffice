import type { OpenCheckReport } from '@nerve-office/contracts'
import type { Principal } from '../auth/index.ts'
import { documentIdSchema, openCheckReportSchema } from '@nerve-office/contracts'
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common'
import { BackgroundRequest } from '../../shared/background-request.ts'
import { CurrentPrincipal } from '../auth/index.ts'
import { OpenCheckReportService } from './open-check-reports.service.ts'

/**
 * 打开自检失败的上报（M3-P4 设计 §3.13）：204，没有响应体。请求体按 contracts 严格解析（多出的字段、message 一律 400）；
 * 会话、CSRF、Origin、体积与嵌套由全局管线负责。页面自己发的、不是用户的操作：@BackgroundRequest()，不顺延登录的空闲过期（DEF-043）
 */
@Controller('documents/:id/open-check-failures')
export class OpenCheckReportsController {
  constructor(private readonly reports: OpenCheckReportService) {}

  @Post()
  @HttpCode(204)
  @BackgroundRequest()
  async report(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Body({ schema: openCheckReportSchema }) body: OpenCheckReport,
  ): Promise<void> {
    await this.reports.report(principal.user.id, id, body)
  }
}
