// 编辑租约的页面这一侧（M3-P1 设计 §3.4.7）：申请、心跳续租、失效、续上与释放。不依赖 Univer 与界面；计时器与"现在"可注入，
// 用假的接口与假的时钟做单元测试。P2 的"打开即阅读、点'编辑'才申请"原样复用这里（edit-mode.ts 在进入编辑时申请、退出时释放并等它的结果）；
// 交接在 P5。
// - 申请：持有（令牌、代次、修订号）或被占用（持有者、最后活动、是不是自己）。被占用而且是自己时隔一小会儿再试几次：
//   刷新页面时，旧页面关闭时的释放可能晚于新页面的申请到达（P1 设计 §7 第一条）。结果未知（网络错误、5xx、回包读不出来）时，
//   用同一个标识再试一次：服务端可能已经批给了本页，同一个页面再申请就是重试，发新的一代，不留下没人用的一代（审查 B7）；
// - 心跳：每 EDIT_LEASE_HEARTBEAT_SECONDS 秒一次，带上距离本页最后一次键盘、鼠标操作的秒数。只用单调的时钟算相隔多久，
//   不拿浏览器的时钟去比服务端的时间（M3 总设计 §2.1）；同时只有一个在途，上一个回来之后按它发出的时刻排下一个；
// - 失效（续租、保存得知）：失去访问（404）与编辑权（403、编辑权被收回）是失效——停止续租、通知页面，403 与 404 分开记下
//   （P2 据此区分"还读得到就给副本"与"读不到就丢弃"）；401 与 CSRF 失效交给页面确认会话，确认之前不再续租；
//   别的失败（网络、5xx、回包读不出来）下一次照常重试，到期由服务端判断；
// - 续上（M3 总设计 §2.1 的细化；原在 P2，2026-10-04 决定提前到 P1，已经交付的 US-M1-05 不因编辑权绑定登录而倒退）：
//   编辑权因为别的原因失效（EDIT_LEASE_LOST 的 none、replaced、released、stale、expired、idle、session），自动重新申请一次：
//   先放掉本页手里那一代（令牌对得上就是持有者本人，P1 设计 §3.4.3；不放掉的话，换过登录、原来的登录还在时，它仍然有效，
//   新的申请会被它占住）——释放的结果未知时不申请，保持现状，下一次心跳再试（审查 B9）；放掉之后页面已经释放或失效就不再申请
//   （审查 B7）。再申请：取得了、而且修订号就是本页保存的基准（期间没人保存过）：换上新的令牌与代次，接着心跳与保存，
//   用户不受打扰；修订号变了：当前修订的来源是本页一次结果未知的保存（其实已经提交，回包丢了）时以它为基准接着编辑，
//   与冲突时认出"自己追自己"同一条规则（审查 B1，00 号计划书 §7.5），否则是别处保存过——放掉刚申请到的，按失效处理
//   （不覆盖，另存为副本在 P2）；被占用、403、404 按失效处理；
//   网络错误、5xx 保持现状，下一次心跳或保存时再判断；未登录、令牌失效交给页面确认会话。续上的申请带本页的空闲秒数（M3-P5 设计 §3.5：
//   服务端把新的一代的最后活动按它往前推，空闲的兜底计时准确）；人在才申请，带的空闲因此短于回收阈值、不超过契约的上限（审查 A4）。
//   每一代至多续上一次有结果（成了是新的一代，不成就是失效，不来回申请）；会话不是本人时不续；空闲释放的过程中不续（M3-P5 设计 §3.9：
//   释放开始的那一刻就停止续上，免得回来时的第一下操作把 dormant 叫醒、申请新的一代——holdRecovery，没释放成时 allowRecovery）。
//   人不在时不续（本页空闲已经到了服务端的回收阈值 EDIT_LEASE_IDLE_RECLAIM_SECONDS），等本页再有操作：人走开之后断网、休眠回来，
//   服务端给的原因是到期而不是空闲，这时续上会让服务端的空闲回收重新计时，别人要多等一轮（审查 B8）；
// - 暂停与恢复：页面的会话不是本人时暂停（不带着别人的登录发续租）；回到本人时恢复并立即续租一次——租约绑定登录，
//   登录换过之后它已经失效，随即续上。连着的会话类失败（续租、续上的申请得到未登录或令牌失效，中间没有成功过）只有第一次之后
//   立即续租，之后的恢复按心跳的节奏再续（M3-P4 复验 C1：服务端一直拒绝、页面的确认照常成功时，每次恢复都立即续租，
//   续租与确认会话就按网络往返的速度连着发）；
// - 释放：页面隐藏、关闭时用 keepalive，结果不管（没送到时服务端按到期回收）；退出编辑时等它有了结果（结果未知也算结束，M3-P2 设计 §3.4；
//   等多久由 edit-mode.ts 设上限），结果交回服务端确认了没有（没确认时那一代可能还在，阅读页如实说明，审查 A13）。
// - 与服务端不兼容（M3-P3 设计 §3.5）：续租或续上的申请得到 CLIENT_OUTDATED（本页过旧）或 DOCUMENT_TOO_NEW（文档比服务端新）——
//   本页写不进去了：停止续租、尽力放掉手里那一代（别人与重新加载之后的本页立即能申请，不用等它到期），经 onIncompatible 通知页面。终态；
// - 被本浏览器的另一个标签页取代（M3-P5 设计 §3.1：本机锁被抢）：服务端批给了那边，本页这一代必然已经失效——abandon 停止续租与续上，
//   不发释放（令牌已经对不上），也不通知（页面自己转为失去编辑权）。终态；
// - 被接管（M3-P5 设计 §3.7、§3.8：续租或保存得到 taken_over）：不续上（编辑权是有意交给别处的，续上就是抢回来）——本人在另一台设备或浏览器上
//   接手（forced 为假）与空间管理员强制接管（forced 为真）分开交给页面；已经交出（handed_over：交出的回答没收到、下一次心跳才得知）同样不续上，
//   单独交给页面（说明交给了请求编辑的人）；
// - 异常中断的提醒（M3-P5 设计 §3.5，US-M3-10）：用户发起的申请（这里的 acquireEditLease）把申请响应里的提醒交回页面；续上（recover）的申请
//   不交回——编辑权中断之后续上，上一代异常结束的就是本页自己，说了只会让人以为出了事；
// - 本人接管（M3-P5 设计 §3.7，"在此编辑"）：申请带 takeover: 'self'（只给用户发起的那一次，续上从不带）；被自己占着时要不要隔一会儿再试
//   由页面判断（本浏览器里有标签页持有本机锁时不必再试：那不是刷新时晚到的释放）；
// - 请求编辑（M3-P5 设计 §3.6）：心跳的响应带着待回应的请求（没有时为 null），每次续租成功都交给页面（onRequest）；交出与谢绝由页面带着
//   现在的令牌直接发（edit-mode.ts），交出之后服务端已经结束这一代，页面 abandon（不再续租、不发释放）
import type { AcquiredEditLease, DocumentEditor, EditInterruption, EditLeaseLostDetails, EditLeaseLostReason, EditTakeoverMode, HandedOverEditLease, PendingEditRequest, RenewedEditLease, RevisionSource, UserSummary } from '@nerve-office/contracts'
import type { Incompatibility } from './client-format.ts'
import type { LeaseCredentials } from './editor-api.ts'
import { EDIT_IDLE_SECONDS_MAX, EDIT_LEASE_HEARTBEAT_SECONDS, EDIT_LEASE_IDLE_RECLAIM_SECONDS, editLeaseHeldDetailsSchema, editLeaseLostDetailsSchema } from '@nerve-office/contracts'
import { ApiError, isAuthenticationError, isCsrfTokenError, isNotFoundError, isPermissionDeniedError, isTransientError, ResponseFormatError } from '../../shared/api/index.ts'
import { incompatibilityOf } from './client-format.ts'

/** 被占用而且是自己时再试的次数：刷新页面时旧页面的释放晚到（P1 设计 §7 第一条） */
export const SAME_USER_RETRIES = 3
/** 再试之前等多久（毫秒）：释放在旧页面隐藏时就发出，通常早于新页面载入完成；晚到的也多在这一两秒里 */
export const SAME_USER_RETRY_DELAY_MS = 500
/** 申请的结果未知时再试的次数：同一个页面再申请是重试，服务端发新的一代（审查 B7） */
export const UNKNOWN_OUTCOME_RETRIES = 1
/** 结果未知之后再试之前等多久（毫秒）：网络抖动、服务繁忙多在这一会儿里过去 */
export const UNKNOWN_OUTCOME_RETRY_DELAY_MS = 500

const HEARTBEAT_MS = EDIT_LEASE_HEARTBEAT_SECONDS * 1000
const MINUTE_MS = 60_000
/** 本页的空闲短于它才算人在（续上的条件）：服务端回收空闲编辑权的阈值 */
const PRESENCE_MS = EDIT_LEASE_IDLE_RECLAIM_SECONDS * 1000

/** 请求的结果未知：没送到或没收到回答（网络错误）、服务端出错（5xx）、回包读不出来。服务端可能已经处理了 */
function outcomeUnknown(error: unknown): boolean {
  return isTransientError(error) || error instanceof ResponseFormatError
}

/**
 * 可以自动续上的失效原因：编辑权中断了，但不是失去访问或编辑权。revoked（编辑权被收回）不在里面；
 * 不认识的原因（以后的 Phase 加的）也不续，按失效说明
 */
const RECOVERABLE_REASONS: ReadonlySet<EditLeaseLostReason> = new Set<EditLeaseLostReason>(['none', 'replaced', 'released', 'stale', 'expired', 'idle', 'session'])

/** 租约用到的时钟：单调的"现在"与计时器（测试换成假的） */
export interface LeaseClock {
  /** 单调的时钟（毫秒，performance.now）：只用来算相隔多久，不与服务端的时间比较，也不受改系统时间的影响 */
  readonly now: () => number
  /** delayMs 毫秒之后执行一次 callback；返回取消它的函数 */
  readonly schedule: (callback: () => void, delayMs: number) => () => void
}

/** 浏览器计时器的上限（毫秒）：setTimeout 的延迟超过它会溢出、立即触发 */
const TIMER_DELAY_MAX_MS = 2 ** 31 - 1

export const browserLeaseClock: LeaseClock = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => {
    // 超过上限时按上限（约 24.8 天）：否则溢出成立即触发，按它排的调度就在原地空转（纵深防御，M3-P4 复验 C2）
    const timer = setTimeout(callback, Math.min(delayMs, TIMER_DELAY_MAX_MS))
    return () => clearTimeout(timer)
  },
}

/** 申请时另带的（M3-P5）：续上时 idleSeconds 是本页的空闲秒数（设计 §3.5）；takeover 是接管方式（设计 §3.7，只给用户发起的申请） */
export interface AcquireOptions {
  readonly idleSeconds?: number
  readonly takeover?: EditTakeoverMode
}

/** 编辑权的接口（editor-api.ts）：失败时抛出请求层的错误 */
export interface EditLeaseApi {
  /** 申请：用户发起的申请不带空闲秒数；没有要另带的时不给 options */
  readonly acquire: (documentId: string, clientInstanceId: string, options?: AcquireOptions) => Promise<AcquiredEditLease>
  readonly renew: (documentId: string, token: string, idleSeconds: number) => Promise<RenewedEditLease>
  /**
   * 尽力释放（keepalive）：失败时抛出请求层的错误。页面隐藏、关闭时不等它、不看结果；续上时等它——放掉之后再申请，
   * 两个请求不能交错，结果未知时不申请
   */
  readonly release: (documentId: string, token: string) => Promise<void>
  /**
   * 交出（M3-P5 设计 §3.6，keepalive）：把编辑权交给心跳带来的那个请求（requestId），交回留给了谁、留到何时。请求已不在时抛出
   * EDIT_REQUEST_GONE（租约不动），这一代已失效时 EDIT_LEASE_LOST
   */
  readonly handOver: (documentId: string, token: string, requestId: string) => Promise<HandedOverEditLease>
  /** 谢绝（持有者选了"继续编辑"）：标识对不上时服务端同样什么也不做；这一代已失效时抛出 EDIT_LEASE_LOST */
  readonly decline: (documentId: string, token: string, requestId: string) => Promise<void>
}

/** 正在编辑的人（申请被占用时服务端给出） */
export interface LeaseHolder {
  readonly holder: UserSummary
  /** 持有者就是自己（在别的标签页或设备上） */
  readonly sameUser: boolean
  /**
   * 服务端回答时，持有者最后一次操作在几分钟之前（向下取整）：按服务端的时间算（回答的时刻减去最后活动时间），
   * 不拿浏览器的时钟去比。服务端没给出回答的时刻（响应头 Date）时为 undefined，页头不说"多久之前"
   */
  readonly lastActiveMinutes: number | undefined
}

/**
 * 编辑权失效的来源（P1 设计 §3.2）：
 * - lease：租约本身不再有效（EDIT_LEASE_LOST），而且没有续上——编辑权被收回（revoked），或者不认识的原因（undefined）；
 * - not-found：读不到这份文档了（404：删除、移走、被移出空间或取消分享，与不存在一致）；
 * - denied：读得到却不能编辑了（403，例如被降为查看者、空间被归档），原因的说明由服务端给出；
 * - held：续上时别人（或者自己在别的标签页、设备上）正在编辑；
 * - newer：续上时发现编辑权中断期间别处保存了更新的版本：不覆盖它；
 * - taken-over：本人在别处接手了编辑（M3-P5 设计 §3.7）——this-browser 是本浏览器的另一个标签页（本机锁被抢，不再问服务端）；
 *   elsewhere 是另一台设备或浏览器（续租或保存得到 taken_over、forced 为假：那边以本人接管申请，服务端结束了这一代）；
 * - forced：空间管理员（个人空间是所有者）强制接管了编辑（M3-P5 设计 §3.8：taken_over、forced 为真）。by 是接管的人：转为阅读之后读一次
 *   编辑状态，正在编辑的是别人就是他（edit-mode.ts 补上；没读到时为 undefined，只说空间管理员强制接管了编辑）；
 * - handed-over：本页这一代已经交给了请求编辑的人（handed_over：交出的回答没有在时限之内收到、留在了编辑，下一次心跳或保存才得知；
 *   M3-P5 设计 §3.6）。to 是交给了谁（编辑模式按还在等的那个请求补上，不知道时为 undefined）
 */
export type LeaseLoss
  = | { readonly kind: 'lease', readonly reason: EditLeaseLostReason | undefined }
    | { readonly kind: 'not-found', readonly error: ApiError }
    | { readonly kind: 'denied', readonly error: ApiError }
    | { readonly kind: 'held', readonly holder: LeaseHolder | undefined }
    | { readonly kind: 'newer' }
    | { readonly kind: 'taken-over', readonly where: 'this-browser' | 'elsewhere' }
    | { readonly kind: 'forced', readonly by?: UserSummary | undefined }
    | { readonly kind: 'handed-over', readonly to?: UserSummary | undefined }

/**
 * 请求的失败说明编辑权已经失效（EDIT_LEASE_LOST、404、403）时给出来源；别的失败为 undefined。被接管（taken_over）按 forced 分成本人在别处接手与
 * 强制接管；forced 认不出（宽松解析之后没有）时不猜，照不认识的原因只说编辑权已失效（同样不续上）。已经交出（handed_over）单独给出（不续上）
 */
export function leaseLossOf(error: unknown): LeaseLoss | undefined {
  if (!(error instanceof ApiError))
    return undefined
  if (error.code === 'EDIT_LEASE_LOST') {
    const parsed = editLeaseLostDetailsSchema.safeParse(error.details ?? {})
    const details: EditLeaseLostDetails = parsed.success ? parsed.data : {}
    if (details.reason === 'taken_over' && details.forced !== undefined)
      return details.forced ? { kind: 'forced' } : { kind: 'taken-over', where: 'elsewhere' }
    if (details.reason === 'handed_over')
      return { kind: 'handed-over' }
    return { kind: 'lease', reason: details.reason }
  }
  if (isNotFoundError(error))
    return { kind: 'not-found', error }
  if (isPermissionDeniedError(error))
    return { kind: 'denied', error }
  return undefined
}

/** 这次失效可以自动续上：EDIT_LEASE_LOST 里不是失去编辑权的那些原因 */
function isRecoverable(loss: LeaseLoss): loss is { readonly kind: 'lease', readonly reason: EditLeaseLostReason } {
  return loss.kind === 'lease' && loss.reason !== undefined && RECOVERABLE_REASONS.has(loss.reason)
}

/**
 * 别的请求（保存）得知失效之后：
 * - held：本页仍持有编辑权——续上了，或者那个请求带的是早已被续上取代的上一代——可以用现在的编辑权重发；
 * - lost：编辑权失效了（页面已经得到通知）；
 * - unknown：暂时说不准——续上时网络出错、会话要先确认，或者正等本页再有操作；error 是那次的错误（没有时为 undefined），
 *   保存按它说明，下一次心跳或保存时再判断
 */
export type LeaseOutcome
  = | { readonly kind: 'held' }
    | { readonly kind: 'lost' }
    | { readonly kind: 'unknown', readonly error: unknown }

/**
 * 本页持有的编辑租约：令牌与代次随保存带上（续上之后换成新的一代）；心跳在后台进行，失效时经 onLost 通知页面。
 * 失效与释放都是终态
 */
export interface EditLease {
  /** 现在的令牌与代次：保存带上它 */
  readonly credentials: () => LeaseCredentials
  /** 页面的会话不是本人：暂停续租；连着的会话类失败清零（会话问题是真的，回到本人时立即续租，复核 D1） */
  readonly pause: () => void
  /**
   * 页面的会话确认是本人：恢复续租并立即续租一次（登录可能换过，失效了就随即续上）；这一次有了结果之后兑现。
   * 连着的会话类失败的第二次起不立即续租：按心跳的节奏再续，立即兑现（M3-P4 复验 C1）
   */
  readonly resume: () => Promise<void>
  /** 别的请求（保存）得知编辑权已经失效，used 是那个请求带的编辑权：与续租失效同一个处理 */
  readonly lose: (loss: LeaseLoss, used: LeaseCredentials) => Promise<LeaseOutcome>
  /** 本页有键盘、鼠标操作：因为空闲被服务端回收的编辑权，在这时续上（停止续上期间不续） */
  readonly noteActivity: () => void
  /**
   * 停止续上（空闲释放开始时，M3-P5 设计 §3.9）：之后得知的可以续上的失效不续上——交回"说不准"、保持现状（心跳照常，到时再得知），
   * 人不在时的 dormant 也不被操作叫醒。进行中的续上照常结束
   */
  readonly holdRecovery: () => void
  /** 恢复续上（空闲释放没成、留在编辑）：停止期间人回来过（dormant 而人在）就随即续上 */
  readonly allowRecovery: () => void
  /**
   * 放弃这一代：停止续租与续上，不发释放，不通知页面。终态；进行中的续上回来时新的一代随即放掉。用在服务端已经不认这一代的时候——
   * 本机锁被本浏览器的另一个标签页抢走（M3-P5 设计 §3.1 第 2 条：服务端批给了那边，本页这一代必然已经失效，令牌已经对不上）；
   * 交出之后（M3-P5 设计 §3.6：服务端已经结束这一代、留给请求方；页面关闭时发了交出的也是）
   */
  readonly abandon: () => void
  /**
   * 释放并停止续租（退出编辑、页面隐藏、关闭、卸载）：立即停止续租（之后的失效不再通知），释放的请求有了结果（成功或失败都算，
   * 结果未知时服务端按到期回收）之后兑现，从不失败。页面隐藏、关闭时不等它；退出编辑时等它（M3-P2 设计 §3.4）。
   * 兑现为服务端确认了没有（请求成功为 true；会话不是本人时不发、请求失败或结果未知为 false：那一代可能还在服务端，至多一个有效期后
   * 自行到期，退出编辑之后的阅读据此如实说明，审查 A13）。已经失效时什么也不做、为 true（本页没有还在的那一代）；
   * 释放过再调用时交回那一次的结果；与服务端不兼容、停住续租时已经放过一次（halt），交回那一次的结果（审查 B8）
   */
  readonly release: () => Promise<boolean>
}

export interface EditLeaseOptions {
  readonly documentId: string
  /** 本页这次加载的标识：租约绑定它，保存也带着它 */
  readonly clientInstanceId: string
  readonly api: EditLeaseApi
  readonly clock: LeaseClock
  /** 本页最后一次键盘、鼠标操作的时刻（clock.now 的时间轴上） */
  readonly lastActivity: () => number
  /** 本页保存的基准修订号（服务端确认过的最新修订）：续上时与申请得到的修订号比较，不同就是有人保存过 */
  readonly baseRevision: () => number
  /**
   * 续上时申请得到的修订号不是本页的基准：它的来源（source，没有来源时为 null）是本页一次结果未知的保存时，
   * 那一版就是本页自己的——页面按它确认（基准前进）并返回 true；否则返回 false，是别处保存过（审查 B1，00 号计划书 §7.5）
   */
  readonly adoptOwnRevision: (revision: number, source: RevisionSource | null) => boolean
  /** 编辑权失效（没有续上）：页面停止保存、说明原因。每份租约至多一次 */
  readonly onLost: (loss: LeaseLoss) => void
  /** 续租或续上得到未登录或令牌失效：页面向服务端确认会话；确认之前续租暂停，确认是本人之后由页面恢复 */
  readonly onSessionProblem: (error: ApiError) => void
  /**
   * 续租或续上的申请得知本页与服务端不兼容（M3-P3）：已经停止续租、放掉了手里那一代，页面停住保存、说明需要刷新（或只能阅读）。
   * 每份租约至多一次
   */
  readonly onIncompatible: (kind: Incompatibility) => void
  /**
   * 每次续租成功（这一代还在用时）：心跳的响应带来的待回应的请求编辑（M3-P5 设计 §3.6），没有时为 null——请求方取消了、过期了、
   * 被谢绝了都是 null。不需要时不给
   */
  readonly onRequest?: ((request: PendingEditRequest | null) => void) | undefined
}

/**
 * 申请的结果：持有（租约已经开始心跳；修订号是文档当前的；formulasPending 是文档当前的"公式待更新"，M3-P4 设计 §3.5——带标记时
 * 进入编辑以强制全量重算创建、收齐之后补存；interruption 是上一位编辑者异常中断的提醒，M3-P5 设计 §3.5，没有时为 undefined）
 * 或被占用（认不出服务端给的详情时 holder 为 undefined）
 */
export type LeaseAcquisition
  = | { readonly kind: 'acquired', readonly lease: EditLease, readonly revision: number, readonly formulasPending: boolean, readonly interruption: EditInterruption | undefined }
    | { readonly kind: 'held', readonly holder: LeaseHolder | undefined }

/** 服务端的两个时刻相隔几分钟（向下取整，不小于 0）；缺一个时为 undefined */
function minutesBetween(from: number, to: number | undefined): number | undefined {
  if (to === undefined || !Number.isFinite(from))
    return undefined
  return Math.floor(Math.max(0, to - from) / MINUTE_MS)
}

/**
 * 服务端给出的正在编辑的人（EDIT_LEASE_HELD 的详情、编辑状态的 editor）：最后活动几分钟之前按服务端回答的时刻（serverTime，
 * 响应头 Date）算，不拿浏览器的时钟去比；没有回答的时刻时不说"多久之前"
 */
export function leaseHolderOf(editor: DocumentEditor, serverTime: number | undefined): LeaseHolder {
  return { holder: editor.holder, sameUser: editor.sameUser, lastActiveMinutes: minutesBetween(Date.parse(editor.lastActiveAt), serverTime) }
}

/** 申请被占用（EDIT_LEASE_HELD）时的持有者；别的失败为 undefined。详情认不出时 holder 为 undefined */
function heldOf(error: unknown): { readonly holder: LeaseHolder | undefined } | undefined {
  if (!(error instanceof ApiError) || error.code !== 'EDIT_LEASE_HELD')
    return undefined
  const details = editLeaseHeldDetailsSchema.safeParse(error.details)
  return { holder: details.success ? leaseHolderOf(details.data, error.serverTime) : undefined }
}

async function wait(clock: LeaseClock, delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    clock.schedule(resolve, delayMs)
  })
}

/** 用户发起的那一次申请的意图（M3-P5；续上不经这里，从不带接管方式） */
export interface AcquireIntent {
  /** 接管方式（设计 §3.7："在此编辑"是 self）；普通的申请不给 */
  readonly takeover?: EditTakeoverMode | undefined
  /**
   * 被自己（别的标签页或设备）占着时要不要隔一会儿再试（每次再试之前问一次）：那几次再试是给刷新时晚到的释放的——本浏览器里有标签页持有
   * 本机锁时那是一个还在编辑的标签页，不必再试（设计 §3.7）。不给时一律再试
   */
  readonly retrySameUser?: (() => Promise<boolean>) | undefined
}

/**
 * 申请编辑权。被占用而且是自己时，隔 SAME_USER_RETRY_DELAY_MS 再试，最多 SAME_USER_RETRIES 次（intent.retrySameUser 说不必时不再试），
 * 仍被占用才按被占用返回。结果未知（网络错误、5xx、回包读不出来）时隔 UNKNOWN_OUTCOME_RETRY_DELAY_MS 用同一个标识再试
 * UNKNOWN_OUTCOME_RETRIES 次：服务端可能已经批给了本页，同一个页面再申请是重试，发新的一代（审查 B7；本人接管的重试沿用上一代的接管标记，
 * 服务端不再写一次）。别的失败（403、404、未登录等）、再试之后仍未知的，原样抛出，由页面处理
 */
export async function acquireEditLease(options: EditLeaseOptions, intent: AcquireIntent = {}): Promise<LeaseAcquisition> {
  let sameUserRetries = 0
  let unknownRetries = 0
  const { takeover } = intent
  for (;;) {
    let acquired: AcquiredEditLease
    try {
      acquired = await (takeover === undefined
        ? options.api.acquire(options.documentId, options.clientInstanceId)
        : options.api.acquire(options.documentId, options.clientInstanceId, { takeover }))
    }
    catch (error) {
      const held = heldOf(error)
      if (held === undefined) {
        if (!outcomeUnknown(error) || unknownRetries >= UNKNOWN_OUTCOME_RETRIES)
          throw error
        unknownRetries += 1
        await wait(options.clock, UNKNOWN_OUTCOME_RETRY_DELAY_MS)
        continue
      }
      if (held.holder?.sameUser !== true || sameUserRetries >= SAME_USER_RETRIES || (intent.retrySameUser !== undefined && !(await intent.retrySameUser())))
        return { kind: 'held', holder: held.holder }
      sameUserRetries += 1
      await wait(options.clock, SAME_USER_RETRY_DELAY_MS)
      continue
    }
    return { kind: 'acquired', lease: holdEditLease(options, acquired), revision: acquired.revision, formulasPending: acquired.formulasPending, interruption: acquired.interruption ?? undefined }
  }
}

/**
 * 续租的状态：holding 照常心跳；paused 等页面确认会话；dormant 编辑权中断时人不在、等本页再有操作才续上；
 * lost、released、halted（与服务端不兼容，M3-P3）是终态
 */
type LeaseState = 'holding' | 'paused' | 'dormant' | 'lost' | 'released' | 'halted'

const LOST: LeaseOutcome = { kind: 'lost' }
const HELD: LeaseOutcome = { kind: 'held' }

function holdEditLease(options: EditLeaseOptions, acquired: AcquiredEditLease): EditLease {
  const { api, clock, documentId } = options
  let credentials: LeaseCredentials = { token: acquired.token, writeEpoch: acquired.writeEpoch }
  let state: LeaseState = 'holding'
  let cancelTimer: (() => void) | undefined
  /** 进行中的续租（同时只有一个）与它期间又要求的那一次 */
  let inFlight: Promise<void> | undefined
  let renewAgain = false
  /** 恢复的次数：在它之前发出的续租回来的"未登录、令牌失效"已经过时（页面刚确认过会话），不再暂停 */
  let resumes = 0
  /**
   * 连着的会话类失败（续租、续上的申请得到未登录或令牌失效）：续租或申请成功了才清零——别的失败说明不了会话，不清零
   * （续上之前先失效的那次续租也不清：否则"失效 → 续上的申请被拒 → 恢复 → 续租又失效"每一轮都从头算，复验 C1）
   */
  let sessionFailures = 0
  /** 进行中的续上：同时只有一个，续租与保存得知的失效都等它 */
  let recovery: Promise<LeaseOutcome> | undefined
  /** 释放的那一次：服务端确认了没有（再调用 release 时交回它） */
  let releasing: Promise<boolean> | undefined
  /** 停止续上（空闲释放的过程中，holdRecovery）：得知的可以续上的失效先不续 */
  let recoveryHeld = false

  function stopTimer(): void {
    cancelTimer?.()
    cancelTimer = undefined
  }

  function scheduleRenewal(delayMs: number): void {
    stopTimer()
    cancelTimer = clock.schedule(() => {
      cancelTimer = undefined
      void renew()
    }, delayMs)
  }

  /** 距离最后一次操作的整秒数，不超过契约的上限 */
  function idleSeconds(): number {
    return Math.min(EDIT_IDLE_SECONDS_MAX, Math.max(0, Math.floor((clock.now() - options.lastActivity()) / 1000)))
  }

  /** 人在：本页的空闲还没到服务端回收空闲编辑权的阈值（再久就与服务端的空闲回收一样，算人不在，审查 B8） */
  function present(): boolean {
    return clock.now() - options.lastActivity() < PRESENCE_MS
  }

  /**
   * 续上的申请带的本页空闲（整秒，M3-P5 设计 §3.5）：人在时是这一刻的空闲向下取整——人在与秒数出自同一次读时钟，空闲短于回收阈值，
   * 取整之后不超过契约的上限 EDIT_ACQUIRE_IDLE_SECONDS_MAX（审查 A4：带到阈值的新一代一出生就按空闲失效，服务端 400）；人已经不在时为 undefined
   */
  function presentIdleSeconds(): number | undefined {
    const idleMs = clock.now() - options.lastActivity()
    return idleMs < PRESENCE_MS ? Math.max(0, Math.floor(idleMs / 1000)) : undefined
  }

  /**
   * 已经到了终态（失效或释放）。经函数读：续上的几步之间隔着请求，状态随时可能被页面（释放、暂停）或另一条路（失效）改掉，
   * 每次都要读现在的值
   */
  function ended(): boolean {
    return state === 'lost' || state === 'released' || state === 'halted'
  }

  /** 失效（没有续上）：终态，通知页面 */
  function fail(loss: LeaseLoss): void {
    if (ended())
      return
    state = 'lost'
    stopTimer()
    options.onLost(loss)
  }

  /**
   * 与服务端不兼容（M3-P3）：终态。停止续租，尽力放掉手里那一代（释放不核对数据格式，照样送得到；没送到时至多一个有效期后到期），
   * 通知页面。token 是本页手里的那一代（续上时刚申请到的新一代另由调用方放掉）。这次释放的结果记下来：之后的 release()（退出编辑时
   * 等它）交回它，没送到时如实说那一代可能还在，不说成已确认（审查 B8）
   */
  function halt(kind: Incompatibility): void {
    if (ended())
      return
    state = 'halted'
    stopTimer()
    releasing = api.release(documentId, credentials.token).then(() => true, () => false)
    options.onIncompatible(kind)
  }

  /**
   * 续上（见文件头）：先放掉本页手里那一代，再申请；取得了、修订号就是本页保存的基准，换上新的一代。
   * 释放的结果未知：不申请（手里那一代可能还占着，申请会被自己占住），保持现状，下一次心跳再试（审查 B9）；
   * 放掉之后页面已经释放或失效：不再申请（审查 B7）；申请回来时页面已经释放或失效：新的一代随即放掉
   */
  async function recover(): Promise<LeaseOutcome> {
    stopTimer()
    try {
      await api.release(documentId, credentials.token)
    }
    catch (error) {
      if (outcomeUnknown(error)) {
        if (state === 'holding')
          scheduleRenewal(HEARTBEAT_MS)
        return { kind: 'unknown', error }
      }
      // 确定被拒（读不到、不能编辑、未登录等）：申请会给出确定的回答，照常申请
    }
    if (ended())
      return LOST
    // 得知失效时人在，释放的来回期间本页的空闲却可能刚好满了回收阈值：这时人已经不在了，与得知失效时人不在同一个处理——
    // 不申请（也就不带超过契约上限的空闲，审查 A4），等本页再有操作
    const idle = presentIdleSeconds()
    if (idle === undefined) {
      if (state === 'holding')
        state = 'dormant'
      return { kind: 'unknown', error: undefined }
    }
    let next: AcquiredEditLease
    try {
      next = await api.acquire(documentId, options.clientInstanceId, { idleSeconds: idle })
    }
    catch (error) {
      if (ended())
        return LOST
      const incompatible = incompatibilityOf(error)
      if (incompatible !== undefined) {
        halt(incompatible)
        return LOST
      }
      const held = heldOf(error)
      if (held !== undefined) {
        fail({ kind: 'held', holder: held.holder })
        return LOST
      }
      const loss = leaseLossOf(error)
      if (loss !== undefined) {
        fail(loss)
        return LOST
      }
      if (isAuthenticationError(error) || isCsrfTokenError(error)) {
        sessionFailures += 1
        if (state === 'holding')
          state = 'paused'
        options.onSessionProblem(error)
        return { kind: 'unknown', error }
      }
      // 网络、5xx、回包读不出来：结果未知，保持现状（仍按手里那一代），下一次心跳或保存时再判断
      if (state === 'holding')
        scheduleRenewal(HEARTBEAT_MS)
      return { kind: 'unknown', error }
    }
    sessionFailures = 0
    if (ended()) {
      releaseQuietly(next.token)
      return LOST
    }
    // 期间有人保存过（本页保存的基准不是现在的修订）：是本页自己一次结果未知的保存（自己追自己）就以它为基准接着编辑（审查 B1）；
    // 是别处保存的就不覆盖，放掉刚申请到的
    if (next.revision !== options.baseRevision() && !options.adoptOwnRevision(next.revision, next.source)) {
      releaseQuietly(next.token)
      fail({ kind: 'newer' })
      return LOST
    }
    credentials = { token: next.token, writeEpoch: next.writeEpoch }
    if (state === 'dormant')
      state = 'holding'
    if (state === 'holding')
      scheduleRenewal(HEARTBEAT_MS)
    return HELD
  }

  /** 开始续上（调用方先确认没有进行中的：得知失效的都经 handleLoss 等进行中的那一次） */
  async function startRecovery(): Promise<LeaseOutcome> {
    const started = recover().finally(() => {
      recovery = undefined
    })
    recovery = started
    return started
  }

  /**
   * 得知失效（续租或保存），usedToken 是那个请求带的令牌：
   * 那个请求带的是已被续上取代的上一代 → 现在的仍然有效；失去访问或编辑权、不认识的原因 → 失效；
   * 会话不是本人 → 不续（回到本人时恢复续租会再次得知）；停止续上（空闲释放的过程中）→ 先不续（心跳照常，之后再得知）；
   * 人不在 → 等本页再有操作；其余续上一次
   */
  async function handleLoss(loss: LeaseLoss, usedToken: string): Promise<LeaseOutcome> {
    if (ended())
      return LOST
    if (usedToken !== credentials.token)
      return HELD
    if (!isRecoverable(loss)) {
      fail(loss)
      return LOST
    }
    if (recovery !== undefined)
      return recovery
    if (state === 'paused')
      return { kind: 'unknown', error: undefined }
    if (recoveryHeld) {
      // 心跳照常（得知失效的那一次续租不再自己排下一次）：恢复续上之后，下一次心跳再得知时续上
      if (state === 'holding')
        scheduleRenewal(HEARTBEAT_MS)
      return { kind: 'unknown', error: undefined }
    }
    if (!present()) {
      state = 'dormant'
      stopTimer()
      return { kind: 'unknown', error: undefined }
    }
    return startRecovery()
  }

  /** 尽力释放，不等、不看结果（页面隐藏与关闭、放掉续上时刚申请到却用不上的那一代） */
  function releaseQuietly(token: string): void {
    void api.release(documentId, token).catch(() => undefined)
  }

  async function renewOnce(): Promise<void> {
    const sentAt = clock.now()
    const round = resumes
    const used = credentials.token
    let renewed: RenewedEditLease | undefined
    try {
      renewed = await api.renew(documentId, used, idleSeconds())
      sessionFailures = 0
    }
    catch (error) {
      const incompatible = incompatibilityOf(error)
      if (incompatible !== undefined) {
        halt(incompatible)
        return
      }
      const loss = leaseLossOf(error)
      if (loss !== undefined) {
        await handleLoss(loss, used)
        return
      }
      if (isAuthenticationError(error) || isCsrfTokenError(error)) {
        // 发出之后页面又确认过会话（恢复过）：这个回答说的是确认之前的登录，已经过时，照常接着续租
        if (round !== resumes)
          return
        sessionFailures += 1
        if (state === 'holding') {
          state = 'paused'
          stopTimer()
        }
        options.onSessionProblem(error)
        return
      }
      // 网络、5xx、回包读不出来：结果未知，下一次照常重试，到期由服务端判断
    }
    // 这一代还在用（没有释放、失效、放弃）：心跳带来的请求交给页面（在 try 之外：页面那边出错不当作续租失败）
    if (renewed !== undefined && !ended())
      options.onRequest?.(renewed.request)
    if (state === 'holding' && !renewAgain && recovery === undefined)
      scheduleRenewal(Math.max(0, sentAt + HEARTBEAT_MS - clock.now()))
  }

  /** 续租一次；已有一个在途时，它回来之后再续一次（恢复时要用确认之后的登录核对） */
  async function renew(): Promise<void> {
    if (state !== 'holding')
      return
    if (inFlight !== undefined) {
      renewAgain = true
      return inFlight
    }
    const run = async (): Promise<void> => {
      try {
        do {
          renewAgain = false
          await renewOnce()
        } while (renewAgain && state === 'holding')
      }
      finally {
        inFlight = undefined
      }
    }
    inFlight = run()
    return inFlight
  }

  scheduleRenewal(HEARTBEAT_MS)

  return {
    credentials: () => credentials,
    pause: () => {
      // 页面确认会话不是本人（没有人登录、换了人）：之前的会话类失败有了真正的原因，不是"服务端一直拒绝"——清零，回到本人时立即续租、
      // 核对编辑权（复核 D1）。续租被拒时已经是 paused，清零放在下面的提前返回之前；服务端一直拒绝时确认都是本人，不会走到这里
      sessionFailures = 0
      if (state !== 'holding' && state !== 'dormant')
        return
      state = 'paused'
      stopTimer()
    },
    resume: async () => {
      if (state !== 'holding' && state !== 'paused')
        return
      state = 'holding'
      resumes += 1
      stopTimer()
      // 连着的会话类失败的第二次起：确认会话照常成功、服务端却一直拒绝（例如网关剥掉了 CSRF 的请求头），立即续租只会再被拒、
      // 再要页面确认一次——按心跳的节奏再续（复验 C1）。第一次多半是登录换过了，立即续租随即续上
      if (sessionFailures > 1) {
        scheduleRenewal(HEARTBEAT_MS)
        return
      }
      return renew()
    },
    lose: async (loss, used) => handleLoss(loss, used.token),
    noteActivity: () => {
      if (state === 'dormant' && !recoveryHeld) {
        state = 'holding'
        void startRecovery()
      }
    },
    holdRecovery: () => {
      recoveryHeld = true
    },
    allowRecovery: () => {
      recoveryHeld = false
      if (state === 'dormant' && present()) {
        state = 'holding'
        void startRecovery()
      }
    },
    abandon: () => {
      if (ended())
        return
      state = 'lost'
      stopTimer()
    },
    release: async () => {
      if (releasing !== undefined)
        return releasing
      if (ended())
        return true
      // 暂停时（会话不是本人）不发：带的会是别人的登录或已经失效的登录，什么也释放不了
      const wasPaused = state === 'paused'
      state = 'released'
      stopTimer()
      releasing = wasPaused ? Promise.resolve(false) : api.release(documentId, credentials.token).then(() => true, () => false)
      return releasing
    },
  }
}

/** 算作"有操作"的输入：键盘、指针（鼠标、触摸、笔，含移动）与滚轮 */
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel'] as const

/** 指针事件的指针与坐标（clientX、clientY）；不是指针事件（或者缺了哪一项）时为 undefined */
function pointerOf(event: Event): { readonly id: number, readonly x: number, readonly y: number } | undefined {
  const { pointerId, clientX, clientY } = event as Partial<PointerEvent>
  return typeof pointerId === 'number' && typeof clientX === 'number' && typeof clientY === 'number' ? { id: pointerId, x: clientX, y: clientY } : undefined
}

/**
 * 在捕获阶段记下本页的键盘、鼠标操作（P1 设计 §3.4.7）：焦点在 Univer 的输入框、浮层或页头里都收得到，
 * 也不受别的监听阻止传递的影响（交互屏障挂在它之后）。只记时刻，不改动事件（passive）。返回撤销监听的函数。
 * 两条过滤（M3-P5 设计 §3.9，空闲释放靠它判断"10 分钟没有操作"）：
 * - 只认可信事件（isTrusted：浏览器派发的用户输入）：页面、SDK 或扩展自己派发的合成事件不是人在操作；
 * - 指针没有挪动的 pointermove 不算（零位移：与上一次指针事件是同一个指针、坐标相同）——WebKit 在鼠标停着、页面被程序滚动时派发这种
 *   可信事件（探索 §3.2：5 次滚动 5 次），不滤的话页面里任何程序滚动都会把"没有操作"推后。只记最近的一个指针，不随触摸的次数增长
 */
export function trackActivity(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, onActivity: () => void): () => void {
  let lastPointer: { readonly id: number, readonly x: number, readonly y: number } | undefined
  const listener = (event: Event): void => {
    if (!event.isTrusted)
      return
    const pointer = pointerOf(event)
    if (pointer !== undefined) {
      const previous = lastPointer
      lastPointer = pointer
      if (event.type === 'pointermove' && previous !== undefined && previous.id === pointer.id && previous.x === pointer.x && previous.y === pointer.y)
        return
    }
    onActivity()
  }
  for (const type of ACTIVITY_EVENTS)
    target.addEventListener(type, listener, { capture: true, passive: true })
  return () => {
    for (const type of ACTIVITY_EVENTS)
      target.removeEventListener(type, listener, { capture: true })
  }
}
