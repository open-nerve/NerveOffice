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

  @Put()
  @UseInterceptors(SnapshotUploadInterceptor)
  async save(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Query({ schema: saveContentQuerySchema }) query: SaveContentQuery,
    @SnapshotUpload() upload: GzipBody,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<SaveContentResponse> {
    return this.content.save(principal.user.id, id, query, upload, origin)
  }
}
