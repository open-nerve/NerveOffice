// 请求编辑（M3-P5 设计 §3.6）：槽里的请求还算不算数，发出与续期时怎样回答（contracts 的 EditRequestOutcome 的 kind）、要不要写。
// 只按事实判断，自己不查询：请求方的登录与编辑权、被保留的人的编辑权要查数据库，事实由调用方以函数的形式给出，规则决定问不问。
// 谁占着这份文档、交出之后的保留见 edit-lease-rules.ts（occupancyOf、reservationOf）。
// 请求的接口（POST/PUT …/edit-lease/request，edit-request.service.ts）据此回答与写库；心跳、编辑状态、被占用的详情与交出
// 只认待回应的请求（pendingRequestOf）。
import type { LeaseOccupancy, LeaseReservation } from './edit-lease-rules.ts'
import type { ObservedEditLease } from './edit-leases.repository.ts'
import { reservationOf } from './edit-lease-rules.ts'

/** 请求方、被保留的人的事实（要查数据库）：某次登录仍然有效（auth 的 SessionService.isActive）；某人对这份文档仍能编辑（访问策略） */
export interface PartyFacts {
  readonly sessionActive: (sessionId: string) => Promise<boolean>
  readonly canEdit: (userId: string) => Promise<boolean>
}

/**
 * 槽里的请求（请求的五列都有值时，表上的约束让它们同时为空或同时有值）：标识、请求方、请求方的登录、发出的时刻、有效期，
 * 与持有者谢绝的时刻（没谢绝时为 null）
 */
export interface SlotRequest {
  readonly id: string
  readonly requesterId: string
  readonly sessionId: string
  readonly requestedAt: Date
  readonly expiresAt: Date
  readonly declinedAt: Date | null
}

/** 这一行的槽里的请求；槽空着、没有这一行时为 undefined */
export function slotRequestOf(lease: ObservedEditLease | undefined): SlotRequest | undefined {
  if (lease === undefined || lease.requestId === null || lease.requestedBy === null || lease.requestSessionId === null || lease.requestedAt === null || lease.requestExpiresAt === null)
    return undefined
  return { id: lease.requestId, requesterId: lease.requestedBy, sessionId: lease.requestSessionId, requestedAt: lease.requestedAt, expiresAt: lease.requestExpiresAt, declinedAt: lease.requestDeclinedAt }
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
  const request = slotRequestOf(lease)
  if (lease === undefined || request === undefined)
    return 'none'
  if (request.declinedAt !== null)
    return 'declined'
  if (request.expiresAt.getTime() <= lease.now.getTime())
    return 'expired'
  if (!await facts.sessionActive(request.sessionId))
    return 'session'
  if (!await facts.canEdit(request.requesterId))
    return 'revoked'
  return 'pending'
}

/**
 * 待回应的请求（requestStandingOf 是 pending 时槽里的那一个），没有时为 undefined：心跳带给持有者、编辑状态与被占用的详情给出、
 * 交出只交给它——已谢绝、已过期、请求方的登录失效或没了编辑权的请求都不算
 */
export async function pendingRequestOf(lease: ObservedEditLease | undefined, facts: PartyFacts): Promise<SlotRequest | undefined> {
  return await requestStandingOf(lease, facts) === 'pending' ? slotRequestOf(lease) : undefined
}

/**
 * 发出请求编辑（POST，用户的操作）时怎样回答（M3-P5 设计 §3.3、§3.6）：
 * - self：占着这份文档的就是调用者自己（别的标签页或设备，holder 是那一行）——页面改用本人接管，不写；
 * - occupied：别人占着，槽里是别人待回应的请求（单槽、先到先得，request 是它）——不写；
 * - pending：别人占着（holder 是那一行），写下调用者的请求——槽里是调用者自己待回应的请求就续期（extend：标识与发出的时刻不变，
 *   有效期往后推）；否则换成一个新的请求（new：空槽、已失效的、已谢绝的，包括调用者自己被谢绝之后显式再点一次）；
 * - reserved / reservedForOther：没人占着，交出之后的保留（reservation）留给了调用者 / 别人——不写；
 * - free：没人占着，也没有算数的保留——页面立即申请，不写。
 * occupancy 是从调用者看的（occupancyOf）：持有者本人看代次过时、还活着的那一行是空着的（他的续上就是普通的申请），别人看是占着的
 */
export type RequestSendDecision
  = | { readonly kind: 'self', readonly holder: ObservedEditLease }
    | { readonly kind: 'occupied', readonly request: SlotRequest }
    | { readonly kind: 'pending', readonly write: 'new' | 'extend', readonly holder: ObservedEditLease }
    | { readonly kind: 'reserved' | 'reservedForOther', readonly reservation: LeaseReservation }
    | { readonly kind: 'free' }

export async function decideRequestSend(occupancy: LeaseOccupancy, callerId: string, facts: PartyFacts): Promise<RequestSendDecision> {
  if (occupancy.kind === 'vacant')
    return vacancyOutcome(await reservationOf(occupancy.lease, facts.canEdit), callerId)
  const { lease } = occupancy
  if (lease.holderId === callerId)
    return { kind: 'self', holder: lease }
  const pending = await pendingRequestOf(lease, facts)
  if (pending === undefined)
    return { kind: 'pending', write: 'new', holder: lease }
  return pending.requesterId === callerId ? { kind: 'pending', write: 'extend', holder: lease } : { kind: 'occupied', request: pending }
}

/**
 * 请求方续期（PUT，等待中的页面每 5 秒一次，后台请求）时怎样回答（M3-P5 设计 §3.3、§3.6）；extend 为真时把有效期往后推：
 * - reserved：没人占着，保留留给了调用者（持有者交出了，请求已经转成保留）——页面立即申请；
 * - declined：槽里是调用者的请求（request），持有者谢绝了——页面停止等待；holder 是这一行（谢绝的人，或者他之后续上的一代）；
 * - pending（extend）：槽里是调用者待回应的请求，别人占着（holder 是那一行）；
 * - free / reservedForOther（extend）：槽里是调用者待回应的请求，没人占着（持有者的页面不在了、释放了）——没有保留时页面立即申请。
 *   请求照样续期：页面看不见时不进入编辑、接着等，持有者的页面回来续上（同一个人的新一代沿用请求）之后照常交给它。
 *   reservedForOther 这一支在现有的写路径下到不了（M3-P5 审查 A6），留作防御：保留只由交出写下，交出在同一条语句里清掉请求；之后
 *   只有别人占着时才会写下新的请求（decideRequestSend），而有人占着就意味着这一行已被申请改写过、保留随之清空。所以"槽里是调用者
 *   待回应的请求、没人占着、保留留给了别人"不会同时成立；以后有了在保留期内写请求的路径，页面照这一支撤回请求（edit-request.ts）；
 * - gone：槽里不是调用者的请求（换了别人的一代、被别人的新请求替换、已经实现），或者它已失效（过期、请求方换了登录、没了编辑权）——
 *   页面可以重新发出；holder 是现在占着的那一行，没人占着时为 undefined
 */
export type RequestRenewDecision
  = | { readonly kind: 'reserved', readonly reservation: LeaseReservation, readonly extend: false }
    | { readonly kind: 'declined', readonly request: SlotRequest, readonly holder: ObservedEditLease, readonly extend: false }
    | { readonly kind: 'pending', readonly holder: ObservedEditLease, readonly extend: true }
    | { readonly kind: 'free', readonly extend: true }
    | { readonly kind: 'reservedForOther', readonly reservation: LeaseReservation, readonly extend: true }
    | { readonly kind: 'gone', readonly holder: ObservedEditLease | undefined, readonly extend: false }

export async function decideRequestRenewal(occupancy: LeaseOccupancy, callerId: string, facts: PartyFacts): Promise<RequestRenewDecision> {
  // 保留只在明确结束（交出）之后有，那时没人占着
  const reservation = occupancy.kind === 'vacant' ? await reservationOf(occupancy.lease, facts.canEdit) : undefined
  if (reservation?.reservedFor === callerId)
    return { kind: 'reserved', reservation, extend: false }
  const { lease } = occupancy
  const request = slotRequestOf(lease)
  const holder = occupancy.kind === 'occupied' ? occupancy.lease : undefined
  if (lease === undefined || request?.requesterId !== callerId)
    return { kind: 'gone', holder, extend: false }
  const standing = await requestStandingOf(lease, facts)
  if (standing === 'declined')
    return { kind: 'declined', request, holder: lease, extend: false }
  if (standing !== 'pending')
    return { kind: 'gone', holder, extend: false }
  // 调用者的请求在槽里：占着的人不是他（请求方不是持有者，表上的约束）
  if (occupancy.kind === 'occupied')
    return { kind: 'pending', holder: occupancy.lease, extend: true }
  return reservation === undefined ? { kind: 'free', extend: true } : { kind: 'reservedForOther', reservation, extend: true }
}

/** 没人占着时：保留留给了调用者、留给了别人，或者谁都能申请 */
function vacancyOutcome(reservation: LeaseReservation | undefined, callerId: string): RequestSendDecision {
  if (reservation === undefined)
    return { kind: 'free' }
  return { kind: reservation.reservedFor === callerId ? 'reserved' : 'reservedForOther', reservation }
}
