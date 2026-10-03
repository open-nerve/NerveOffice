import type { AuditEventItem, AuditEventListResponse, AuditEventQuery, AuditUserName } from '@nerve-office/contracts'
import type { AuditRecord } from '../audit/index.ts'
import type { User } from '../users/index.ts'
import { Injectable } from '@nestjs/common'
import { AuditService } from '../audit/index.ts'
import { InvitationsService } from '../auth/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { UsersService } from '../users/index.ts'

/**
 * 账户当前的登录名与显示名，分开给出：界面分别呈现，显示名冒充不了登录名（M2-P6 复核 M2）。
 * 不再给拼好的"显示名（登录名）"（原来对象的 label，只为旧页面保留；v0.1 没有旧页面，M2-P6 第 6 片复核 S2 删掉）
 */
function userName(user: User | undefined): AuditUserName | null {
  return user === undefined ? null : { username: user.username, displayName: user.displayName }
}

/** 对象的名字：审计表只存 id，查询时按类型补上 */
interface TargetNames {
  readonly users: ReadonlyMap<string, User>
  readonly invitations: ReadonlyMap<string, string>
  readonly spaces: ReadonlyMap<string, string>
}

/**
 * 审计查询（M2-P1 设计 §3.7，US-M2-13）：审计表只存 id，这里补上账户（操作者与对象）当前的登录名与显示名、邀请的登录名、
 * 空间当前的名称（M2-P2）；停用的账户同样显示。对象是账户时登录名与显示名分开给出（target.user，M2-P6 复核 M2），
 * 邀请与空间的名字在 target.name。文档不补标题（M2 总设计 §2.1 第 5 条）。
 * 审计的 details 按原样给出：写入时就不含正文、标题、令牌与密码。
 * 一页审计与补上的名字在同一个只读快照里（M2 Codex 评审 CX1）：开场核对确认查的人仍是有效的系统管理员，那一刻的审计才给他。
 * 补名字的三条语句逐条执行：同一个事务只有一个连接，不在上面并发（pg 在一个连接上排队执行的做法已经弃用）
 */
@Injectable()
export class AdminAuditService {
  constructor(
    private readonly audit: AuditService,
    private readonly users: UsersService,
    private readonly invitations: InvitationsService,
    private readonly spaces: SpacesService,
    private readonly transactions: TransactionRunner,
  ) {}

  async search(query: AuditEventQuery): Promise<AuditEventListResponse> {
    return this.transactions.readSnapshot(async (transaction) => {
      const page = await this.audit.search(query, transaction)
      const userIds = page.items.flatMap(item => [
        ...(item.actorType === 'user' && item.actorId !== null ? [item.actorId] : []),
        ...(item.targetType === 'user' && item.targetId !== null ? [item.targetId] : []),
      ])
      const targetsOf = (type: string): string[] => page.items.flatMap(item => (item.targetType === type && item.targetId !== null ? [item.targetId] : []))
      const users = await this.users.findByIds(userIds, transaction)
      const invitations = await this.invitations.usernamesOf(targetsOf('invitation'), transaction)
      const spaces = await this.spaces.namesOf(targetsOf('space'), { transaction })
      return { items: page.items.map(item => this.toItem(item, { users, invitations, spaces })), nextCursor: page.nextCursor }
    })
  }

  private toItem(record: AuditRecord, names: TargetNames): AuditEventItem {
    const actor = record.actorId === null ? undefined : names.users.get(record.actorId)
    let target: AuditEventItem['target'] = null
    if (record.targetType !== null && record.targetId !== null) {
      const user = record.targetType === 'user' ? userName(names.users.get(record.targetId)) : null
      target = { type: record.targetType, id: record.targetId, name: this.nameOf(record.targetType, record.targetId, names), user }
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

  /** 不是账户的对象的名字：账户在 target.user 里分开给出，这里不给 */
  private nameOf(type: string, id: string, names: TargetNames): string | null {
    if (type === 'invitation')
      return names.invitations.get(id) ?? null
    if (type === 'space')
      return names.spaces.get(id) ?? null
    // 文档不补标题（M2 总设计 §2.1 第 5 条）
    return null
  }
}
