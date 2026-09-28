import type { AuditEventItem, AuditEventListResponse, AuditEventQuery } from '@nerve-office/contracts'
import type { AuditRecord } from '../audit/index.ts'
import type { User } from '../users/index.ts'
import { Injectable } from '@nestjs/common'
import { AuditService } from '../audit/index.ts'
import { InvitationsService } from '../auth/index.ts'
import { UsersService } from '../users/index.ts'

/** 账户在审计里的名字：显示名（登录名） */
function userLabel(user: User | undefined): string | null {
  return user === undefined ? null : `${user.displayName}（${user.username}）`
}

/**
 * 审计查询（M2-P1 设计 §3.7，US-M2-13）：审计表只存 id，这里补上账户（操作者与对象）当前的登录名与显示名、邀请的登录名；
 * 停用的账户同样显示。审计的 details 按原样给出：写入时就不含正文、标题、令牌与密码。
 */
@Injectable()
export class AdminAuditService {
  constructor(
    private readonly audit: AuditService,
    private readonly users: UsersService,
    private readonly invitations: InvitationsService,
  ) {}

  async search(query: AuditEventQuery): Promise<AuditEventListResponse> {
    const page = await this.audit.search(query)
    const userIds = page.items.flatMap(item => [
      ...(item.actorType === 'user' && item.actorId !== null ? [item.actorId] : []),
      ...(item.targetType === 'user' && item.targetId !== null ? [item.targetId] : []),
    ])
    const invitationIds = page.items.flatMap(item => (item.targetType === 'invitation' && item.targetId !== null ? [item.targetId] : []))
    const [users, invitations] = await Promise.all([this.users.findByIds(userIds), this.invitations.usernamesOf(invitationIds)])
    return { items: page.items.map(item => this.toItem(item, users, invitations)), nextCursor: page.nextCursor }
  }

  private toItem(record: AuditRecord, users: ReadonlyMap<string, User>, invitations: ReadonlyMap<string, string>): AuditEventItem {
    const actor = record.actorId === null ? undefined : users.get(record.actorId)
    let target: AuditEventItem['target'] = null
    if (record.targetType !== null && record.targetId !== null) {
      const label = record.targetType === 'user'
        ? userLabel(users.get(record.targetId))
        : record.targetType === 'invitation' ? invitations.get(record.targetId) ?? null : null
      target = { type: record.targetType, id: record.targetId, label }
    }
    return {
      id: record.id,
      occurredAt: record.occurredAt.toISOString(),
      action: record.action,
      actor: { type: record.actorType, id: record.actorId, username: actor?.username ?? null, displayName: actor?.displayName ?? null },
      target,
      source: record.source,
      requestId: record.requestId,
      clientIp: record.clientIp,
      details: record.details,
    }
  }
}
