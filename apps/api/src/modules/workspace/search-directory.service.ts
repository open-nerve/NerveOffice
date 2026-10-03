import type { SearchQuery, SearchResponse } from '@nerve-office/contracts'
import type { Actor } from '../documents/index.ts'
import { Injectable } from '@nestjs/common'
import { TransactionRunner } from '../database/index.ts'
import { DocumentSearchService } from '../documents/index.ts'
import { UsersService } from '../users/index.ts'
import { ownerIdsOf, toSearchResult } from './workspace-views.ts'

/**
 * 按标题搜索（M2-P4 设计 §3.2，M2-P5 设计 §3.4(2)）：范围、不变量、凭授权命中与目录结构都在 documents 的 DocumentSearchService，
 * 这里只把个人空间的所有者换成人名——documents 不依赖 users（与回收站的删除者同一个做法）。一页一条语句（按所有者的 id 批量取）。
 * 这个请求的只读快照在这里开（M2 Codex 评审 CX1）：搜索的每一条语句与补人名都在同一个快照里
 */
@Injectable()
export class SearchDirectoryService {
  constructor(
    private readonly documents: DocumentSearchService,
    private readonly users: UsersService,
    private readonly transactions: TransactionRunner,
  ) {}

  async search(actor: Actor, query: SearchQuery): Promise<SearchResponse> {
    return this.transactions.readSnapshot(async (transaction) => {
      const page = await this.documents.search(actor, query, transaction)
      const owners = await this.users.findByIds(ownerIdsOf(page.items.map(item => item.space)), transaction)
      return { items: page.items.map(item => toSearchResult(item, owners)), nextCursor: page.nextCursor }
    })
  }
}
