import type { InvitationStatus, LinkInvalidReason } from '@nerve-office/contracts'
import type { AuditEvent } from '../audit/index.ts'

/** 一次性链接记录的状态（邀请与重置共用）。"已过期"由查询时数据库算出（expired），不靠定时任务改状态 */
export interface LinkRecordState {
  /** 接受（邀请）或使用（重置）的时间 */
  readonly completedAt: Date | null
  readonly revokedAt: Date | null
  readonly expired: boolean
}

/** 可以用；或者不能用的原因（LINK_INVALID 的 details.reason） */
export type LinkUsability = 'usable' | Exclude<LinkInvalidReason, 'invalid'>

/** 已用、已作废优先于过期：过期之后才被作废的，原因按作废说 */
export function usabilityOf(state: LinkRecordState): LinkUsability {
  if (state.completedAt !== null)
    return 'used'
  if (state.revokedAt !== null)
    return 'revoked'
  return state.expired ? 'expired' : 'usable'
}

/** 按令牌查找的结果：可用；或者不能用的原因，以及审计的对象（找到了记录时才有） */
export type LinkLookup<T>
  = | { readonly usable: true, readonly record: T }
    | { readonly usable: false, readonly reason: LinkInvalidReason, readonly target?: AuditEvent['target'] }

/**
 * 接受或完成时，事务里锁住记录复核之后的结果：完成了；或者不能用的原因（查令牌之后被用过、作废、账户停用）。
 * 不能用时事务之外再按一次失败处理（记审计、锁定时 429），与查令牌时就不能用的一样（M2-P1 审查 A10）
 */
export type LinkOutcome<T>
  = | { readonly done: true, readonly value: T }
    | { readonly done: false, readonly reason: LinkInvalidReason }

/** 管理界面里邀请的状态 */
export function invitationStatusOf(state: LinkRecordState): InvitationStatus {
  const usability = usabilityOf(state)
  return usability === 'usable' ? 'pending' : usability === 'used' ? 'accepted' : usability
}
