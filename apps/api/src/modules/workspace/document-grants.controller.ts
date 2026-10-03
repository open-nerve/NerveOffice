import type { DocumentGrant, DocumentGrantListResponse, SetDocumentGrantRequest } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { documentIdSchema, setDocumentGrantRequestSchema, userIdSchema } from '@nerve-office/contracts'
import { Body, Controller, Delete, Get, HttpCode, Param, Put } from '@nestjs/common'
import { RequestOrigin } from '../audit/index.ts'
import { CurrentPrincipal } from '../auth/index.ts'
import { accessActorOf } from '../documents/index.ts'
import { DocumentSharingService } from './document-sharing.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/**
 * 一份文档的单独授权（M2-P5 设计 §3.2，US-M2-10）：查看、设置或调整、取消。只有空间管理员与个人空间的所有者能分享，
 * 归档的空间里冻结；设置与取消都按状态幂等，不带 requestId（规范 §4 只要求新建与保存带）。
 * 挂在 workspace：写入要锁被授权人的账户行、响应要补人名，documents 不依赖 users（设计 §3.1）。
 */
@Controller('documents/:id/grants')
export class DocumentGrantsController {
  constructor(private readonly sharing: DocumentSharingService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
  ): Promise<DocumentGrantListResponse> {
    return this.sharing.list(accessActorOf(principal), id)
  }

  /** 设置或调整：200，返回这一条授权（已有同样的角色时什么都不写，照样 200） */
  @Put(':userId')
  async set(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Param('userId', { schema: userIdSchema }) userId: string,
    @Body({ schema: setDocumentGrantRequestSchema }) body: SetDocumentGrantRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<DocumentGrant> {
    return this.sharing.set(accessActorOf(principal), id, userId, body.role, origin)
  }

  /** 取消：204，没有响应体；没有这条授权时同样 204 */
  @Delete(':userId')
  @HttpCode(204)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Param('userId', { schema: userIdSchema }) userId: string,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<void> {
    await this.sharing.remove(accessActorOf(principal), id, userId, origin)
  }
}
