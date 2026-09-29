import type { AddSpaceMemberRequest, ChangeSpaceMemberRoleRequest, SpaceMember, SpaceMemberListResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { addSpaceMemberRequestSchema, changeSpaceMemberRoleRequestSchema, spaceIdSchema, userIdSchema } from '@nerve-office/contracts'
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common'
import { RequestOrigin } from '../audit/index.ts'
import { CurrentPrincipal } from '../auth/index.ts'
import { accessActorOf } from '../documents/index.ts'
import { SpaceMembershipService } from './space-membership.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/** 团队空间的成员（M2-P2 设计 §3.3，US-M2-06）：查看、添加、调整角色、移出。 */
@Controller('spaces/:id/members')
export class SpaceMembersController {
  constructor(private readonly membership: SpaceMembershipService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: spaceIdSchema }) id: string,
  ): Promise<SpaceMemberListResponse> {
    return this.membership.list(accessActorOf(principal), id)
  }

  @Post()
  async add(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: spaceIdSchema }) id: string,
    @Body({ schema: addSpaceMemberRequestSchema }) body: AddSpaceMemberRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<SpaceMember> {
    return this.membership.add(principal, id, body, origin)
  }

  @Put(':userId')
  async changeRole(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: spaceIdSchema }) id: string,
    @Param('userId', { schema: userIdSchema }) userId: string,
    @Body({ schema: changeSpaceMemberRoleRequestSchema }) body: ChangeSpaceMemberRoleRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<SpaceMember> {
    return this.membership.changeRole(principal, id, userId, body.role, origin)
  }

  @Delete(':userId')
  @HttpCode(204)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: spaceIdSchema }) id: string,
    @Param('userId', { schema: userIdSchema }) userId: string,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<void> {
    await this.membership.remove(principal, id, userId, origin)
  }
}
