import type { SharedListQuery, SharedListResponse } from '@nerve-office/contracts'
import type { Actor } from '../documents/index.ts'
import { Injectable } from '@nestjs/common'
import { SharedDocumentsService } from '../documents/index.ts'
import { UsersService } from '../users/index.ts'
import { ownerIdsOf, toSharedDocument } from './workspace-views.ts'

/**
 * "与我共享"（M2-P5 设计 §3.4(4)，US-M2-10）：范围、分页与每条的内容权限在 documents 的 SharedDocumentsService，
 * 这里只把个人空间的所有者换成人名（用 owner_user_id 经 users 补上，不给个人空间存的名称：它可以伪造，规范 §2.4）
 */
@Injectable()
export class SharedDirectoryService {
  constructor(
    private readonly shared: SharedDocumentsService,
    private readonly users: UsersService,
  ) {}

  async list(actor: Actor, query: SharedListQuery): Promise<SharedListResponse> {
    const page = await this.shared.list(actor, query)
    const owners = await this.users.findByIds(ownerIdsOf(page.items.map(item => item.space)))
    return { items: page.items.map(item => toSharedDocument(item, owners)), nextCursor: page.nextCursor }
  }
}
