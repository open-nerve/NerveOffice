import type { ClearDocumentHistoryResponse, CreatedDocument, DocumentHistoryDetail, DocumentHistoryListResponse, HistoryListQuery, RestoreDocumentHistoryRequest } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { documentHistoryIdSchema, documentIdSchema, historyListQuerySchema, restoreDocumentHistoryRequestSchema } from '@nerve-office/contracts'
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseInterceptors } from '@nestjs/common'
import { BackgroundRequest } from '../../shared/background-request.ts'
import { RequestOrigin } from '../audit/index.ts'
import { CurrentPrincipal } from '../auth/index.ts'
import { accessActorOf, DocumentHistoryClearService, DocumentHistoryRestoreService } from '../documents/index.ts'
import { DocumentHistoryDirectoryService } from './document-history-directory.service.ts'
import { HistoryContentInterceptor } from './history-content.interceptor.ts'

@Controller('documents/:id/history')
export class DocumentHistoryController {
  constructor(
    private readonly directory: DocumentHistoryDirectoryService,
    private readonly restoration: DocumentHistoryRestoreService,
    private readonly clearing: DocumentHistoryClearService,
  ) {}

  @Delete()
  async clear(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @RequestOrigin() origin: Extract<AuditOrigin, { source: 'http' }>,
  ): Promise<ClearDocumentHistoryResponse> {
    return this.clearing.clear(accessActorOf(principal), id, origin)
  }

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Query({ schema: historyListQuerySchema }) query: HistoryListQuery,
  ): Promise<DocumentHistoryListResponse> {
    return this.directory.list(accessActorOf(principal), id, query)
  }

  @Get(':historyId')
  @BackgroundRequest()
  async detail(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Param('historyId', { schema: documentHistoryIdSchema }) historyId: string,
  ): Promise<DocumentHistoryDetail> {
    return this.directory.detail(accessActorOf(principal), id, historyId)
  }

  @Get(':historyId/content')
  @BackgroundRequest()
  @UseInterceptors(HistoryContentInterceptor)
  async content(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Param('historyId', { schema: documentHistoryIdSchema }) historyId: string,
  ): Promise<Buffer> {
    return this.directory.content(accessActorOf(principal), id, historyId)
  }

  @Post(':historyId/restore')
  @HttpCode(201)
  async restore(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Param('historyId', { schema: documentHistoryIdSchema }) historyId: string,
    @Body({ schema: restoreDocumentHistoryRequestSchema }) command: RestoreDocumentHistoryRequest,
    @RequestOrigin() origin: Extract<AuditOrigin, { source: 'http' }>,
  ): Promise<CreatedDocument> {
    return this.restoration.restore(accessActorOf(principal), id, historyId, command, origin)
  }
}
