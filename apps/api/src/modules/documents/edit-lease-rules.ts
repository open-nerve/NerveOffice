// 编辑租约的有效条件（M3-P1 设计 §3.4.1）与异常结束（§3.4.5）：只按事实判断，自己不查询。按下面的顺序判断，
// 第一条不满足的就是失效的原因（contracts 的 EDIT_LEASE_LOST_REASONS）：
//   1 有这一行（none）→ 2 没有明确结束（released、revoked）→ 3 代次等于文档当前的代次（stale）→ 4 没有到期（expired）
//   → 5 没有空闲超时（idle）→ 6 绑定的登录仍然有效（session）→ 7 持有者对文档仍有编辑权（revoked）。
// 时间一律是数据库的：租约行上的时间与读它的那条语句里的 now()（仓储读出的 ObservedEditLease），不用应用主机的时钟（规范 §5）。
// 两个入口：
// - 当前的租约（currentLeaseLoss，申请与编辑状态）：从旁判断这一行。第 6、7 条要查数据库（各一两条语句），事实由调用方
//   以函数的形式给出，规则决定问不问、先问哪个：前五条都满足才问，先问登录，登录不在了就不再问编辑权；
// - 请求带的租约（requestLeaseLoss，心跳与保存）：持有者自己的请求。先要令牌对得上，第 6 条换成"请求的登录、标签页就是
//   租约绑定的那一个"——换过令牌的页面拿的是新的登录，按 session 失效。"这次登录现在仍然有效"不在这里判断：调用方在事务里、
//   锁下另查一次（edit-lease.service.ts 的 requireActiveLogin，M3-P1 审查 A1），失效时回 SESSION_EXPIRED。
// 另有申请时的重试（isSamePage：同一个登录、同一个标签页）、释放（releasableBy：令牌对得上、没有明确结束、调用者是持有者本人——
// 不要求同一个登录，也不核对登录）与异常结束的提醒（interruptionOf）。
import type { EditLeaseLostReason } from '@nerve-office/contracts'
import type { ObservedEditLease } from './edit-leases.repository.ts'
import { EDIT_INTERRUPTION_NOTICE_SECONDS, EDIT_LEASE_IDLE_RECLAIM_SECONDS } from '@nerve-office/contracts'
import { editLeaseTokenMatches } from './edit-lease-token.ts'

/** 第 6、7 条的事实：要查数据库，所以是函数，只在用得着时才调用（前五条都满足、登录仍然有效） */
export interface HolderFacts {
  /** 租约绑定的登录仍然有效（没有撤销、没有过期：auth 的 SessionService.isActive） */
  readonly sessionActive: () => Promise<boolean>
  /** 持有者对这份文档仍有编辑权（访问策略给出的内容权限至少是编辑者） */
  readonly holderCanEdit: () => Promise<boolean>
}

/** 持有者自己的请求（心跳、保存）带来的东西 */
export interface LeaseRequest {
  /** 请求头里的令牌（格式已经由参数装饰器校验过）；没带时为 undefined，按没有租约处理（P1 设计 §3.2） */
  readonly token: string | undefined
  /** 这次请求的登录（会话守卫认证过的） */
  readonly sessionId: string
  /** 这次请求的标签页：保存的查询参数带着它；心跳与释放不带——令牌只发给了申请的那一个标签页 */
  readonly clientInstanceId?: string | undefined
  /** 这次请求带的代次：保存的查询参数（P1 设计 §3.4.4）；心跳不带 */
  readonly writeEpoch?: number | undefined
}

/**
 * 上一个租约异常结束的事实（P5 据此提醒，US-M3-10）：持有者、结束的时间——他最近一次续租的时间，以及他是不是这次申请的人自己
 * （M3-P5 设计 §3.5：页面按它分别说"上一位编辑者……"与"你上一次的编辑……"）
 */
export interface LeaseInterruption {
  readonly holderId: string
  readonly endedAt: Date
  readonly sameUser: boolean
}

const IDLE_RECLAIM_MS = EDIT_LEASE_IDLE_RECLAIM_SECONDS * 1000
const INTERRUPTION_NOTICE_MS = EDIT_INTERRUPTION_NOTICE_SECONDS * 1000

/**
 * 异常结束的原因（P1 设计 §3.4.5）：到期、空闲回收、登录失效——持有者的页面可能还有没保存的修改。
 * 明确结束（释放、收回）不算；代次过时也不算：那是删除、移动、撤权或者新的申请造成的，各有各的说法
 */
const ABNORMAL_ENDINGS: ReadonlySet<EditLeaseLostReason> = new Set<EditLeaseLostReason>(['expired', 'idle', 'session'])

/**
 * 第 2–5 条：只看这一行与读它时数据库的 now()。requestEpoch 是请求带的代次（保存），它也要是这一代——
 * 页面的令牌与代次出自同一次申请，对不上时同样按代次过时处理
 */
function rowLoss(lease: ObservedEditLease, documentEpoch: number, requestEpoch?: number): EditLeaseLostReason | undefined {
  // 第 2 条：明确结束的两列同时为空或同时有值（表上的 CHECK），原因就是失效的原因
  if (lease.endReason !== null)
    return lease.endReason
  if (lease.writeEpoch !== documentEpoch || (requestEpoch !== undefined && requestEpoch !== lease.writeEpoch))
    return 'stale'
  // 有效要求到期的时刻晚于 now：恰好到期算到期
  if (lease.expiresAt.getTime() <= lease.now.getTime())
    return 'expired'
  // 空闲满 12 分钟算超时：恰好 12 分钟就回收
  if (lease.now.getTime() - lease.lastActiveAt.getTime() >= IDLE_RECLAIM_MS)
    return 'idle'
  return undefined
}

/**
 * 当前的租约失效的原因（申请、编辑状态：从旁判断这一行，P1 设计 §3.4.1）；有效时为 undefined。
 * 两项要查数据库的事实按需取：前五条有一条不满足就一个也不问；登录已经失效就不再问编辑权
 */
export async function currentLeaseLoss(lease: ObservedEditLease | undefined, documentEpoch: number, facts: HolderFacts): Promise<EditLeaseLostReason | undefined> {
  if (lease === undefined)
    return 'none'
  const loss = rowLoss(lease, documentEpoch)
  if (loss !== undefined)
    return loss
  if (!await facts.sessionActive())
    return 'session'
  if (!await facts.holderCanEdit())
    return 'revoked'
  return undefined
}

/**
 * 请求带的租约失效的原因（心跳、保存：持有者自己的请求，P1 设计 §3.4.1、§3.4.4）；有效时为 undefined。
 * - 没带令牌、没有这一行：none。令牌对不上：replaced——请求的那一代已经被新的一代改写了（别人或自己在别处申请过），
 *   不论新的一代现在是否有效，请求的那一代都回不来了；令牌只按恒定时间比较（edit-lease-token.ts）；
 * - 第 2–5 条同上，保存带的代次也要是这一代；
 * - 第 6 条：请求的登录就是租约绑定的那一个；请求带了标签页（保存）时，也要是绑定的那一个，否则 session；
 * - 第 7 条不在这里判断：失去访问（404）与失去编辑权（403）先于租约判断（P1 设计 §3.2），调用方已经确认请求者能编辑，
 *   请求的登录对得上，持有者就是请求者
 */
export function requestLeaseLoss(lease: ObservedEditLease | undefined, documentEpoch: number, request: LeaseRequest): EditLeaseLostReason | undefined {
  if (lease === undefined || request.token === undefined)
    return 'none'
  if (!editLeaseTokenMatches(request.token, lease.tokenDigest))
    return 'replaced'
  const loss = rowLoss(lease, documentEpoch, request.writeEpoch)
  if (loss !== undefined)
    return loss
  if (request.sessionId !== lease.sessionId || (request.clientInstanceId !== undefined && request.clientInstanceId !== lease.clientInstanceId))
    return 'session'
  return undefined
}

/**
 * 申请时当前的租约有效、而且就是这个页面自己的——同一个登录、同一个标签页（P1 设计 §3.4.2 第 4 步）：这是页面的重试
 * （例如上次申请的回包丢了），照样发新的一代。别的登录或别的标签页的有效租约（同一个人在别的标签页、设备上也算）是被占用
 */
export function isSamePage(lease: ObservedEditLease, sessionId: string, clientInstanceId: string): boolean {
  return lease.sessionId === sessionId && lease.clientInstanceId === clientInstanceId
}

/**
 * 释放（P1 设计 §3.4.3）：令牌是当前这一行的、这一行没有明确结束、而且释放的人就是持有者，才记 released。没带令牌、令牌对不上
 * （这一行已经是新的一代）、已经释放或收回都不动它：页面关闭时晚到的释放不能结束别人（或自己在别处）申请到的新的一代，
 * 也不能改掉先记下的结束原因。另要求是持有者本人（M3-P1 审查 A4，纵深防御）：令牌一旦经别的渠道外泄（例如代理的访问日志记下了请求头），
 * 能读这份文档的人也不能拿它反复打断别人的编辑；不要求是同一个登录——换过令牌的页面续上之前，要先释放自己那一代。
 * 到期、空闲、登录失效的租约照样可以释放：记下 released，就不再算异常结束
 */
export function releasableBy(lease: ObservedEditLease | undefined, token: string | undefined, userId: string): boolean {
  return lease !== undefined && token !== undefined && lease.endReason === null && lease.holderId === userId && editLeaseTokenMatches(token, lease.tokenDigest)
}

/**
 * 当前的租约是不是异常结束、而且结束在 30 分钟以内（P1 设计 §3.4.2 第 6 步、§3.4.5）：申请改写这一行之前，按 currentLeaseLoss
 * 给出的原因判断。结束的时间取它最近一次续租的时间（之后就没有它还在的消息了）；恰好 30 分钟仍然提醒。
 * callerId 是这次申请的人：提醒带上上一位持有者是不是他自己（sameUser）
 */
export function interruptionOf(lease: ObservedEditLease | undefined, loss: EditLeaseLostReason | undefined, callerId: string): LeaseInterruption | undefined {
  if (lease === undefined || loss === undefined || !ABNORMAL_ENDINGS.has(loss))
    return undefined
  if (lease.now.getTime() - lease.renewedAt.getTime() > INTERRUPTION_NOTICE_MS)
    return undefined
  return { holderId: lease.holderId, endedAt: lease.renewedAt, sameUser: lease.holderId === callerId }
}
