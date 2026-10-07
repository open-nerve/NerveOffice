// 请求编辑：请求方这一侧（M3-P5 设计 §3.6、§3.10，US-M3-06）。不依赖 Univer 与界面；接口、时钟、页面的可见性与"最后一次操作"都注入，
// 用假的做单元测试（edit-request.test.ts）。阅读与编辑的状态机（edit-mode.ts）持有它：进展放进阅读的状态（页头据此把"请求编辑"换成"取消请求"、
// 读屏状态区说在等谁），进入编辑与结束时的说明交给状态机。
// - 发出（"请求编辑"，用户的操作）：在等待（pending）→ 等待；交给了本页（reserved）或者没人在编辑（free）→ 进入编辑（见下）；正在编辑的是
//   自己（self）→ 改走"在此编辑"；别人先请求了（occupied）、编辑权刚交给了别人（reservedForOther）→ 结束并说明；
// - 等待：每 EDIT_REQUEST_RENEW_SECONDS 续期一次（后台请求，响应就是请求的现状；同时只有一个在途，回来之后按发出的时刻排下一次），不倒计时。
//   页面隐藏时照常排（浏览器自己降频，Safari 隐藏几秒之后整页暂停），回到前台立即续期一次。谢绝（declined）→ 结束、说明谁谢绝了；
//   请求不在了（gone：换了一代、过期、被别人的新请求替换）→ 结束、说明，可以重新请求；
// - 进入编辑：reserved、free 时只在页面看得见、会话是本人时进入（enter：普通申请）——Safari 会暂停后台页面，在后台抢到的编辑权会因为心跳停了
//   而到期；看不见时记下（granted），不再续期（请求已经转成保留，或者没人在编辑），回到前台时进入，保留期过了而编辑权空着时照样进入
//   （请求的意图还在）。状态机这一刻进入不了（正在按新的版本重建）时留在 granted，等它 retry；
// - 空闲：等待中（含 granted）本页空闲满 10 分钟（与空闲释放同一个口径，起点是最后一次操作与开始等待中较晚的那个）就取消请求——人走了，
//   免得编辑权交给他之后空占。每次续期之前判断；回到前台时（可见性的通知里，同步）按隐藏之前的操作判断（Safari 隐藏时计时器停了）；
// - 取消（"取消请求"）：DELETE（同时清掉留给本人的保留）。没取消成就回到等待、说明原因（可以再按），照常续期——请求还在服务端；
// - 撤回（withdraw：页面关闭、编辑器建不起来）：尽力 DELETE（keepalive，不等结果），不说明；
// - 恢复（resume：刷新之后，或者本人在别的标签页、设备上发出的请求——编辑状态里有本人的请求时）：不另发出，直接等待、立即续期一次；
// - 会话不是本人时不续期（不带着别人的登录发），回到本人时立即续期一次；续期、取消遇到会话类失败（未登录、令牌失效）交给页面确认会话、照常等；
//   续期得到不能编辑了（403）、读不到了（404）就结束（状态机按原因说明），别的失败（网络、5xx、回包读不出来）下一次照常再试。
import type { EditRequestOutcome, UserSummary } from '@nerve-office/contracts'
import type { LeaseClock } from './edit-lease.ts'
import type { HandoverTrace } from './handover-trace.ts'
import type { PageVisibility } from './reading-checks.ts'
import { EDIT_IDLE_RELEASE_SECONDS, EDIT_REQUEST_RENEW_SECONDS } from '@nerve-office/contracts'
import { ApiError, isAuthenticationError, isCsrfTokenError, isNotFoundError, isPermissionDeniedError } from '../../shared/api/index.ts'

/** 等待中续期的间隔 */
export const REQUEST_RENEW_MS = EDIT_REQUEST_RENEW_SECONDS * 1000

/** 等待中的页面空闲满它就取消请求：10 分钟没有键盘、鼠标操作（与空闲释放同一个口径，US-M3-07） */
export const REQUEST_IDLE_MS = EDIT_IDLE_RELEASE_SECONDS * 1000

/** 请求编辑的接口（editor-api.ts）：失败时抛出请求层的错误 */
export interface EditRequestApi {
  /** 发出（POST …/edit-lease/request，带本页的构建与数据格式）：请求编辑的结果（不会是 gone） */
  readonly send: (documentId: string) => Promise<EditRequestOutcome>
  /** 续期（PUT，后台请求）：请求编辑的结果，没有本人的请求时是 gone */
  readonly renew: (documentId: string) => Promise<EditRequestOutcome>
  /** 取消（DELETE，keepalive）：清掉本人的请求与留给本人的保留 */
  readonly cancel: (documentId: string) => Promise<void>
}

/**
 * 请求方这一侧的进展（阅读的状态里带着）：
 * - sending：正在发出（"请求编辑"留着，不可用、说正在请求）；
 * - waiting：在等持有者（holder，没人在编辑时为 undefined）回应，按钮是"取消请求"；cancelFailure 是上一次没取消成的原因（没有时 undefined）；
 * - cancelling：正在取消；
 * - granted：编辑权交给了本页（或者空着），页面看不见（或者这一刻进入不了），回到前台时进入编辑
 */
export type EditRequestProgress
  = | { readonly kind: 'sending' }
    | { readonly kind: 'waiting', readonly holder: UserSummary | undefined, readonly cancelFailure: unknown }
    | { readonly kind: 'cancelling', readonly holder: UserSummary | undefined }
    | { readonly kind: 'granted' }

/**
 * 请求为什么结束了（进入编辑不算：那时状态机已经在进入编辑）：本人取消（不另说明）；空闲满 10 分钟取消了；持有者谢绝（谁）；别人先请求了
 * （谁）；编辑权刚交给了别人（谁、留到何时，服务端的时刻）；请求不在了；正在编辑的是自己（改走"在此编辑"）；发出失败或者续期得到 403、404
 * （状态机按原因说明）
 */
export type EditRequestEnd
  = | { readonly kind: 'cancelled' }
    | { readonly kind: 'idle' }
    | { readonly kind: 'declined', readonly holder: UserSummary }
    | { readonly kind: 'occupied', readonly requester: UserSummary }
    | { readonly kind: 'reserved-for-other', readonly reservedFor: UserSummary, readonly reservedUntil: string }
    | { readonly kind: 'gone' }
    | { readonly kind: 'self' }
    | { readonly kind: 'failed', readonly error: unknown }

export interface EditRequestsOptions {
  readonly documentId: string
  readonly api: EditRequestApi
  /** 续期的间隔与空闲按它算（单调的时钟，与编辑租约同一个） */
  readonly clock: LeaseClock
  readonly visibility: PageVisibility
  /** 本页最后一次键盘、鼠标操作的时刻（clock.now 的时间轴上） */
  readonly lastActivity: () => number
  /** 续期、取消得到未登录或令牌失效：交给页面确认会话（照常等）。发出的失败经 onEnd（failed）交给状态机 */
  readonly onSessionProblem: (error: ApiError) => void
  /** 进展变了（没有请求了时为 undefined；结束时不经这里，经 onEnd） */
  readonly onProgress: (progress: EditRequestProgress | undefined) => void
  /**
   * 编辑权交给了本页（或者空着），页面看得见、会话是本人：以普通申请进入编辑。交回进入了没有——这一刻进入不了（例如正在按新的版本重建）时为假，
   * 留在 granted，状态机之后调 retry
   */
  readonly enter: () => boolean
  /** 请求结束了（见 EditRequestEnd） */
  readonly onEnd: (end: EditRequestEnd) => void
  /** 测试构建的观察钩子（handover-trace.ts）：发出与续期的结果、编辑权交给了本页、开始进入；生产不给 */
  readonly trace?: HandoverTrace | undefined
}

/** 失败在观察钩子里的写法：error 与错误码（网络等没有错误码时只写 error） */
function failureOf(error: unknown): string {
  return error instanceof ApiError ? `error:${error.code}` : 'error'
}

export interface EditRequests {
  /** 现在的进展；没有请求时为 undefined */
  readonly progress: () => EditRequestProgress | undefined
  /**
   * 进展每变一次加一：阅读时的检查记下发出时的值，回来时变过了就不按它恢复等待（变化之前读到的"有本人的请求"可能已经过时，例如刚取消）
   */
  readonly version: () => number
  /** "请求编辑"：发出（已经有请求时什么也不做） */
  readonly send: () => Promise<void>
  /** 编辑状态说有本人的请求（刷新之后、别的标签页或设备发出的）：不另发出，开始等待、立即续期一次（已经有请求时什么也不做） */
  readonly resume: (holder: UserSummary | undefined) => void
  /** "取消请求"（等待中、granted 时） */
  readonly cancel: () => Promise<void>
  /** 状态机现在能进入编辑了（重建完了）：granted、看得见时进入 */
  readonly retry: () => void
  /** 会话是不是本人：不是时停止续期，回到本人时立即续期一次（granted 时进入） */
  readonly setActive: (active: boolean) => void
  /** 撤回（页面关闭、编辑器建不起来）：有请求就尽力取消（不等结果），停下，不说明 */
  readonly withdraw: () => void
  /** 停下：不再续期、不再回调（不发请求） */
  readonly dispose: () => void
}

export function createEditRequests(options: EditRequestsOptions): EditRequests {
  const { documentId, api, clock } = options
  let progress: EditRequestProgress | undefined
  let version = 0
  /** 异步的结果属于哪一轮：发出、恢复、取消、结束、撤回各开始新的一轮，之前发出的请求回来时不再接着做 */
  let rounds = 0
  /** 开始等待的时刻（发出、恢复）：空闲从它与最后一次操作中较晚的那个算起 */
  let since = 0
  let cancelTimer: (() => void) | undefined
  /** 在途的续期属于哪一轮：同一轮里同时只有一个；之前的轮次在途的那一个回来时作废，不挡住新的一轮 */
  let renewingRound: number | undefined
  let active = true
  let disposed = false

  function stopTimer(): void {
    cancelTimer?.()
    cancelTimer = undefined
  }

  function set(next: EditRequestProgress | undefined): void {
    progress = next
    version += 1
    options.onProgress(next)
  }

  /** 结束（不是进入编辑）：不再续期，说明交给状态机 */
  function finish(end: EditRequestEnd): void {
    rounds += 1
    stopTimer()
    progress = undefined
    version += 1
    options.onEnd(end)
  }

  /** 空闲满了 10 分钟：起点是最后一次操作与开始等待中较晚的那个 */
  function idleNow(): boolean {
    return clock.now() - Math.max(options.lastActivity(), since) >= REQUEST_IDLE_MS
  }

  /** 人走了：取消请求（不等结果：没送到的话不再续期，服务端 10 分钟后让它失效），说明 */
  function quitForIdle(): void {
    void api.cancel(documentId).catch(() => undefined)
    finish({ kind: 'idle' })
  }

  function schedule(delayMs: number): void {
    stopTimer()
    if (!active || progress?.kind !== 'waiting')
      return
    cancelTimer = clock.schedule(() => {
      cancelTimer = undefined
      void renew()
    }, delayMs)
  }

  /** 编辑权交给了本页（或者空着）：不再续期；看得见、会话是本人时进入编辑 */
  function grant(): void {
    stopTimer()
    options.trace?.({ kind: 'request-granted', at: clock.now(), visible: !options.visibility.hidden() })
    if (progress?.kind !== 'granted')
      set({ kind: 'granted' })
    tryEnter()
  }

  function tryEnter(): void {
    if (disposed || progress?.kind !== 'granted' || !active || options.visibility.hidden())
      return
    if (!options.enter())
      return
    options.trace?.({ kind: 'request-enter', at: clock.now() })
    // 状态机已经在进入编辑：请求随之完成（取得编辑权之后服务端清掉它与保留），这里静静地回到没有请求
    rounds += 1
    progress = undefined
    version += 1
  }

  /** 发出或续期的回答（source：续期时请求还在槽里，见 reservedForOther） */
  function apply(outcome: EditRequestOutcome, source: 'send' | 'renew'): void {
    switch (outcome.kind) {
      case 'pending': {
        const holder = outcome.holder.holder
        if (progress?.kind !== 'waiting' || progress.holder?.id !== holder.id)
          set({ kind: 'waiting', holder, cancelFailure: progress?.kind === 'waiting' ? progress.cancelFailure : undefined })
        return
      }
      case 'declined':
        finish({ kind: 'declined', holder: outcome.holder.holder })
        return
      case 'reserved':
      case 'free':
        grant()
        return
      case 'self':
        finish({ kind: 'self' })
        return
      case 'occupied':
        finish({ kind: 'occupied', requester: outcome.requester })
        return
      case 'reservedForOther':
        // 续期时本人的请求还在槽里（服务端照样续了期）：撤回它，免得之后又交给一个不再等的页面。服务端现有的写路径下续期得不到它
        // （保留与待回应的请求不会同时在没人占着的一行上，edit-request-rules.ts 的 decideRequestRenewal，M3-P5 审查 A6），这里留作防御
        if (source === 'renew')
          void api.cancel(documentId).catch(() => undefined)
        finish({ kind: 'reserved-for-other', reservedFor: outcome.reservedFor, reservedUntil: outcome.reservedUntil })
        return
      case 'gone':
        finish({ kind: 'gone' })
    }
  }

  /** 续期一次（等待中、会话是本人、没有在途的）：先看空闲；回来之后按发出的时刻排下一次 */
  async function renew(): Promise<void> {
    if (disposed || progress?.kind !== 'waiting' || !active || renewingRound === rounds)
      return
    if (idleNow()) {
      quitForIdle()
      return
    }
    stopTimer()
    const round = rounds
    const sentAt = clock.now()
    renewingRound = round
    let outcome: EditRequestOutcome
    try {
      outcome = await api.renew(documentId)
    }
    catch (error) {
      if (round !== rounds || disposed)
        return
      options.trace?.({ kind: 'request-renewed', at: clock.now(), outcome: failureOf(error) })
      if (isPermissionDeniedError(error) || isNotFoundError(error)) {
        finish({ kind: 'failed', error })
        return
      }
      if (isAuthenticationError(error) || isCsrfTokenError(error))
        options.onSessionProblem(error)
      schedule(Math.max(0, sentAt + REQUEST_RENEW_MS - clock.now()))
      return
    }
    finally {
      if (renewingRound === round)
        renewingRound = undefined
    }
    if (round !== rounds || disposed || progress?.kind !== 'waiting')
      return
    options.trace?.({ kind: 'request-renewed', at: clock.now(), outcome: outcome.kind })
    apply(outcome, 'renew')
    schedule(Math.max(0, sentAt + REQUEST_RENEW_MS - clock.now()))
  }

  // 回到前台：先按隐藏之前的操作看空闲（同步，回来时的第一下鼠标移动还没到），再进入编辑或者立即续期
  const stopWatchingVisibility = options.visibility.onChange(() => {
    if (disposed || options.visibility.hidden())
      return
    if ((progress?.kind === 'waiting' || progress?.kind === 'granted') && idleNow()) {
      quitForIdle()
      return
    }
    if (progress?.kind === 'granted')
      tryEnter()
    else
      void renew()
  })

  return {
    progress: () => progress,
    version: () => version,

    send: async () => {
      if (disposed || progress !== undefined)
        return
      rounds += 1
      const round = rounds
      since = clock.now()
      set({ kind: 'sending' })
      let outcome: EditRequestOutcome
      try {
        outcome = await api.send(documentId)
      }
      catch (error) {
        if (round === rounds && !disposed) {
          options.trace?.({ kind: 'request-sent', at: clock.now(), outcome: failureOf(error) })
          finish({ kind: 'failed', error })
        }
        return
      }
      if (round !== rounds || disposed)
        return
      options.trace?.({ kind: 'request-sent', at: clock.now(), outcome: outcome.kind })
      if (outcome.kind === 'pending') {
        set({ kind: 'waiting', holder: outcome.holder.holder, cancelFailure: undefined })
        schedule(REQUEST_RENEW_MS)
        return
      }
      apply(outcome, 'send')
    },

    resume: (holder) => {
      if (disposed || progress !== undefined)
        return
      rounds += 1
      since = clock.now()
      set({ kind: 'waiting', holder, cancelFailure: undefined })
      void renew()
    },

    cancel: async () => {
      if (disposed || (progress?.kind !== 'waiting' && progress?.kind !== 'granted'))
        return
      const holder = progress.kind === 'waiting' ? progress.holder : undefined
      rounds += 1
      const round = rounds
      stopTimer()
      set({ kind: 'cancelling', holder })
      try {
        await api.cancel(documentId)
      }
      catch (error) {
        if (round !== rounds || disposed)
          return
        if (isAuthenticationError(error) || isCsrfTokenError(error))
          options.onSessionProblem(error)
        // 没取消成：请求还在（结果未知时下一次续期见分晓），回到等待、说明原因，接着续期
        set({ kind: 'waiting', holder, cancelFailure: error })
        void renew()
        return
      }
      if (round === rounds && !disposed)
        finish({ kind: 'cancelled' })
    },

    retry: tryEnter,

    setActive: (next) => {
      active = next
      if (!next) {
        stopTimer()
        return
      }
      if (progress?.kind === 'granted')
        tryEnter()
      else
        void renew()
    },

    withdraw: () => {
      if (disposed || progress === undefined)
        return
      void api.cancel(documentId).catch(() => undefined)
      rounds += 1
      stopTimer()
      set(undefined)
    },

    dispose: () => {
      if (disposed)
        return
      disposed = true
      rounds += 1
      stopTimer()
      stopWatchingVisibility()
    },
  }
}
