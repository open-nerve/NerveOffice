import type { SaveContentQuery, SaveContentResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import type { GzipBody } from '../security/index.ts'
import type { DocumentContent } from './document-content.service.ts'
import { documentIdSchema, saveContentQuerySchema } from '@nerve-office/contracts'
import { Controller, Get, Param, Put, Query, UseInterceptors } from '@nestjs/common'
import { RequestOrigin } from '../audit/index.ts'
import { CurrentPrincipal } from '../auth/index.ts'
import { ContentResponseInterceptor } from './content-response.interceptor.ts'
import { DocumentContentService } from './document-content.service.ts'
import { EditLeaseToken } from './edit-lease-header.ts'
import { editingActorOf } from './edit-lease.service.ts'
import { SnapshotUpload, SnapshotUploadInterceptor } from './snapshot-upload.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/** 文档的内容（P4 设计 §3.3）：读取当前快照，按基准修订号保存新的快照。 */
@Controller('documents/:id/content')
export class DocumentContentController {
  constructor(private readonly content: DocumentContentService) {}

  @Get()
  @UseInterceptors(ContentResponseInterceptor)
  async read(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
  ): Promise<DocumentContent> {
    return this.content.read(principal.user.id, id)
  }

  /** 保存（M3-P1 起要求编辑租约）：令牌在请求头 x-edit-lease 里，代次与标签页在查询参数里 */
  @Put()
  @UseInterceptors(SnapshotUploadInterceptor)
  async save(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Query({ schema: saveContentQuerySchema }) query: SaveContentQuery,
    @SnapshotUpload() upload: GzipBody,
    @RequestOrigin() origin: HttpOrigin,
    @EditLeaseToken() token: string | undefined,
  ): Promise<SaveContentResponse> {
    return this.content.save({ ...editingActorOf(principal), token }, id, query, upload, origin)
  }
}
