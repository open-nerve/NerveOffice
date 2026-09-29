import type { AdminUser, AdminUserListQuery, AdminUserListResponse, ChangeSystemRoleRequest, IssuedPasswordReset } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { adminUserListQuerySchema, changeSystemRoleRequestSchema, userIdSchema } from '@nerve-office/contracts'
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common'
import { SystemAdminOnly } from '../../shared/system-admin-only.ts'
import { RequestOrigin } from '../audit/index.ts'
import { CurrentPrincipal, PasswordResetsService } from '../auth/index.ts'
import { AdminUsersService } from './admin-users.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/** 管理界面：账户（M2-P1 设计 §3.3）。只给系统管理员。 */
@Controller('admin/users')
@SystemAdminOnly()
export class AdminUsersController {
  constructor(
    private readonly accounts: AdminUsersService,
    private readonly resets: PasswordResetsService,
  ) {}

  @Get()
  async list(@Query({ schema: adminUserListQuerySchema }) query: AdminUserListQuery): Promise<AdminUserListResponse> {
    return this.accounts.list(query)
  }

  @Get(':id')
  async get(@Param('id', { schema: userIdSchema }) id: string): Promise<AdminUser> {
    return this.accounts.get(id)
  }

  @Post(':id/disable')
  @HttpCode(200)
  async disable(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: userIdSchema }) id: string,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<AdminUser> {
    return this.accounts.disable(principal, id, origin)
  }

  @Post(':id/enable')
  @HttpCode(200)
  async enable(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: userIdSchema }) id: string,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<AdminUser> {
    return this.accounts.enable(principal, id, origin)
  }

  /** 签发重置链接（US-M2-03）：同时撤销这个人的全部会话；链接只在这里出现一次 */
  @Post(':id/password-reset')
  async issuePasswordReset(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: userIdSchema }) id: string,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<IssuedPasswordReset> {
    return this.resets.issue({ type: 'user', id: principal.user.id }, id, origin)
  }

  @Put(':id/system-role')
  async changeSystemRole(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: userIdSchema }) id: string,
    @Body({ schema: changeSystemRoleRequestSchema }) body: ChangeSystemRoleRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<AdminUser> {
    return this.accounts.changeSystemRole(principal, id, body.systemRole, origin)
  }
}
