import type { RestoredTrashEntry, TrashListQuery, TrashListResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { documentIdSchema, folderIdSchema, trashEntryIdSchema, trashListQuerySchema } from '@nerve-office/contracts'
import { Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common'
import { RequestOrigin } from '../audit/index.ts'
import { CurrentPrincipal } from '../auth/index.ts'
import { accessActorOf, TrashService } from '../documents/index.ts'
import { TrashDirectoryService } from './trash-directory.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/**
 * 回收站（M2-P4 设计 §3.2，规则细则见 P4-S3 的 spec）：删除文档与文件夹、按空间列出、恢复、永久删除。
 * 删除的路径挂在被删的东西上（/documents/{id}、/folders/{id}），所以这个控制器不设统一前缀；
 * 删除、恢复与永久删除是同一件事的三个阶段，放在一起看得清楚。
 */
@Controller()
export class TrashController {
  constructor(
    private readonly trash: TrashService,
    private readonly directory: TrashDirectoryService,
  ) {}

  /** 删除一份文档：进所在空间的回收站，没有响应体。 */
  @Delete('documents/:id')
  @HttpCode(204)
  async deleteDocument(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<void> {
    await this.trash.deleteDocument(accessActorOf(principal), id, origin)
  }

  /** 删除一个文件夹：连同它当时正常状态的整棵子树进回收站，没有响应体。 */
  @Delete('folders/:id')
  @HttpCode(204)
  async deleteFolder(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: folderIdSchema }) id: string,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<void> {
    await this.trash.deleteFolder(accessActorOf(principal), id, origin)
  }

  /** 按空间列出删除单元：看得到空间内容的人都看得到，能不能动由每一条的 permissions 给出。 */
  @Get('trash')
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query({ schema: trashListQuerySchema }) query: TrashListQuery,
  ): Promise<TrashListResponse> {
    return this.directory.list(accessActorOf(principal), query)
  }

  /** 恢复：整单回到原位置；原位置不在时回到空间的根目录，响应里带标志。改动已有的东西，所以是 200。 */
  @Post('trash/:entryId/restore')
  @HttpCode(200)
  async restore(
    @CurrentPrincipal() principal: Principal,
    @Param('entryId', { schema: trashEntryIdSchema }) entryId: string,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<RestoredTrashEntry> {
    return this.trash.restore(accessActorOf(principal), entryId, origin)
  }

  /** 永久删除：空间管理员 / 个人空间的所有者，没有响应体。 */
  @Delete('trash/:entryId')
  @HttpCode(204)
  async purge(
    @CurrentPrincipal() principal: Principal,
    @Param('entryId', { schema: trashEntryIdSchema }) entryId: string,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<void> {
    await this.trash.purge(accessActorOf(principal), entryId, origin)
  }
}
