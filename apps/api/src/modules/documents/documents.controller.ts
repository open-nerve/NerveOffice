import type { CopyDocumentRequest, CreatedDocument, CreateDocumentRequest, DocumentDetail, DocumentListQuery, DocumentListResponse, MoveDocumentRequest, UpdateDocumentRequest } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { copyDocumentRequestSchema, createDocumentRequestSchema, documentIdSchema, documentListQuerySchema, moveDocumentRequestSchema, updateDocumentRequestSchema } from '@nerve-office/contracts'
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common'
import { RequestOrigin } from '../audit/index.ts'
import { CurrentPrincipal } from '../auth/index.ts'
import { accessActorOf } from './document-access-policy.ts'
import { DocumentCopyService } from './document-copy.service.ts'
import { DocumentCreationService } from './document-creation.service.ts'
import { DocumentOrganizingService } from './document-organizing.service.ts'
import { DocumentsService } from './documents.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/** 文档（M1-P3 设计 §3.3、P4 设计 §3.3，M2-P2 设计 §3.3，M2-P4 设计 §3.2）：按空间列出、元数据、新建与整理（改名、移动、复制）。 */
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly creation: DocumentCreationService,
    private readonly organizing: DocumentOrganizingService,
    private readonly copying: DocumentCopyService,
  ) {}

  /**
   * 同一个 requestId 的重放同样是 201，返回那份文档的当前元数据：与原请求相同的状态（P4 设计 §3.3）；
   * 响应里的 replayed 说明这次是不是重放（M2-P6 复核第二批 S-1）。
   */
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body({ schema: createDocumentRequestSchema }) body: CreateDocumentRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<CreatedDocument> {
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

  /** 改名或在同一个空间里移动。 */
  @Patch(':id')
  async update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Body({ schema: updateDocumentRequestSchema }) body: UpdateDocumentRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<DocumentDetail> {
    return this.organizing.update(accessActorOf(principal), id, body, origin)
  }

  /** 移动到某个空间的某个位置：改动已有的文档，不是新建，所以是 200。 */
  @Post(':id/move')
  @HttpCode(200)
  async move(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Body({ schema: moveDocumentRequestSchema }) body: MoveDocumentRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<DocumentDetail> {
    return this.organizing.move(accessActorOf(principal), id, body, origin)
  }

  /** 复制：建出一份新文档，所以是 201；同一个 requestId 的重放同样是 201，返回那份副本、replayed 为真（与新建相同）。 */
  @Post(':id/copy')
  async copy(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Body({ schema: copyDocumentRequestSchema }) body: CopyDocumentRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<CreatedDocument> {
    return this.copying.copy(accessActorOf(principal), id, body, origin)
  }
}
