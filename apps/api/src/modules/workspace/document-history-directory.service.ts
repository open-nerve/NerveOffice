import type { DocumentHistoryDetail, DocumentHistoryListResponse, HistoryListQuery } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import type { Actor } from '../documents/index.ts'
import { Injectable } from '@nestjs/common'
import { TransactionRunner } from '../database/index.ts'
import { DocumentHistoryService } from '../documents/index.ts'
import { UsersService } from '../users/index.ts'
import { accountIn, toUserSummary } from './workspace-views.ts'

/** 权限、原历史与人名都归属于请求的同一个只读快照。 */
@Injectable()
export class DocumentHistoryDirectoryService {
  constructor(
    private readonly history: DocumentHistoryService,
    private readonly users: UsersService,
    private readonly transactions: TransactionRunner,
  ) {}

  async list(actor: Actor, documentId: string, query: HistoryListQuery): Promise<DocumentHistoryListResponse> {
    return this.transactions.readSnapshot(async (tx) => {
      const page = await this.history.list(actor, documentId, query, tx)
      const accounts = await this.users.findByIds(page.items.map(item => item.savedBy), tx)
      return { items: page.items.map(item => ({ ...item, savedBy: toUserSummary(accountIn(accounts, item.savedBy)) })), nextCursor: page.nextCursor }
    })
  }

  async detail(actor: Actor, documentId: string, historyId: string): Promise<DocumentHistoryDetail> {
    return this.transactions.readSnapshot(async (tx) => {
      const item = await this.history.detail(actor, documentId, historyId, tx)
      const accounts = await this.users.findByIds([item.savedBy], tx)
      return { ...item, savedBy: toUserSummary(accountIn(accounts, item.savedBy)) }
    })
  }

  async content(actor: Actor, documentId: string, historyId: string): Promise<Buffer> {
    return this.transactions.readSnapshot(async tx => this.history.content(actor, documentId, historyId, tx))
  }
}
