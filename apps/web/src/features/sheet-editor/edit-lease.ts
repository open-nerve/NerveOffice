// 编辑租约的页面这一侧（M3-P1 设计 §3.4.7）：申请、心跳续租、失效与释放。不依赖 Univer 与界面；计时器与"现在"可注入，
// 用假的接口与假的时钟做单元测试。P2 的"打开即阅读、点'编辑'才申请"原样复用这里；续上、另存为副本在 P2，交接在 P5。
// - 申请：持有（令牌、代次、修订号）或被占用（持有者、最后活动、是不是自己）。被占用而且是自己时隔一小会儿再试几次：
//   刷新页面时，旧页面关闭时的释放可能晚于新页面的申请到达（P1 设计 §7 第一条）；
// - 心跳：每 EDIT_LEASE_HEARTBEAT_SECONDS 秒一次，带上距离本页最后一次键盘、鼠标操作的秒数。只用单调的时钟算相隔多久，
//   不拿浏览器的时钟去比服务端的时间（M3 总设计 §2.1）；同时只有一个在途，上一个回来之后按它发出的时刻排下一个；
// - 续租的结果：EDIT_LEASE_LOST、403、404 是失效——停止续租、通知页面（403 与 404 分开记下，P2 据此区分"还读得到就给副本"
//   与"读不到就丢弃"）；401 与 CSRF 失效交给页面确认会话，确认之前不再续租；别的失败（网络、5xx、回包读不出来）下一次照常重试，
//   到期由服务端判断；
// - 暂停与恢复：页面的会话不是本人时暂停（不带着别人的登录发续租）；回到本人时恢复并立即续租一次——租约绑定登录，
//   登录换过之后它已经失效，按续租的结果处理；
// - 释放：keepalive，结果不管（没送到时服务端按到期回收）。
import type { AcquiredEditLease, EditLeaseLostReason, RenewedEditLease, UserSummary } from '@nerve-office/contracts'
import type { LeaseCredentials } from './editor-api.ts'
import { EDIT_IDLE_SECONDS_MAX, EDIT_LEASE_HEARTBEAT_SECONDS, editLeaseHeldDetailsSchema, editLeaseLostDetailsSchema } from '@nerve-office/contracts'
import { ApiError, isAuthenticationError, isCsrfTokenError, isNotFoundError, isPermissionDeniedError } from '../../shared/api/index.ts'

/** 被占用而且是自己时再试的次数：刷新页面时旧页面的释放晚到（P1 设计 §7 第一条） */
export const SAME_USER_RETRIES = 3
/** 再试之前等多久（毫秒）：释放在旧页面隐藏时就发出，通常早于新页面载入完成；晚到的也多在这一两秒里 */
export const SAME_USER_RETRY_DELAY_MS = 500

const HEARTBEAT_MS = EDIT_LEASE_HEARTBEAT_SECONDS * 1000
const MINUTE_MS = 60_000

/** 租约用到的时钟：单调的"现在"与计时器（测试换成假的） */
export interface LeaseClock {
  /** 单调的时钟（毫秒，performance.now）：只用来算相隔多久，不与服务端的时间比较，也不受改系统时间的影响 */
  readonly now: () => number
  /** delayMs 毫秒之后执行一次 callback；返回取消它的函数 */
  readonly schedule: (callback: () => void, delayMs: number) => () => void
}

export const browserLeaseClock: LeaseClock = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

/** 编辑权的接口（editor-api.ts）：失败时抛出请求层的错误 */
export interface EditLeaseApi {
  readonly acquire: (documentId: string, clientInstanceId: string) => Promise<AcquiredEditLease>
  readonly renew: (documentId: string, token: string, idleSeconds: number) => Promise<RenewedEditLease>
  /** 尽力释放（keepalive），不看结果 */
  readonly release: (documentId: string, token: string) => void
}

/**
 * 编辑权失效的来源（P1 设计 §3.2）：
 * - lease：租约本身不再有效（EDIT_LEASE_LOST），reason 是服务端给的原因，不认识的原因为 undefined（按通用的"编辑权已失效"说明）；
 * - not-found：读不到这份文档了（404：删除、移走、被移出空间或取消分享，与不存在一致）；
 * - denied：读得到却不能编辑了（403，例如被降为查看者、空间被归档），原因的说明由服务端给出
 */
export type LeaseLoss
  = | { readonly kind: 'lease', readonly reason: EditLeaseLostReason | undefined }
    | { readonly kind: 'not-found', readonly error: ApiError }
    | { readonly kind: 'denied', readonly error: ApiError }

/** 请求的失败说明编辑权已经失效时给出来源；别的失败为 undefined */
export function leaseLossOf(error: unknown): LeaseLoss | undefined {
  if (!(error instanceof ApiError))
    return undefined
  if (error.code === 'EDIT_LEASE_LOST') {
    const details = editLeaseLostDetailsSchema.safeParse(error.details ?? {})
    return { kind: 'lease', reason: details.success ? details.data.reason : undefined }
  }
  if (isNotFoundError(error))
    return { kind: 'not-found', error }
  if (isPermissionDeniedError(error))
    return { kind: 'denied', error }
  return undefined
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
 * 本页持有的编辑租约：令牌与代次随保存带上；心跳在后台进行，失效时经 onLost 通知页面。
 * 失效与释放都是终态（P1 没有续上：P2 在失效之后重新申请，得到的是新的一份）
 */
export interface EditLease {
  /** 保存带上的令牌与代次 */
  readonly credentials: LeaseCredentials
  /** 页面的会话不是本人：暂停续租 */
  readonly pause: () => void
  /** 页面的会话确认是本人：恢复续租并立即续租一次（登录可能换过）；这一次有了结果之后兑现 */
  readonly resume: () => Promise<void>
  /** 别的请求（保存）得知编辑权已经失效：与续租失效同一个处理 */
  readonly lose: (loss: LeaseLoss) => void
  /** 尽力释放并停止续租（页面隐藏、关闭、卸载）；已经失效时什么也不做 */
  readonly release: () => void
}

export interface EditLeaseOptions {
  readonly documentId: string
  /** 本页这次加载的标识：租约绑定它，保存也带着它 */
  readonly clientInstanceId: string
  readonly api: EditLeaseApi
  readonly clock: LeaseClock
  /** 本页最后一次键盘、鼠标操作的时刻（clock.now 的时间轴上） */
  readonly lastActivity: () => number
  /** 编辑权失效：页面停止保存、说明原因。每份租约至多一次 */
  readonly onLost: (loss: LeaseLoss) => void
  /** 续租得到未登录或令牌失效：页面向服务端确认会话；确认之前续租暂停，确认是本人之后由页面恢复 */
  readonly onSessionProblem: (error: ApiError) => void
}

/** 申请的结果：持有（租约已经开始心跳；修订号是文档当前的）或被占用（认不出服务端给的详情时 holder 为 undefined） */
export type LeaseAcquisition
  = | { readonly kind: 'acquired', readonly lease: EditLease, readonly revision: number }
    | { readonly kind: 'held', readonly holder: LeaseHolder | undefined }

/** 服务端的两个时刻相隔几分钟（向下取整，不小于 0）；缺一个时为 undefined */
function minutesBetween(from: number, to: number | undefined): number | undefined {
  if (to === undefined || !Number.isFinite(from))
    return undefined
  return Math.floor(Math.max(0, to - from) / MINUTE_MS)
}

/** 申请被占用（EDIT_LEASE_HELD）时的持有者；别的失败为 undefined。详情认不出时 holder 为 undefined */
function heldOf(error: unknown): { readonly holder: LeaseHolder | undefined } | undefined {
  if (!(error instanceof ApiError) || error.code !== 'EDIT_LEASE_HELD')
    return undefined
  const details = editLeaseHeldDetailsSchema.safeParse(error.details)
  if (!details.success)
    return { holder: undefined }
  const { holder, sameUser, lastActiveAt } = details.data
  return { holder: { holder, sameUser, lastActiveMinutes: minutesBetween(Date.parse(lastActiveAt), error.serverTime) } }
}

async function wait(clock: LeaseClock, delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    clock.schedule(resolve, delayMs)
  })
}

/**
 * 申请编辑权。被占用而且是自己时，隔 SAME_USER_RETRY_DELAY_MS 再试，最多 SAME_USER_RETRIES 次，仍被占用才按被占用返回。
 * 别的失败（403、404、未登录、网络等）原样抛出，由页面处理
 */
export async function acquireEditLease(options: EditLeaseOptions): Promise<LeaseAcquisition> {
  for (let retry = 0; ; retry += 1) {
    let acquired: AcquiredEditLease
    try {
      acquired = await options.api.acquire(options.documentId, options.clientInstanceId)
    }
    catch (error) {
      const held = heldOf(error)
      if (held === undefined)
        throw error
      if (held.holder?.sameUser !== true || retry >= SAME_USER_RETRIES)
        return { kind: 'held', holder: held.holder }
      await wait(options.clock, SAME_USER_RETRY_DELAY_MS)
      continue
    }
    return { kind: 'acquired', lease: holdEditLease(options, acquired), revision: acquired.revision }
  }
}

/** 续租进行中的状态：holding 照常心跳；paused 等页面确认会话；lost、released 是终态 */
type LeaseState = 'holding' | 'paused' | 'lost' | 'released'

function holdEditLease(options: EditLeaseOptions, acquired: AcquiredEditLease): EditLease {
  const { api, clock, documentId } = options
  const credentials: LeaseCredentials = { token: acquired.token, writeEpoch: acquired.writeEpoch }
  let state: LeaseState = 'holding'
  let cancelTimer: (() => void) | undefined
  /** 进行中的续租（同时只有一个）与它期间又要求的那一次 */
  let inFlight: Promise<void> | undefined
  let renewAgain = false
  /** 恢复的次数：在它之前发出的续租回来的"未登录、令牌失效"已经过时（页面刚确认过会话），不再暂停 */
  let resumes = 0

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

  function lose(loss: LeaseLoss): void {
    if (state === 'lost' || state === 'released')
      return
    state = 'lost'
    stopTimer()
    options.onLost(loss)
  }

  async function renewOnce(): Promise<void> {
    const sentAt = clock.now()
    const round = resumes
    try {
      await api.renew(documentId, credentials.token, idleSeconds())
    }
    catch (error) {
      const loss = leaseLossOf(error)
      if (loss !== undefined) {
        lose(loss)
        return
      }
      if (isAuthenticationError(error) || isCsrfTokenError(error)) {
        // 发出之后页面又确认过会话（恢复过）：这个回答说的是确认之前的登录，已经过时，照常接着续租
        if (round !== resumes)
          return
        if (state === 'holding') {
          state = 'paused'
          stopTimer()
        }
        options.onSessionProblem(error)
        return
      }
      // 网络、5xx、回包读不出来：结果未知，下一次照常重试，到期由服务端判断
    }
    if (state === 'holding' && !renewAgain)
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
    credentials,
    pause: () => {
      if (state !== 'holding')
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
      return renew()
    },
    lose,
    release: () => {
      if (state === 'lost' || state === 'released')
        return
      // 暂停时（会话不是本人）不发：带的会是别人的登录或已经失效的登录，什么也释放不了
      const wasHolding = state === 'holding'
      state = 'released'
      stopTimer()
      if (wasHolding)
        api.release(documentId, credentials.token)
    },
  }
}

/** 算作"有操作"的输入：键盘、指针（鼠标、触摸、笔，含移动）与滚轮 */
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel'] as const

/**
 * 在捕获阶段记下本页的键盘、鼠标操作（P1 设计 §3.4.7）：焦点在 Univer 的输入框、浮层或页头里都收得到，
 * 也不受别的监听阻止传递的影响（交互屏障挂在它之后）。只记时刻，不改动事件（passive）。返回撤销监听的函数
 */
export function trackActivity(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, onActivity: () => void): () => void {
  const listener = (): void => onActivity()
  for (const type of ACTIVITY_EVENTS)
    target.addEventListener(type, listener, { capture: true, passive: true })
  return () => {
    for (const type of ACTIVITY_EVENTS)
      target.removeEventListener(type, listener, { capture: true })
  }
}
