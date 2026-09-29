import type { RenameSpaceRequest, SpaceListResponse, SpaceView, TeamSpace } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { renameSpaceRequestSchema, spaceIdSchema } from '@nerve-office/contracts'
import { Body, Controller, Get, Param, Put } from '@nestjs/common'
import { RequestOrigin } from '../audit/index.ts'
import { CurrentPrincipal } from '../auth/index.ts'
import { accessActorOf } from '../documents/index.ts'
import { SpaceDirectoryService } from './space-directory.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/** 空间（M2-P2 设计 §3.3）：我能看到的空间、空间页头、改名。 */
@Controller('spaces')
export class SpacesController {
  constructor(private readonly directory: SpaceDirectoryService) {}

  @Get()
  async list(@CurrentPrincipal() principal: Principal): Promise<SpaceListResponse> {
    return this.directory.list(accessActorOf(principal))
  }

  @Get(':id')
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: spaceIdSchema }) id: string,
  ): Promise<SpaceView> {
    return this.directory.get(accessActorOf(principal), id)
  }

  @Put(':id/name')
  async rename(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: spaceIdSchema }) id: string,
    @Body({ schema: renameSpaceRequestSchema }) body: RenameSpaceRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<TeamSpace> {
    return this.directory.rename(principal, id, body.name, origin)
  }
}
