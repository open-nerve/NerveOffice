// 编辑租约的规则要的、要查数据库的事实（M3-P1 设计 §3.4.1；M3-P5 设计 §3.6）：持有者的登录与编辑权（有效条件第 6、7 条，
// edit-lease-rules.ts 的 HolderFacts），请求方的登录与编辑权、被保留的人的编辑权（edit-request-rules.ts 的 PartyFacts）。
// 规则决定问不问、先问哪个（同一项持有者的事实至多问一次）；这里只回答，都在调用方的事务或只读快照里查——访问策略看得到
// 同一个事务里刚做的改动。申请、心跳、编辑状态（EditLeaseService）与请求编辑、交出（EditRequestService）共用这一份
import type { SessionService } from '../auth/index.ts'
import type { Transaction } from '../database/index.ts'
import type { AccessTarget, DocumentAccessPolicy } from './document-access-policy.ts'
import type { HolderFacts } from './edit-lease-rules.ts'
import type { ObservedEditLease } from './edit-leases.repository.ts'
import type { PartyFacts } from './edit-request-rules.ts'
import { canEditDocument } from './document-access-policy.ts'

/** 第 6、7 条：持有者绑定的登录仍然有效（auth）；持有者对这份文档仍有编辑权。没有租约时规则不会问 */
export function holderFactsOf(sessions: SessionService, policy: DocumentAccessPolicy, lease: ObservedEditLease | undefined, document: AccessTarget, transaction: Transaction): HolderFacts {
  return {
    sessionActive: async () => lease !== undefined && sessions.isActive(lease.sessionId, transaction),
    holderCanEdit: async () => lease !== undefined && canEditDocument(policy, lease.holderId, document, transaction),
  }
}

/** 请求方绑定的登录仍然有效；请求方、被保留的人对这份文档仍能编辑（与持有者的编辑权同一个判断） */
export function partyFactsOf(sessions: SessionService, policy: DocumentAccessPolicy, document: AccessTarget, transaction: Transaction): PartyFacts {
  return {
    sessionActive: async sessionId => sessions.isActive(sessionId, transaction),
    canEdit: async userId => canEditDocument(policy, userId, document, transaction),
  }
}
