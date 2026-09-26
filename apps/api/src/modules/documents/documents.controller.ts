import type { DocumentDetail, DocumentListQuery, DocumentListResponse } from '@nerve-office/contracts'
import type { Principal } from '../auth/index.ts'
import { documentIdSchema, documentListQuerySchema } from '@nerve-office/contracts'
import { Controller, Get, Param, Query } from '@nestjs/common'
import { CurrentPrincipal } from '../auth/index.ts'
import { DocumentsService } from './documents.service.ts'

/** 文档（P3 设计 §3.3）：个人空间的列表与元数据。 */
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query({ schema: documentListQuerySchema }) query: DocumentListQuery,
  ): Promise<DocumentListResponse> {
    return this.documents.listPersonal(principal.user.id, query)
  }

  @Get(':id')
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
  ): Promise<DocumentDetail> {
    return this.documents.get(principal.user.id, id)
  }
}
