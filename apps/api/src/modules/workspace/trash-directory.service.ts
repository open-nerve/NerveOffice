import type { TrashListQuery, TrashListResponse } from '@nerve-office/contracts'
import type { Actor } from '../documents/index.ts'
import { Injectable } from '@nestjs/common'
import { TransactionRunner } from '../database/index.ts'
import { TrashService } from '../documents/index.ts'
import { UsersService } from '../users/index.ts'
import { toTrashEntry } from './workspace-views.ts'

/**
 * 回收站的列表（M2-P4 S3 spec §6）：规则与数据在 documents 的 TrashService，
 * 这里只把删除者的账户 id 换成显示名——documents 模块不依赖 users（设计 §3.1），与成员列表同一个做法。
 * 这个请求的只读快照在这里开（M2 Codex 评审 CX1）：判断权限、列出删除单元与补人名都在同一个快照里
 */
@Injectable()
export class TrashDirectoryService {
  constructor(
    private readonly trash: TrashService,
    private readonly users: UsersService,
    private readonly transactions: TransactionRunner,
  ) {}

  async list(actor: Actor, query: TrashListQuery): Promise<TrashListResponse> {
    return this.transactions.readSnapshot(async (transaction) => {
      const page = await this.trash.list(actor, query, transaction)
      const accounts = await this.users.findByIds(page.items.map(item => item.deletedBy), transaction)
      return { items: page.items.map(item => toTrashEntry(item, accounts.get(item.deletedBy))), nextCursor: page.nextCursor }
    })
  }
}
