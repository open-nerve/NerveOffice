import type { AdminUser } from '@nerve-office/contracts'
import type { AuditEvent } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import type { AccountRecord } from '../users/index.ts'

/** 管理界面里的账户（contracts 的 adminUserSchema） */
export function toAdminUser(account: AccountRecord): AdminUser {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    systemRole: account.systemRole,
    status: account.status,
    createdAt: account.createdAt.toISOString(),
  }
}

/** 审计的操作者：当前登录的系统管理员 */
export function actorOf(principal: Principal): AuditEvent['actor'] {
  return { type: 'user', id: principal.user.id }
}
