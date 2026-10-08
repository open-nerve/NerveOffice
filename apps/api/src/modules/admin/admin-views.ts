import type { AdminSpace, AdminUser } from '@nerve-office/contracts'
import type { AuditEvent } from '../audit/index.ts'
import type { LoginLock, Principal } from '../auth/index.ts'
import type { LocalKeyState } from '../local-keys/index.ts'
import type { TeamSpaceOverview } from '../spaces/index.ts'
import type { AccountRecord } from '../users/index.ts'

/**
 * 管理界面里的账户（contracts 的 adminUserSchema）；loginLock 是登录的锁定，没有锁定时不给（M2-P6 复核 A1）；
 * localKey 是当前的本机密钥的摘要，从没取过时不给（M3-P6 设计 §3.5）——只有版本与生成的时刻，没有任何密钥材料
 */
export function toAdminUser(account: AccountRecord, loginLock: LoginLock | undefined, localKey: LocalKeyState | undefined): AdminUser {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    systemRole: account.systemRole,
    status: account.status,
    createdAt: account.createdAt.toISOString(),
    loginLock: loginLock === undefined ? null : { until: loginLock.until.toISOString(), allSources: loginLock.allSources },
    localKey: localKey === undefined ? null : { version: localKey.version, createdAt: localKey.createdAt.toISOString() },
  }
}

/** 审计的操作者：当前登录的系统管理员 */
export function actorOf(principal: Principal): AuditEvent['actor'] {
  return { type: 'user', id: principal.user.id }
}

/** 管理界面里的团队空间（contracts 的 adminSpaceSchema） */
export function toAdminSpace(space: TeamSpaceOverview): AdminSpace {
  return {
    id: space.id,
    name: space.name,
    status: space.status,
    visibleToAll: space.visibleToAll,
    memberCount: space.memberCount,
    createdAt: space.createdAt.toISOString(),
    myRole: space.myRole,
  }
}
