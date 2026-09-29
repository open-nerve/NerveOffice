import type { AdminSpace, AdminSpaceListQuery, AdminSpaceListResponse, ChangeSpaceVisibilityRequest, CreateTeamSpaceRequest } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { adminSpaceListQuerySchema, changeSpaceVisibilityRequestSchema, createTeamSpaceRequestSchema, spaceIdSchema } from '@nerve-office/contracts'
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common'
import { SystemAdminOnly } from '../../shared/system-admin-only.ts'
import { RequestOrigin } from '../audit/index.ts'
import { CurrentPrincipal } from '../auth/index.ts'
import { AdminSpacesService } from './admin-spaces.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/** 管理界面：团队空间（M2-P2 设计 §3.3）。只给系统管理员。 */
@Controller('admin/spaces')
@SystemAdminOnly()
export class AdminSpacesController {
  constructor(private readonly spaces: AdminSpacesService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query({ schema: adminSpaceListQuerySchema }) query: AdminSpaceListQuery,
  ): Promise<AdminSpaceListResponse> {
    return this.spaces.list(principal, query)
  }

  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body({ schema: createTeamSpaceRequestSchema }) body: CreateTeamSpaceRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<AdminSpace> {
    return this.spaces.create(principal, body, origin)
  }

  @Put(':id/visibility')
  async setVisibility(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: spaceIdSchema }) id: string,
    @Body({ schema: changeSpaceVisibilityRequestSchema }) body: ChangeSpaceVisibilityRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<AdminSpace> {
    return this.spaces.setVisibility(principal, id, body.visibleToAll, origin)
  }

  @Post(':id/archive')
  @HttpCode(200)
  async archive(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: spaceIdSchema }) id: string,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<AdminSpace> {
    return this.spaces.setStatus(principal, id, 'archived', origin)
  }

  @Post(':id/restore')
  @HttpCode(200)
  async restore(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: spaceIdSchema }) id: string,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<AdminSpace> {
    return this.spaces.setStatus(principal, id, 'active', origin)
  }
}
