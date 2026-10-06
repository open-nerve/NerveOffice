// 请求编辑（M3-P5 设计 §3.6）：槽里的请求还算不算数，发出与续期时怎样回答（contracts 的 EditRequestOutcome 的 kind）、要不要写。
// 只按事实判断，自己不查询：请求方的登录与编辑权、被保留的人的编辑权要查数据库，事实由调用方以函数的形式给出，规则决定问不问。
// 谁占着这份文档、交出之后的保留见 edit-lease-rules.ts（occupancyOf、reservedFor）。
// S4 的请求接口（POST/PUT …/edit-lease/request）据此回答与写库，心跳与编辑状态据 requestStandingOf 只给待回应的请求。
import type { LeaseOccupancy } from './edit-lease-rules.ts'
import type { ObservedEditLease } from './edit-leases.repository.ts'
import { reservedFor } from './edit-lease-rules.ts'

/** 请求方、被保留的人的事实（要查数据库）：某次登录仍然有效（auth 的 SessionService.isActive）；某人对这份文档仍能编辑（访问策略） */
export interface PartyFacts {
  readonly sessionActive: (sessionId: string) => Promise<boolean>
  readonly canEdit: (userId: string) => Promise<boolean>
}

/**
 * 槽里的请求现在的情形（M3-P5 设计 §3.6）。按下面的顺序判断，第一条不满足的就是它：
 *   1 有请求（none）→ 2 持有者没有谢绝（declined）→ 3 没过期（expired：请求方停止续期满 10 分钟，恰好到期算过期，与租约的到期同一个边界）
 *   → 4 请求方绑定的登录仍然有效（session）→ 5 请求方仍能编辑（revoked）→ 都满足：待回应（pending）。
 * 只有待回应的请求占着槽、送到持有者那里（心跳、编辑状态）；已谢绝、已失效的不占槽，别人的新请求直接替换它
 */
export type RequestStanding = 'none' | 'declined' | 'expired' | 'session' | 'revoked' | 'pending'

/** 槽里的请求现在的情形：登录与编辑权按需问——前三条有一条不满足就一个也不问，登录已失效就不再问编辑权 */
export async function requestStandingOf(lease: ObservedEditLease | undefined, facts: PartyFacts): Promise<RequestStanding> {
  // 请求的五列同时为空或同时有值（表上的约束）
  if (lease === undefined || lease.requestId === null || lease.requestedBy === null || lease.requestSessionId === null || lease.requestExpiresAt === null)
    return 'none'
  if (lease.requestDeclinedAt !== null)
    return 'declined'
  if (lease.requestExpiresAt.getTime() <= lease.now.getTime())
    return 'expired'
  if (!await facts.sessionActive(lease.requestSessionId))
    return 'session'
  if (!await facts.canEdit(lease.requestedBy))
    return 'revoked'
  return 'pending'
}

/**
 * 发出请求编辑（POST，用户的操作）时怎样回答（M3-P5 设计 §3.3、§3.6）：
 * - self：占着这份文档的就是调用者自己（别的标签页或设备）——页面改用本人接管，不写；
 * - occupied：别人占着，槽里是别人待回应的请求（单槽、先到先得）——不写；
 * - pending：别人占着，写下调用者的请求——槽里是调用者自己待回应的请求就续期（extend：标识与发出的时刻不变，有效期往后推）；
 *   否则换成一个新的请求（new：空槽、已失效的、已谢绝的，包括调用者自己被谢绝之后显式再点一次）；
 * - reserved / reservedForOther：没人占着，交出之后的保留留给了调用者 / 别人——不写；
 * - free：没人占着，也没有算数的保留——页面立即申请，不写。
 * occupancy 是从调用者看的（occupancyOf）：持有者本人看代次过时、还活着的那一行是空着的（他的续上就是普通的申请），别人看是占着的
 */
export type RequestSendDecision
  = | { readonly kind: 'self' | 'occupied' | 'reserved' | 'reservedForOther' | 'free' }
    | { readonly kind: 'pending', readonly write: 'new' | 'extend' }

export async function decideRequestSend(occupancy: LeaseOccupancy, callerId: string, facts: PartyFacts): Promise<RequestSendDecision> {
  if (occupancy.kind === 'vacant')
    return vacancyOutcome(await reservedFor(occupancy.lease, facts.canEdit), callerId)
  const { lease } = occupancy
  if (lease.holderId === callerId)
    return { kind: 'self' }
  if (await requestStandingOf(lease, facts) !== 'pending')
    return { kind: 'pending', write: 'new' }
  return lease.requestedBy === callerId ? { kind: 'pending', write: 'extend' } : { kind: 'occupied' }
}

/**
 * 请求方续期（PUT，等待中的页面每 5 秒一次，后台请求）时怎样回答（M3-P5 设计 §3.3、§3.6）；extend 为真时把有效期往后推：
 * - reserved：没人占着，保留留给了调用者（持有者交出了，请求已经转成保留）——页面立即申请；
 * - declined：槽里是调用者的请求，持有者谢绝了——页面停止等待；
 * - pending（extend）：槽里是调用者待回应的请求，别人占着；
 * - free / reservedForOther（extend）：槽里是调用者待回应的请求，没人占着（持有者的页面不在了、释放了）——没有保留时页面立即申请。
 *   请求照样续期：页面看不见时不进入编辑、接着等，持有者的页面回来续上（同一个人的新一代沿用请求）之后照常交给它；
 * - gone：槽里不是调用者的请求（换了别人的一代、被别人的新请求替换、已经实现），或者它已失效（过期、请求方换了登录、没了编辑权）——
 *   页面可以重新发出
 */
export interface RequestRenewDecision {
  readonly kind: 'reserved' | 'declined' | 'pending' | 'free' | 'reservedForOther' | 'gone'
  readonly extend: boolean
}

export async function decideRequestRenewal(occupancy: LeaseOccupancy, callerId: string, facts: PartyFacts): Promise<RequestRenewDecision> {
  // 保留只在明确结束（交出）之后有，那时没人占着
  const reserved = occupancy.kind === 'vacant' ? await reservedFor(occupancy.lease, facts.canEdit) : undefined
  if (reserved === callerId)
    return { kind: 'reserved', extend: false }
  const { lease } = occupancy
  if (lease?.requestedBy !== callerId)
    return { kind: 'gone', extend: false }
  const standing = await requestStandingOf(lease, facts)
  if (standing === 'declined')
    return { kind: 'declined', extend: false }
  if (standing !== 'pending')
    return { kind: 'gone', extend: false }
  // 调用者的请求在槽里：占着的人不是他（请求方不是持有者，表上的约束）
  if (occupancy.kind === 'occupied')
    return { kind: 'pending', extend: true }
  return { kind: vacancyOutcome(reserved, callerId).kind, extend: true }
}

/** 没人占着时：保留留给了调用者、留给了别人，或者谁都能申请 */
function vacancyOutcome(reserved: string | undefined, callerId: string): { readonly kind: 'reserved' | 'reservedForOther' | 'free' } {
  if (reserved === undefined)
    return { kind: 'free' }
  return { kind: reserved === callerId ? 'reserved' : 'reservedForOther' }
}
