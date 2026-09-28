import type { AuditEventListResponse, AuditEventQuery } from '@nerve-office/contracts'
import { auditEventQuerySchema } from '@nerve-office/contracts'
import { Controller, Get, Query } from '@nestjs/common'
import { SystemAdminOnly } from '../../shared/system-admin-only.ts'
import { AdminAuditService } from './admin-audit.service.ts'

/** 管理界面：审计查询（M2-P1 设计 §3.7，US-M2-13）。只给系统管理员。 */
@Controller('admin/audit-events')
@SystemAdminOnly()
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  async search(@Query({ schema: auditEventQuerySchema }) query: AuditEventQuery): Promise<AuditEventListResponse> {
    return this.audit.search(query)
  }
}
