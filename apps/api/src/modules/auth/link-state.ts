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

/**
 * 链接不能用（交给 LinkAttempts.rejected）：
 * - 没有这个令牌、格式不对（invalid）：在试令牌，按地址计一次失败。事务里复核时记录不见了也算这一种（记录不删，实际不会发生），
 *   这时审计带上已知的对象；
 * - 找到了记录、只是不能用（过期、已用、已作废）：拿着的是一条真实的旧链接，不计入地址的失败（M2-P6 复核 B3），
 *   另按这条记录计数（M2-P6）；审计的对象是邀请，或者重置对应的账户
 */
export type LinkRejection
  = | { readonly reason: 'invalid', readonly target?: AuditEvent['target'] }
    | { readonly reason: Exclude<LinkUsability, 'usable'>, readonly recordId: string, readonly target: AuditEvent['target'] }

/** 按令牌查找的结果：可用；或者不能用 */
export type LinkLookup<T>
  = | { readonly usable: true, readonly record: T }
    | { readonly usable: false, readonly rejection: LinkRejection }

/**
 * 接受或完成时，事务里锁住记录复核之后的结果：完成了；或者不能用的原因（查令牌之后被用过、作废、账户停用）。
 * 不能用时事务之外再交给 LinkAttempts.rejected（记审计），与查令牌时就不能用的一样（M2-P1 审查 A10）
 */
export type LinkOutcome<T>
  = | { readonly done: true, readonly value: T }
    | { readonly done: false, readonly reason: LinkInvalidReason }

/** 事务里复核不通过时的拒绝：记录找到过（id 与审计的对象），原因是复核时的 */
export function rejectionOf(reason: LinkInvalidReason, recordId: string, target: AuditEvent['target']): LinkRejection {
  return reason === 'invalid' ? { reason, target } : { reason, recordId, target }
}

/** 管理界面里邀请的状态 */
export function invitationStatusOf(state: LinkRecordState): InvitationStatus {
  const usability = usabilityOf(state)
  return usability === 'usable' ? 'pending' : usability === 'used' ? 'accepted' : usability
}
