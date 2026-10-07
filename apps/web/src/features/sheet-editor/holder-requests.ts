// 请求编辑：持有者这一侧（M3-P5 设计 §3.6，US-M3-06）。不依赖 Univer 与界面；接口、时钟、页面的可见性、"最后一次操作"、"现在在不在编辑"与
// "现在能不能自动交出"都注入，用假的做单元测试（holder-requests.test.ts）。阅读与编辑的状态机（edit-mode.ts）持有它：在等回应的请求与编辑时的说明
// 放进编辑与离开编辑的状态（页头下面的提示），离开编辑（先保存再交出）由状态机做——这里记下请求、算 2 分钟、发出谢绝与交出并给出结果。
// - 请求到了（arrive：心跳带来的待回应的请求，没有时为 null）：新的请求记下——编辑时（editing）本页已空闲满 EDIT_HANDOVER_IDLE_SECONDS（起点是
//   最后一次操作与进入编辑中较晚的那个）、会话可写、联网（writable）时随即自动交出（handOver：状态机在这一步里同步开始离开，不显示提示）；否则显示
//   提示（不移动焦点、不挂屏障）、开始 2 分钟的计时。进入编辑、离开编辑的过程中只记下（进入编辑之后 entered 随之处理，离开时用交出代替释放）。
//   请求不在了（请求方取消了、过期了）：提示消失，说明一句（notice）；刚谢绝的那个迟到了不再显示；正在谢绝时不管（谢绝有了结果再说）；
// - 2 分钟的计时（idle-watch.ts）：提示在的时候一旦空闲满 2 分钟就自动交出（会话可写、联网时；不然过一个心跳周期再看），回到前台按隐藏之前的
//   操作算；
// - 谢绝（"继续编辑"，decline）：带令牌，正在谢绝时提示的按钮不可用；成了提示消失，记下它（谢绝之前发出的心跳迟到时还会带着它）；没成就说明原因、
//   请求照旧在。得知这一代失效时与保存同一个处理：续上了就用现在的编辑权再谢绝一次，失效了交给失去编辑权（编辑租约通知状态机）；
// - 离开编辑时（状态机）：开始离开就停下计时（leaving）；要交给的是在等回应、没在谢绝的那一个（offer）；交出（handOver：POST …/handover，至多到
//   状态机给的时限）的结果——交出了（回包丢了的重试得到 handed_over、请求方已经接手得到 replaced 都算）、请求已经不在（EDIT_REQUEST_GONE，
//   租约不动：withdrawn，说明一句）、这一代已经因为别的原因失效、没有结果（网络、服务端出错、会话的问题、到了时限：failed，提示里说明原因，
//   请求照旧在）；留在编辑时（stayed）接着计时：自动交出没成的过一个心跳周期再看（再也存不上的不再试），别的照截止时刻；离开了、失去编辑权时
//   清掉（clear），换了一代（进入编辑）时重新开始（reset）。
import type { PendingEditRequest, UserSummary } from '@nerve-office/contracts'
import type { EditLease, EditLeaseApi, LeaseClock, LeaseLoss } from './edit-lease.ts'
import type { IdleWatch } from './idle-watch.ts'
import type { PageVisibility } from './reading-checks.ts'
import { EDIT_HANDOVER_IDLE_SECONDS, EDIT_LEASE_HEARTBEAT_SECONDS } from '@nerve-office/contracts'
import { ApiError, isAuthenticationError, isCsrfTokenError, NetworkError } from '../../shared/api/index.ts'
import { leaseLossOf, within } from './edit-lease.ts'
import { createIdleWatch } from './idle-watch.ts'

/** 有人请求编辑时，本页空闲满它就先保存再自动交出（US-M3-06）：2 分钟 */
const HANDOVER_IDLE_MS = EDIT_HANDOVER_IDLE_SECONDS * 1000

/** 自动交出这一轮没成（会话不对、没联网、没存上）之后，隔多久再看：一个心跳周期（M3-P5 设计 §3.6） */
const HANDOVER_RECHECK_MS = EDIT_LEASE_HEARTBEAT_SECONDS * 1000

/**
 * 持有者这一侧收到的请求编辑（M3-P5 设计 §3.6：心跳带来的待回应的请求）：标识（交出、谢绝时带上）与请求方；declining 是"继续编辑"正在谢绝；
 * failure 是上一次交出或谢绝没有成功的原因（没存上的不在这里：保存的状态自己说明），没有时为 undefined
 */
export interface IncomingRequest {
  readonly id: string
  readonly requester: UserSummary
  readonly declining: boolean
  readonly failure: { readonly action: 'handover' | 'decline', readonly error: unknown } | undefined
}

/** 编辑时的说明（M3-P5）：请求方取消了请求（心跳不再带来它，或者交出时它已经不在了） */
export interface EditingNotice {
  readonly kind: 'request-withdrawn'
  readonly requester: UserSummary
}

/**
 * 交出的结果（M3-P5 设计 §3.6）：交出了（回包丢了再交出得到 handed_over、请求方已经接手得到 replaced，都算）；请求已经不在了
 * （EDIT_REQUEST_GONE，租约不动）；这一代已经因为别的原因失效；没有结果（网络、服务端出错、会话的问题、到了时限）
 */
export type HandOverOutcome
  = | { readonly kind: 'handed' }
    | { readonly kind: 'gone' }
    | { readonly kind: 'lost', readonly loss: LeaseLoss }
    | { readonly kind: 'failed', readonly error: unknown }

const HANDED: HandOverOutcome = { kind: 'handed' }
const REQUEST_GONE: HandOverOutcome = { kind: 'gone' }

export interface HolderRequestsOptions {
  readonly documentId: string
  /** 交出与谢绝（编辑租约的接口，带令牌） */
  readonly api: Pick<EditLeaseApi, 'handOver' | 'decline'>
  /** 2 分钟的计时与交出的时限按它（单调的时钟，与编辑租约同一个） */
  readonly clock: LeaseClock
  readonly visibility: PageVisibility
  /** 本页最后一次键盘、鼠标操作的时刻（clock.now 的时间轴上） */
  readonly lastActivity: () => number
  /** 进入编辑的时刻（同一个时间轴）：2 分钟从它与最后一次操作中较晚的那个算起 */
  readonly editingSince: () => number
  /** 现在在编辑（不是进入、离开编辑的过程中）：请求到了随即处理、2 分钟到了交出，都只在编辑时 */
  readonly editing: () => boolean
  /** 不由用户发起的写的门槛（会话可写、联网）：自动交出要它，不主动向服务端确认会话 */
  readonly writable: () => boolean
  /** 自动交出（空闲满了 2 分钟）：状态机离开编辑（handover-request，auto），开始离开的那一步同步发生 */
  readonly handOver: () => void
  /** 在等回应的请求、编辑时的说明变了（状态机在编辑时随之更新） */
  readonly onChange: () => void
  /** 交出、谢绝得到未登录或令牌失效：交给页面确认会话 */
  readonly onSessionProblem: (error: ApiError) => void
}

export interface HolderRequests {
  /** 在等回应的请求；没有时为 undefined */
  readonly incoming: () => IncomingRequest | undefined
  /** 编辑时的说明（请求方取消了请求）；没有时为 undefined */
  readonly notice: () => EditingNotice | undefined
  /** 离开编辑、页面关闭时要交给的请求：在等回应、没在谢绝的那一个（正在谢绝的不算：人刚选了继续编辑）；没有时为 undefined */
  readonly offer: () => IncomingRequest | undefined
  /** 请求到了（心跳带来的待回应的请求，没有时为 null）：见文件头 */
  readonly arrive: (request: PendingEditRequest | null) => void
  /** 进入编辑之后：进入的过程中心跳就带来了请求，现在按编辑时的规则处理 */
  readonly entered: () => void
  /** "继续编辑"：带着 held 的令牌谢绝在等的那个请求（见文件头）；正在谢绝、没有请求时什么也不做 */
  readonly decline: (held: EditLease) => Promise<void>
  /** 把编辑权交给 request（带 held 现在的令牌，至多等到 until），交回结果；会话的问题另交给页面确认会话；到了时限算没有结果 */
  readonly handOver: (held: EditLease, request: IncomingRequest, until: number) => Promise<HandOverOutcome>
  /** 开始离开编辑：2 分钟的计时停下（离开期间不再到点） */
  readonly leaving: () => void
  /** 交出时请求已经不在（请求方取消了）：还是在等的那一个就去掉（提示随之消失），说明一句 */
  readonly withdrawn: (request: IncomingRequest) => void
  /** 交出没有结果：记在还在等的那个请求上（提示里说明原因，可以再按），请求照旧在 */
  readonly failed: (request: IncomingRequest, error: unknown) => void
  /**
   * 离开没成、留在编辑：请求还在等的接着计时——automatic（自动交出没成的那一次）过一个心跳周期再看，ended（再也存不上：版本冲突、与服务端不兼容）
   * 时不再试；别的照截止时刻
   */
  readonly stayed: (retry: { readonly automatic: boolean, readonly ended: boolean }) => void
  /** 离开了编辑、失去编辑权：请求、说明与计时都清掉 */
  readonly clear: () => void
  /** 换了一代（进入编辑）：之前的请求、说明与刚谢绝的那个不再算（之后的心跳带来的才算） */
  readonly reset: () => void
  /** 停下（卸载）：不再计时、不再回调 */
  readonly dispose: () => void
}

export function createHolderRequests(options: HolderRequestsOptions): HolderRequests {
  const { documentId, api, clock } = options
  /** 在等回应的请求编辑（心跳带来的）：编辑、离开编辑的过程中有；换了一代、离开编辑、失去编辑权时清掉 */
  let incoming: IncomingRequest | undefined
  /** 编辑时的说明（请求方取消了请求）：新的请求到了、离开编辑时清掉 */
  let notice: EditingNotice | undefined
  /** 刚谢绝的那个请求：谢绝之前发出的心跳迟到时还会带着它，不再显示 */
  let declinedId: string | undefined
  /** 有请求在等时 2 分钟的空闲计时（自动交出）：请求不在了、离开编辑时去掉 */
  let watch: IdleWatch | undefined
  let disposed = false

  /** 本页多久没有操作（毫秒）：起点是最后一次操作与进入编辑中较晚的那个 */
  function idleFor(): number {
    return clock.now() - Math.max(options.lastActivity(), options.editingSince())
  }

  /** 有请求在等时开始（或者重新开始）2 分钟的计时：起点同空闲释放（进入编辑的时刻与最后一次操作中较晚的那个），回到前台时按隐藏之前的操作算 */
  function startWatching(): void {
    watch?.dispose()
    watch = createIdleWatch({
      clock,
      visibility: options.visibility,
      lastActivity: options.lastActivity,
      since: options.editingSince(),
      thresholdMs: HANDOVER_IDLE_MS,
      onIdle: idleReached,
    })
  }

  function stopWatching(): void {
    watch?.dispose()
    watch = undefined
  }

  /**
   * 编辑时有了请求（心跳带来，或者进入编辑之前就到了）：开始 2 分钟的计时；本页已空闲满 2 分钟、会话可写、联网时随即交出（不显示提示：
   * 状态机开始离开在这一步里同步发生），否则显示提示（不移动焦点、不挂屏障）
   */
  function respond(): void {
    startWatching()
    if (idleFor() >= HANDOVER_IDLE_MS && options.writable()) {
      options.handOver()
      return
    }
    options.onChange()
  }

  /** 有请求在等、空闲满了 2 分钟：自动交出。会话不对、没联网时这一轮不交出（交出与保存都要它们；不主动向服务端确认会话），过一个心跳周期再看 */
  function idleReached(): void {
    if (!options.editing() || incoming === undefined || incoming.declining)
      return
    if (!options.writable()) {
      watch?.resume(HANDOVER_RECHECK_MS)
      return
    }
    options.handOver()
  }

  /** 请求方取消了请求（心跳不再带来它，交出时它已经不在了）：还是在等的那一个就去掉（提示随之消失），说明一句 */
  function withdraw(request: IncomingRequest): void {
    if (incoming?.id === request.id) {
      incoming = undefined
      stopWatching()
    }
    notice = { kind: 'request-withdrawn', requester: request.requester }
  }

  /** 交出、谢绝没有成功（没有结果、会话的问题）：记在还在等的那个请求上（提示里说明原因，可以再按），请求照旧在 */
  function noteFailure(request: IncomingRequest, action: 'handover' | 'decline', error: unknown): void {
    if (incoming?.id === request.id)
      incoming = { ...incoming, declining: false, failure: { action, error } }
  }

  /** 交出失败时的结果：请求已经不在；回包丢了的重试（handed_over）与请求方已经接手（replaced）算交出了；别的失效；没有结果 */
  function handOverOutcomeOf(error: unknown): HandOverOutcome {
    if (error instanceof ApiError && error.code === 'EDIT_REQUEST_GONE')
      return REQUEST_GONE
    const loss = leaseLossOf(error)
    if (loss?.kind === 'handed-over' || (loss?.kind === 'lease' && loss.reason === 'replaced'))
      return HANDED
    if (loss !== undefined)
      return { kind: 'lost', loss }
    if (isAuthenticationError(error) || isCsrfTokenError(error))
      options.onSessionProblem(error)
    return { kind: 'failed', error }
  }

  /** 发谢绝：成了交回 undefined，没成交回原因（会话的问题另交给页面确认会话） */
  async function sendDecline(held: EditLease, requestId: string): Promise<unknown> {
    for (let resent = false; ; resent = true) {
      const credentials = held.credentials()
      try {
        await api.decline(documentId, credentials.token, requestId)
        return undefined
      }
      catch (error) {
        const loss = leaseLossOf(error)
        if (loss === undefined) {
          if (isAuthenticationError(error) || isCsrfTokenError(error))
            options.onSessionProblem(error)
          return error
        }
        const outcome = await held.lose(loss, credentials)
        if (outcome.kind !== 'held' || resent)
          return outcome.kind === 'unknown' ? (outcome.error ?? error) : error
      }
    }
  }

  return {
    incoming: () => incoming,
    notice: () => notice,
    offer: () => incoming === undefined || incoming.declining ? undefined : incoming,

    arrive: (request) => {
      if (disposed)
        return
      if (request === null) {
        const gone = incoming
        if (gone === undefined || gone.declining)
          return
        withdraw(gone)
        options.onChange()
        return
      }
      if (request.id === declinedId || request.id === incoming?.id)
        return
      incoming = { id: request.id, requester: request.requester, declining: false, failure: undefined }
      notice = undefined
      if (options.editing())
        respond()
    },

    entered: () => {
      if (incoming !== undefined)
        respond()
    },

    decline: async (held) => {
      const request = incoming
      if (request === undefined || request.declining)
        return
      incoming = { ...request, declining: true, failure: undefined }
      options.onChange()
      const failure = await sendDecline(held, request.id)
      if (disposed || incoming?.id !== request.id)
        return
      if (failure === undefined) {
        incoming = undefined
        declinedId = request.id
        stopWatching()
      }
      else {
        noteFailure(request, 'decline', failure)
      }
      options.onChange()
    },

    handOver: async (held, request, until) => {
      const { token } = held.credentials()
      const sent = api.handOver(documentId, token, request.id).then(() => HANDED, (error: unknown) => handOverOutcomeOf(error))
      return within(clock, sent, until, { kind: 'failed', error: new NetworkError('交出编辑权没有在时限之内得到回答') })
    },

    leaving: () => {
      watch?.stop()
    },

    withdrawn: withdraw,

    failed: (request, error) => noteFailure(request, 'handover', error),

    stayed: ({ automatic, ended }) => {
      if (incoming === undefined)
        return
      if (!automatic)
        watch?.resume()
      else if (!ended)
        watch?.resume(HANDOVER_RECHECK_MS)
    },

    clear: () => {
      stopWatching()
      incoming = undefined
      notice = undefined
    },

    reset: () => {
      incoming = undefined
      notice = undefined
      declinedId = undefined
    },

    dispose: () => {
      disposed = true
      stopWatching()
    },
  }
}
