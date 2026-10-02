import type { CreatedFolder, CreateFolderRequest, Folder, FolderListQuery, FolderListResponse, MoveFolderRequest, UpdateFolderRequest } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { createFolderRequestSchema, folderIdSchema, folderListQuerySchema, moveFolderRequestSchema, updateFolderRequestSchema } from '@nerve-office/contracts'
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common'
import { RequestOrigin } from '../audit/index.ts'
import { CurrentPrincipal } from '../auth/index.ts'
import { accessActorOf, FoldersService } from '../documents/index.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/** 空间里的文件夹（M2-P4 设计 §3.2）：列出一层、新建、改名或在同一个空间里移动。 */
@Controller('folders')
export class FoldersController {
  constructor(private readonly folders: FoldersService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query({ schema: folderListQuerySchema }) query: FolderListQuery,
  ): Promise<FolderListResponse> {
    return this.folders.list(accessActorOf(principal), query)
  }

  /** 同一个 requestId 的重放同样是 201，返回那个文件夹、replayed 为真（与新建文档相同，M2-P6 复核第二批 S-1）。 */
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body({ schema: createFolderRequestSchema }) body: CreateFolderRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<CreatedFolder> {
    return this.folders.create(accessActorOf(principal), body, origin)
  }

  @Patch(':id')
  async update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: folderIdSchema }) id: string,
    @Body({ schema: updateFolderRequestSchema }) body: UpdateFolderRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<Folder> {
    return this.folders.update(accessActorOf(principal), id, body, origin)
  }

  /** 连同子树移动到某个空间的某个位置：改动已有的文件夹，不是新建，所以是 200（与移动文档一致）。 */
  @Post(':id/move')
  @HttpCode(200)
  async move(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: folderIdSchema }) id: string,
    @Body({ schema: moveFolderRequestSchema }) body: MoveFolderRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<Folder> {
    return this.folders.move(accessActorOf(principal), id, body, origin)
  }
}
