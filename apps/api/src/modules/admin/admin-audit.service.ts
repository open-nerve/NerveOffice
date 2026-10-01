import type { AuditEventItem, AuditEventListResponse, AuditEventQuery, AuditUserName } from '@nerve-office/contracts'
import type { AuditRecord } from '../audit/index.ts'
import type { User } from '../users/index.ts'
import { Injectable } from '@nestjs/common'
import { AuditService } from '../audit/index.ts'
import { InvitationsService } from '../auth/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { UsersService } from '../users/index.ts'

/**
 * 账户在审计里拼好的名字：显示名（登录名）。只为打开着的旧页面保留（对象的 label，接口只做加法）：
 * 显示名是本人填的，可以写成"李四（lisi）"，新页面用分开给出的 user（M2-P6 复核 M2）
 */
function userLabel(user: User | undefined): string | null {
  return user === undefined ? null : `${user.displayName}（${user.username}）`
}

/** 账户当前的登录名与显示名，分开给出：界面分别呈现，显示名冒充不了登录名（M2-P6 复核 M2） */
function userName(user: User | undefined): AuditUserName | null {
  return user === undefined ? null : { username: user.username, displayName: user.displayName }
}

/** 对象的名字：审计表只存 id，查询时按类型补上 */
interface TargetLabels {
  readonly users: ReadonlyMap<string, User>
  readonly invitations: ReadonlyMap<string, string>
  readonly spaces: ReadonlyMap<string, string>
}

/**
 * 审计查询（M2-P1 设计 §3.7，US-M2-13）：审计表只存 id，这里补上账户（操作者与对象）当前的登录名与显示名、邀请的登录名、
 * 空间当前的名称（M2-P2）；停用的账户同样显示。对象是账户时登录名与显示名分开给出（target.user，M2-P6 复核 M2）。
 * 文档不补标题（M2 总设计 §2.1 第 5 条）。
 * 审计的 details 按原样给出：写入时就不含正文、标题、令牌与密码。
 */
@Injectable()
export class AdminAuditService {
  constructor(
    private readonly audit: AuditService,
    private readonly users: UsersService,
    private readonly invitations: InvitationsService,
    private readonly spaces: SpacesService,
  ) {}

  async search(query: AuditEventQuery): Promise<AuditEventListResponse> {
    const page = await this.audit.search(query)
    const userIds = page.items.flatMap(item => [
      ...(item.actorType === 'user' && item.actorId !== null ? [item.actorId] : []),
      ...(item.targetType === 'user' && item.targetId !== null ? [item.targetId] : []),
    ])
    const targetsOf = (type: string): string[] => page.items.flatMap(item => (item.targetType === type && item.targetId !== null ? [item.targetId] : []))
    const [users, invitations, spaces] = await Promise.all([
      this.users.findByIds(userIds),
      this.invitations.usernamesOf(targetsOf('invitation')),
      this.spaces.namesOf(targetsOf('space')),
    ])
    return { items: page.items.map(item => this.toItem(item, { users, invitations, spaces })), nextCursor: page.nextCursor }
  }

  private toItem(record: AuditRecord, labels: TargetLabels): AuditEventItem {
    const actor = record.actorId === null ? undefined : labels.users.get(record.actorId)
    let target: AuditEventItem['target'] = null
    if (record.targetType !== null && record.targetId !== null) {
      const user = record.targetType === 'user' ? userName(labels.users.get(record.targetId)) : null
      target = { type: record.targetType, id: record.targetId, label: this.labelOf(record.targetType, record.targetId, labels), user }
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

  private labelOf(type: string, id: string, labels: TargetLabels): string | null {
    if (type === 'user')
      return userLabel(labels.users.get(id))
    if (type === 'invitation')
      return labels.invitations.get(id) ?? null
    if (type === 'space')
      return labels.spaces.get(id) ?? null
    // 文档不补标题（M2 总设计 §2.1 第 5 条）
    return null
  }
}
