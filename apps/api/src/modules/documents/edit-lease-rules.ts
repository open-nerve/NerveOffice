// 编辑租约的有效条件（M3-P1 设计 §3.4.1）、异常结束（§3.4.5，M3-P5 设计 §3.5 改为按事实判断）、从调用者看谁占着这份文档
// （M3-P5 设计 §3.5 的 R2）、申请怎样对待占着的那一代（本人接管、强制接管，§3.7、§3.8）、被接管的那一代与交出之后的保留（§3.6）：
// 只按事实判断，自己不查询。
// 有效条件按下面的顺序判断，第一条不满足的就是失效的原因（contracts 的 EDIT_LEASE_LOST_REASONS）：
//   1 有这一行（none）→ 2 没有明确结束（released、revoked、handed_over）→ 3 代次等于文档当前的代次（stale）→ 4 没有到期（expired）
//   → 5 没有空闲超时（idle）→ 6 绑定的登录仍然有效（session）→ 7 持有者对文档仍有编辑权（revoked）。
// 时间一律是数据库的：租约行上的时间与读它的那条语句里的 now()（仓储读出的 ObservedEditLease），不用应用主机的时钟（规范 §5）。
// 入口：
// - 谁占着这份文档（occupancyOf，申请与编辑状态，M3-P5 的请求编辑同样用它）：从旁判断这一行，没人占着时连同上一个租约异常结束的提醒。
//   第 6、7 条要查数据库（各一两条语句），事实由调用方以函数的形式给出，规则决定问不问、先问哪个，同一项事实至多问一次；
// - 申请怎样对待占着的那一代（claimOf）：普通的申请、页面自己的重试、本人接管或强制接管、被占用；
// - 当前的租约失效的原因（currentLeaseLoss）：七条有效条件本身；
// - 请求带的租约（requestLeaseLoss，心跳与保存，M3-P5 S4 的交出、谢绝同样用它）：持有者自己的请求。先要令牌对得上——对不上时是被接管
//   还是被换掉（supersededLoss）；第 6 条换成"请求的登录、标签页就是租约绑定的那一个"——换过令牌的页面拿的是新的登录，按 session 失效。
//   "这次登录现在仍然有效"不在这里判断：调用方在事务里、锁下另查一次（edit-lease.service.ts 的 requireActiveLogin，M3-P1 审查 A1），
//   失效时回 SESSION_EXPIRED；
// 另有申请时的重试（isSamePage：同一个登录、同一个标签页）、释放（releasableBy：令牌对得上、没有明确结束、调用者是持有者本人——
// 不要求同一个登录，也不核对登录）与交出之后的保留（reservedFor，S4 的申请与请求编辑用它）。
import type { EditLeaseLostReason, EditTakeoverMode } from '@nerve-office/contracts'
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
 * 上一个租约异常结束的事实（US-M3-10）：持有者、结束的时间——他最近一次续租的时间，以及他是不是调用者自己
 * （M3-P5 设计 §3.5：页面按它分别说"上一位编辑者……"与"你上一次的编辑……"）
 */
export interface LeaseInterruption {
  readonly holderId: string
  readonly endedAt: Date
  readonly sameUser: boolean
}

/** 请求的那一代失效的原因与详情（EDIT_LEASE_LOST 的 details，contracts 的 editLeaseLostDetailsSchema） */
export interface LeaseLoss {
  readonly reason: EditLeaseLostReason
  /** 只在 taken_over 时有：空间管理员强制接管为真，本人在别处接手为假 */
  readonly forced?: boolean
}

/** 接管的方式（库里的写法，租约行的 takeover 列）：本人接管 self，空间管理员强制接管 forced */
export type TakeoverKind = NonNullable<ObservedEditLease['takeover']>

/** 申请的人与他的页面：账户、这次登录与标签页（同一个登录、同一个标签页就是页面自己的重试） */
export interface Claimant {
  readonly userId: string
  readonly sessionId: string
  readonly clientInstanceId: string
}

/**
 * 申请怎样对待占着这份文档的那一代（M3-P5 设计 §3.4、§3.7、§3.8）：
 * - fresh：没人占着，普通的申请——带不带接管方式都一样，没有可接管的（不写接管标记，强制接管也不写审计）；
 * - retry：占着的就是这个页面自己的那一代（例如上次申请的回包丢了，包括上次是一次接管）：照样发新的一代，接管标记由仓储按"同一个页面"
 *   沿用，不另写审计；
 * - takeOver：接管占着的那一代（lease），方式见 takeover——占着的是调用者自己在别的标签页、设备上的有效租约时是本人接管（self）；
 *   占着的是别人（有效的或 R2 的）、调用者要强制接管时是强制接管（forced）。调用方已经按申请的方式判断过权限（强制接管要 takeOver）；
 * - held：被占用——普通的申请遇到任何人占着；本人接管而占着的是别人
 */
export type LeaseClaim
  = | { readonly kind: 'fresh' }
    | { readonly kind: 'retry' }
    | { readonly kind: 'takeOver', readonly takeover: TakeoverKind, readonly lease: ObservedEditLease }
    | { readonly kind: 'held', readonly lease: ObservedEditLease }

/**
 * 从调用者看，谁占着这份文档（M3-P5 设计 §3.5）；lease 是判断的那一行（没有这一行时为 undefined）：
 * - occupied：有效的租约在持有者手里（七条都满足；持有者是谁都算，包括调用者自己在别的标签页、设备上），stale 为假；
 *   或者代次过时、而按时间、登录、编辑权都还活着，持有者又不是调用者（R2，stale 为真）：跨空间移动、转移之后持有者的页面
 *   正在续上（一个心跳周期之内），只让他本人续上——等待中的请求方会自动申请，不能抢在他前面；
 * - vacant：没人占着。loss 是它失效的原因（没有这一行时是 none）；interruption 是上一个租约异常结束、在 30 分钟以内时的提醒
 */
export type LeaseOccupancy
  = | { readonly kind: 'occupied', readonly lease: ObservedEditLease, readonly stale: boolean }
    | { readonly kind: 'vacant', readonly lease: ObservedEditLease | undefined, readonly loss: EditLeaseLostReason, readonly interruption: LeaseInterruption | undefined }

const IDLE_RECLAIM_MS = EDIT_LEASE_IDLE_RECLAIM_SECONDS * 1000
const INTERRUPTION_NOTICE_MS = EDIT_INTERRUPTION_NOTICE_SECONDS * 1000

/** 同一项事实至多问一次：同一个请求里几条规则（有效条件、R2、异常结束）都可能要用到持有者的登录与编辑权，数据库只查一次 */
function askedOnce(facts: HolderFacts): HolderFacts {
  let session: Promise<boolean> | undefined
  let edit: Promise<boolean> | undefined
  return {
    sessionActive: async () => session ??= facts.sessionActive(),
    holderCanEdit: async () => edit ??= facts.holderCanEdit(),
  }
}

/**
 * 第 4、5 条（按时间）：只看这一行与读它时数据库的 now()。有效要求到期的时刻晚于 now——恰好到期算到期；
 * 空闲满 12 分钟算超时——恰好 12 分钟就回收。收回写入权找"按时间还活着"的租约用的是同样的边界（仓储的 ALIVE_BY_TIME）
 */
function timeLoss(lease: ObservedEditLease): 'expired' | 'idle' | undefined {
  if (lease.expiresAt.getTime() <= lease.now.getTime())
    return 'expired'
  if (lease.now.getTime() - lease.lastActiveAt.getTime() >= IDLE_RECLAIM_MS)
    return 'idle'
  return undefined
}

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
  return timeLoss(lease)
}

/**
 * 当前的租约失效的原因（P1 设计 §3.4.1）；有效时为 undefined。
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
 * 这一行是不是异常结束（M3-P5 设计 §3.5，US-M3-10）：按事实判断——没有明确结束（释放、收回、交出；接管时旧的一代被整行改写，
 * 留下的是有效的新一代），并且已到期、空闲满 12 分钟、或者绑定的登录已失效。持有者的页面可能还有没保存的修改。
 * 代次过时不遮住它（P1 审查 A6 第 1 处：先到期、后被跨空间移动或转移，原来取"第一条失效原因"得到 stale，提醒就丢了）；
 * 代次过时而按时间、登录都还活着的（刚被移走、持有者的页面正在续上）不算。持有者没了编辑权也不算：那是收回，不是中断。
 * 登录要查数据库，只在按时间还活着时才问
 */
export async function endedAbnormally(lease: ObservedEditLease, sessionActive: () => Promise<boolean>): Promise<boolean> {
  if (lease.endReason !== null)
    return false
  if (timeLoss(lease) !== undefined)
    return true
  return !await sessionActive()
}

/**
 * 上一个租约异常结束的提醒（P1 设计 §3.4.5，M3-P5 设计 §3.5）：按事实异常结束（endedAbnormally），而且结束在 30 分钟以内——
 * 结束的时间取它最近一次续租的时间（之后就没有它还在的消息了），恰好 30 分钟仍然提醒。callerId 是调用者（申请的人、看编辑状态的人）：
 * 提醒带上上一位持有者是不是他自己（sameUser，只按人比较，与登录、标签页无关）
 */
async function interruptionOf(lease: ObservedEditLease, callerId: string, sessionActive: () => Promise<boolean>): Promise<LeaseInterruption | undefined> {
  if (lease.now.getTime() - lease.renewedAt.getTime() > INTERRUPTION_NOTICE_MS)
    return undefined
  if (!await endedAbnormally(lease, sessionActive))
    return undefined
  return { holderId: lease.holderId, endedAt: lease.renewedAt, sameUser: lease.holderId === callerId }
}

/**
 * 从调用者（callerId）看，谁占着这份文档（申请、编辑状态；M3-P5 的请求编辑同样用它）。见 LeaseOccupancy：
 * 有效的租约占着；代次过时、按时间、登录、编辑权都还活着、持有者不是调用者（R2）同样占着——申请得到"被占用"，编辑状态里有人在编辑；
 * 持有者本人看这样的一行是空着的（他的续上就是一次普通的申请）。其余空着，带上异常结束的提醒（30 分钟以内）。
 * 持有者的登录与编辑权按需问，同一项至多问一次：只有代次过时、按时间还活着的那一行比有效条件本身多问（R2 与异常结束）
 */
export async function occupancyOf(lease: ObservedEditLease | undefined, documentEpoch: number, callerId: string, facts: HolderFacts): Promise<LeaseOccupancy> {
  if (lease === undefined)
    return { kind: 'vacant', lease, loss: 'none', interruption: undefined }
  const holder = askedOnce(facts)
  const loss = await currentLeaseLoss(lease, documentEpoch, holder)
  if (loss === undefined)
    return { kind: 'occupied', lease, stale: false }
  // stale 意味着没有明确结束（第 2 条在第 3 条之前）
  if (loss === 'stale' && lease.holderId !== callerId && timeLoss(lease) === undefined && await holder.sessionActive() && await holder.holderCanEdit())
    return { kind: 'occupied', lease, stale: true }
  return { kind: 'vacant', lease, loss, interruption: await interruptionOf(lease, callerId, holder.sessionActive) }
}

/**
 * 申请怎样对待占着这份文档的那一代（见 LeaseClaim；M3-P5 设计 §3.4、§3.7、§3.8）。takeover 是申请带的接管方式（契约的 self、force），
 * 普通的申请没有。先看是不是页面自己的重试：重试的接管标记由仓储沿用，不能再当成一次接管——那样会把"被接管的那一代"换成页面自己上次
 * 拿到的那一代，强制接管还会再写一条审计。占着的是调用者自己（别的标签页、设备）时一定是有效的租约：R2 只对别人（occupancyOf），
 * 所以本人接管只在"当前有效的租约在自己手里"时生效；强制接管遇到自己的租约就是本人接管，不写审计。
 * 本人接管遇到别人占着不起作用，与普通的申请一样被占用
 */
export function claimOf(occupancy: LeaseOccupancy, claimant: Claimant, takeover: EditTakeoverMode | undefined): LeaseClaim {
  if (occupancy.kind === 'vacant')
    return { kind: 'fresh' }
  const { lease } = occupancy
  if (isSamePage(lease, claimant.sessionId, claimant.clientInstanceId))
    return { kind: 'retry' }
  if (lease.holderId === claimant.userId)
    return takeover === undefined ? { kind: 'held', lease } : { kind: 'takeOver', takeover: 'self', lease }
  return takeover === 'force' ? { kind: 'takeOver', takeover: 'forced', lease } : { kind: 'held', lease }
}

/**
 * 请求带的租约失效的原因与详情（心跳、保存：持有者自己的请求，P1 设计 §3.4.1、§3.4.4；M3-P5 S4 的交出、谢绝同样）；有效时为 undefined。
 * - 没带令牌、没有这一行：none。令牌对不上：请求的那一代已经被新的一代改写了，不论新的一代现在是否有效，请求的那一代都回不来了——
 *   新的一代接管了它就是 taken_over（带方式），否则 replaced（supersededLoss，M3-P5 设计 §3.7、§3.8）；令牌只按恒定时间比较（edit-lease-token.ts）；
 * - 第 2–5 条同上，保存带的代次也要是这一代；
 * - 第 6 条：请求的登录就是租约绑定的那一个；请求带了标签页（保存）时，也要是绑定的那一个，否则 session；
 * - 第 7 条不在这里判断：失去访问（404）与失去编辑权（403）先于租约判断（P1 设计 §3.2），调用方已经确认请求者能编辑，
 *   请求的登录对得上，持有者就是请求者
 */
export function requestLeaseLoss(lease: ObservedEditLease | undefined, documentEpoch: number, request: LeaseRequest): LeaseLoss | undefined {
  if (lease === undefined || request.token === undefined)
    return { reason: 'none' }
  if (!editLeaseTokenMatches(request.token, lease.tokenDigest))
    return supersededLoss(lease, request.token)
  const loss = rowLoss(lease, documentEpoch, request.writeEpoch)
  if (loss !== undefined)
    return { reason: loss }
  if (request.sessionId !== lease.sessionId || (request.clientInstanceId !== undefined && request.clientInstanceId !== lease.clientInstanceId))
    return { reason: 'session' }
  return undefined
}

/**
 * 请求带的令牌对不上这一行时，请求的那一代是怎样没的（M3-P5 设计 §3.7、§3.8；requestLeaseLoss 用它）：
 * 这一行记着它接管的那一代的令牌摘要（接管标记）、对得上 → taken_over，带方式（forced：空间管理员强制接管为真，本人在别处接手为假），
 * 页面不再续上；对不上 → replaced：新的申请改写了它（它失效之后别人或自己申请过），或者接管它的那一代之后又换过一代——接管标记只记一层
 * （设计 §7）。摘要按恒定时间比较。调用方已经确认令牌对不上这一行自己的令牌
 */
export function supersededLoss(lease: ObservedEditLease, token: string): LeaseLoss {
  if (lease.takenOverTokenDigest !== null && lease.takeover !== null && editLeaseTokenMatches(token, lease.takenOverTokenDigest))
    return { reason: 'taken_over', forced: lease.takeover === 'forced' }
  return { reason: 'replaced' }
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
 * 交出之后的保留还算不算数、留给了谁（M3-P5 设计 §3.6；S4 的申请与请求编辑据此回答）：有保留、没过期（恰好到期算过期，
 * 与租约的到期同一个边界）、被保留的人仍能编辑——不算数时为 undefined。被保留的人能不能编辑要查数据库，只在前两条都满足时才问。
 * 保留按人、不按页面：被保留的人用哪个标签页、哪次登录都行，所以不看登录
 */
export async function reservedFor(lease: ObservedEditLease | undefined, canEdit: (userId: string) => Promise<boolean>): Promise<string | undefined> {
  if (lease === undefined || lease.reservedFor === null || lease.reservedUntil === null || lease.reservedUntil.getTime() <= lease.now.getTime())
    return undefined
  return await canEdit(lease.reservedFor) ? lease.reservedFor : undefined
}
