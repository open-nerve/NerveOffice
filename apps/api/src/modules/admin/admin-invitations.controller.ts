import type { CreateInvitationRequest, Invitation, InvitationListQuery, InvitationListResponse, IssuedInvitation } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { createInvitationRequestSchema, invitationIdSchema, invitationListQuerySchema } from '@nerve-office/contracts'
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common'
import { SystemAdminOnly } from '../../shared/system-admin-only.ts'
import { RequestOrigin } from '../audit/index.ts'
import { CurrentPrincipal, InvitationsService } from '../auth/index.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/** 管理界面：邀请（M2-P1 设计 §3.3、§3.4）。只给系统管理员；链接只在签发与重发的响应里出现一次。 */
@Controller('admin/invitations')
@SystemAdminOnly()
export class AdminInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  async list(@Query({ schema: invitationListQuerySchema }) query: InvitationListQuery): Promise<InvitationListResponse> {
    return this.invitations.list(query)
  }

  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body({ schema: createInvitationRequestSchema }) body: CreateInvitationRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<IssuedInvitation> {
    return this.invitations.issue(principal.user, body, origin)
  }

  @Post(':id/revoke')
  @HttpCode(200)
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: invitationIdSchema }) id: string,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<Invitation> {
    return this.invitations.revoke(principal.user, id, origin)
  }

  @Post(':id/reissue')
  async reissue(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: invitationIdSchema }) id: string,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<IssuedInvitation> {
    return this.invitations.reissue(principal.user, id, origin)
  }
}
