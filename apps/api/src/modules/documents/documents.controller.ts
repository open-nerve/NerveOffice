import type { CreateDocumentRequest, DocumentDetail, DocumentListQuery, DocumentListResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { createDocumentRequestSchema, documentIdSchema, documentListQuerySchema } from '@nerve-office/contracts'
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { RequestOrigin } from '../audit/index.ts'
import { CurrentPrincipal } from '../auth/index.ts'
import { accessActorOf } from './document-access-policy.ts'
import { DocumentCreationService } from './document-creation.service.ts'
import { DocumentsService } from './documents.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/** 文档（M1-P3 设计 §3.3、P4 设计 §3.3，M2-P2 设计 §3.3）：按空间列出、元数据与新建。 */
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly creation: DocumentCreationService,
  ) {}

  /** 同一个 requestId 的重放同样是 201，返回那份文档的当前元数据：与原请求相同的状态（P4 设计 §3.3）。 */
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body({ schema: createDocumentRequestSchema }) body: CreateDocumentRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<DocumentDetail> {
    return this.creation.create(accessActorOf(principal), body, origin)
  }

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query({ schema: documentListQuerySchema }) query: DocumentListQuery,
  ): Promise<DocumentListResponse> {
    return this.documents.list(accessActorOf(principal), query)
  }

  @Get(':id')
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
  ): Promise<DocumentDetail> {
    return this.documents.get(principal.user.id, id)
  }
}
