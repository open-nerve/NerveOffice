import type { AdminUserDocumentListQuery, AdminUserDocumentListResponse, TransferDocumentsRequest, TransferDocumentsResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { adminUserDocumentListQuerySchema, transferDocumentsRequestSchema, userIdSchema } from '@nerve-office/contracts'
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common'
import { SystemAdminOnly } from '../../shared/system-admin-only.ts'
import { RequestOrigin } from '../audit/index.ts'
import { CurrentPrincipal } from '../auth/index.ts'
import { AdminTransferService } from './admin-transfer.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/** 管理界面：停用者个人空间里的文档（M2-P2 设计 §3.3、§3.8，US-M2-04）——只看得到标题，整批转移。只给系统管理员。 */
@Controller('admin/users/:id/documents')
@SystemAdminOnly()
export class AdminUserDocumentsController {
  constructor(private readonly transfers: AdminTransferService) {}

  @Get()
  async titles(
    @Param('id', { schema: userIdSchema }) id: string,
    @Query({ schema: adminUserDocumentListQuerySchema }) query: AdminUserDocumentListQuery,
  ): Promise<AdminUserDocumentListResponse> {
    return this.transfers.titles(id, query)
  }

  @Post('transfer')
  @HttpCode(200)
  async transfer(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: userIdSchema }) id: string,
    @Body({ schema: transferDocumentsRequestSchema }) body: TransferDocumentsRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<TransferDocumentsResponse> {
    return this.transfers.transfer(principal, id, body, origin)
  }
}
