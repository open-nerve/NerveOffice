// 同一个浏览器里的标签页（M3-P5 设计 §3.1、§3.7、§3.10）：Web Locks 与交接频道的薄适配。不依赖 Univer 与界面；浏览器的两样 API 经参数注入
// （组装处给出 navigator.locks 与 BroadcastChannel，start.tsx），单元测试用假的（same-browser.test-support.ts）。
// - 锁 nerve-doc:<documentId>（00 号计划书 §7.5 的锁名）：正在编辑的标签页从服务端批准之后直到离开编辑持有它（先服务端、后本机锁，
//   设计 §3.1 第 2 条）。tryHold 锁空着才拿（ifAvailable）；steal 抢——原来的持有者的请求以 AbortError 结束，它的句柄的 stolen 随之兑现；
//   heldHere 看本浏览器里有没有标签页持有它（query：别的浏览器、配置文件、无痕窗口与设备都看不到）。拿到之后锁的回调一直挂着，
//   直到 release；页面关闭、刷新、导航离开、崩溃时浏览器自己放开（探索 §3.2：1–13 ms）；
//   untilFree 等它空着（排队、轮到即放开，只当信号）：同一个浏览器里的交接以它为"那边做完了"的信号；
// - 锁 nerve-office:edit-request:<documentId>（M3-P5 复验 C2）：发出过请求编辑的标签页在等待（含编辑权交给了本页、还没进入的 granted）期间
//   以共享方式持有它（holdIssuedRequest；同一个人在两页都点了"请求编辑"时两页都持有）。issuedRequestHeld 看本浏览器里有没有标签页持有它：
//   "复制标签页"会连同 sessionStorage 里"发出过请求"的记号（issued-request.ts）一起复制，记号对得上而这把锁有人持有，说明原来那页还在、
//   自己是复制出来的；没人持有说明原来那页已经刷新或关掉（浏览器在页面卸载时替它放开）；
// - 交接频道 nerve-office:doc:<documentId>（BroadcastChannel）：同一个浏览器里本人接管时的请求与回应（设计 §3.7；请求方一侧在 self-takeover.ts，
//   回应的一侧在 tab-handover.ts）。
//   消息带版本（v）：两个标签页可能载入了不同版本的页面，版本不同的、解析不出的、请求里的文档不是这一份的一律忽略（对方按没有回应处理）。
//   只带文档、请求、标签页与用户的标识，不带令牌（设计 §3.13）；回应按 requestId 配对（onReply）。用 addEventListener('message')：
//   E2E 的"吞消息"注入按它写（设计 §4）。频道在第一次收发时才打开；
// - 浏览器没有这两样时（不支持、不在安全上下文里，或者锁的请求出错）退化：拿到的句柄从不被抢、本浏览器里看不到别人，频道不通——
//   这一页照常编辑，同一个浏览器里的交接退回跨设备的做法（服务端照样是唯一的权威）；请求编辑的恢复退回只看记号。
import { z } from 'zod'

/** 本页持有的锁（正在编辑：服务端批准之后直到离开编辑） */
export interface HeldLock {
  /** 放开（离开编辑）：之后被抢也不再兑现 stolen。重复调用无害 */
  readonly release: () => void
  /** 被本浏览器的别的标签页抢走（steal，本页的请求以 AbortError 结束）时兑现；放开之后不再兑现 */
  readonly stolen: Promise<void>
}

/** 交接消息的版本：不同版本的消息一律忽略 */
export const HANDOVER_MESSAGE_VERSION = 1

/** 回应交接请求时本页在做什么（handover-ack）：editing 开始先保存再交出；exiting 正在退出编辑，照常退出（都会放锁） */
export const HANDOVER_ACK_STATES = ['editing', 'exiting'] as const
export type HandoverAckState = (typeof HANDOVER_ACK_STATES)[number]

/**
 * 交出没能完成的原因（handover-failed）：本页的修改没存上（保存失败、单元格提交不了）、版本冲突、会话不对；not-handed-over 是修改都已存上，
 * 但本页正在把编辑权交给请求编辑的人、没交出去（请求已经不在、没有结果），留在编辑（M3-P5 审查 B11）
 */
export const HANDOVER_FAILURES = ['not-saved', 'conflict', 'session', 'not-handed-over'] as const
export type HandoverFailure = (typeof HANDOVER_FAILURES)[number]

/**
 * 交接频道上的消息（设计 §3.7）。from 是发出的标签页（本页的 clientInstanceId）：
 * - handover-request：新标签页请正在编辑的标签页先保存再交出（带请求方的用户 id：只理会同一个人的）；
 * - handover-ack：收到了，开始交出（或者正在退出编辑）；handover-busy：正在进入编辑，稍后再请求；
 * - handover-done：存上了、已经释放并放锁；handover-failed：没能交出（原因），留在编辑
 */
export type HandoverMessage
  = | { readonly type: 'handover-request', readonly requestId: string, readonly documentId: string, readonly from: string, readonly userId: string }
    | { readonly type: 'handover-ack', readonly requestId: string, readonly from: string, readonly state: HandoverAckState }
    | { readonly type: 'handover-busy', readonly requestId: string, readonly from: string }
    | { readonly type: 'handover-done', readonly requestId: string, readonly from: string }
    | { readonly type: 'handover-failed', readonly requestId: string, readonly from: string, readonly reason: HandoverFailure }

/** 对交接请求的回应 */
export type HandoverReply = Exclude<HandoverMessage, { readonly type: 'handover-request' }>

const version = z.literal(HANDOVER_MESSAGE_VERSION)

/** 收到的消息按它解析（结构宽松：多出的字段丢弃；缺字段、取值不认识、版本不同的整个不认） */
const handoverMessageSchema = z.discriminatedUnion('type', [
  z.object({ v: version, type: z.literal('handover-request'), requestId: z.uuid(), documentId: z.uuid(), from: z.uuid(), userId: z.uuid() }),
  z.object({ v: version, type: z.literal('handover-ack'), requestId: z.uuid(), from: z.uuid(), state: z.enum(HANDOVER_ACK_STATES) }),
  z.object({ v: version, type: z.literal('handover-busy'), requestId: z.uuid(), from: z.uuid() }),
  z.object({ v: version, type: z.literal('handover-done'), requestId: z.uuid(), from: z.uuid() }),
  z.object({ v: version, type: z.literal('handover-failed'), requestId: z.uuid(), from: z.uuid(), reason: z.enum(HANDOVER_FAILURES) }),
])

/**
 * 解析交接频道收到的数据：认不出（不是对象、版本不同、缺字段、取值不认识）时为 undefined。documentId 是这条频道的文档：
 * 请求里的文档对不上时同样不认（频道按文档分开，对不上只可能是别处的数据）
 */
export function parseHandoverMessage(data: unknown, documentId: string): HandoverMessage | undefined {
  const parsed = handoverMessageSchema.safeParse(data)
  if (!parsed.success)
    return undefined
  const { v: _version, ...message } = parsed.data
  if (message.type === 'handover-request' && message.documentId !== documentId)
    return undefined
  return message
}

/** 本页这一份文档在同一个浏览器里的锁与交接频道 */
export interface SameBrowser {
  /** 锁空着就拿（ifAvailable）；被本浏览器的别的标签页占着时为 undefined。从不失败 */
  readonly tryHold: () => Promise<HeldLock | undefined>
  /** 抢（steal）：立即拿到，原来的持有者的句柄随之兑现 stolen。从不失败 */
  readonly steal: () => Promise<HeldLock>
  /** 本浏览器里有没有标签页持有这把锁（本页持有的也算）。查不出时为 false */
  readonly heldHere: () => Promise<boolean>
  /**
   * 等锁直到空着（M3-P5 设计 §3.7：同一个浏览器里的交接以它为信号——正在编辑的标签页存上、放弃那一代之后才放锁，关闭、刷新、崩溃时浏览器替它放）：
   * 排队请求一次，轮到时立即放开（只当信号，不持有：拿锁一律在服务端批准之后，设计 §3.1 第 2 条），交回 true；signal 撤销时（时限到了、
   * 不再等）从队里撤下，交回 false。浏览器没有锁、请求出错时立即交回 false。从不失败
   */
  readonly untilFree: (signal: AbortSignal) => Promise<boolean>
  /**
   * 以共享方式拿"发出过请求编辑"的锁（M3-P5 复验 C2，见文件头）：发出过请求的这一页在等待（含 granted）期间持有，请求结束、进入编辑、撤回时
   * release。别的标签页同样共享地拿得到（同一个人在两页都点了"请求编辑"）。浏览器没有锁、请求出错时交回从不被抢的句柄。从不失败
   */
  readonly holdIssuedRequest: () => Promise<HeldLock>
  /** 本浏览器里有没有标签页持有"发出过请求编辑"的锁（本页持有的也算）。查不出时为 false（退回只看记号） */
  readonly issuedRequestHeld: () => Promise<boolean>
  /** 发给本浏览器里别的标签页（本页自己收不到，BroadcastChannel 的约定）。频道不通时什么也不做 */
  readonly post: (message: HandoverMessage) => void
  /** 收别的标签页发来的、认得出的消息（parseHandoverMessage）；返回退订的函数 */
  readonly subscribe: (listener: (message: HandoverMessage) => void) => () => void
  /** 关掉频道（卸载时）：之后不再收发。锁不受影响（各自的句柄 release） */
  readonly close: () => void
}

/**
 * 锁的请求的选项（Web Locks 的 LockOptions 里用到的部分；signal 给等锁的请求撤销用：交接以等锁为信号，untilFree；mode 不给时是 exclusive，
 * 只有"发出过请求编辑"的锁用 shared）
 */
export interface LockRequestOptions {
  readonly mode?: 'exclusive' | 'shared'
  readonly ifAvailable?: boolean
  readonly steal?: boolean
  readonly signal?: AbortSignal
}

/** Web Locks 用到的部分（navigator.locks 满足它） */
export interface LockApi {
  /**
   * 请求锁：拿到时以锁调用 callback（ifAvailable 而锁被占着时以 null 调用），callback 交回的 Promise 结束时放开；
   * 交回的 Promise 在放开之后兑现，被抢（steal）时以 AbortError 拒绝
   */
  readonly request: (name: string, options: LockRequestOptions, callback: (lock: unknown) => Promise<void>) => Promise<unknown>
  /** 本浏览器里持有与等着的锁 */
  readonly query: () => Promise<{ readonly held?: readonly { readonly name?: string }[] | undefined }>
}

/** BroadcastChannel 用到的部分 */
export interface ChannelApi {
  readonly postMessage: (message: unknown) => void
  readonly addEventListener: (type: 'message', listener: (event: MessageEvent<unknown>) => void) => void
  readonly removeEventListener: (type: 'message', listener: (event: MessageEvent<unknown>) => void) => void
  readonly close: () => void
}

/** 组装处给出的浏览器 API：没有时为 undefined（退化，见文件头） */
export interface SameBrowserApis {
  /** navigator.locks */
  readonly locks: LockApi | undefined
  /** 打开一个 BroadcastChannel */
  readonly openChannel: ((name: string) => ChannelApi) | undefined
}

/** 这份文档的锁名（00 号计划书 §7.5） */
export function lockNameOf(documentId: string): string {
  return `nerve-doc:${documentId}`
}

/** 这份文档的交接频道名（设计 §3.7） */
export function channelNameOf(documentId: string): string {
  return `nerve-office:doc:${documentId}`
}

/** 这份文档"发出过请求编辑"的锁名（M3-P5 复验 C2）：与 sessionStorage 里那个记号的键同名（锁与存储是两个名字空间） */
export function issuedRequestLockNameOf(documentId: string): string {
  return `nerve-office:edit-request:${documentId}`
}

/** 浏览器拒绝请求的原因是不是"被抢"（AbortError：各家的说明不同，只认名字，探索 §3.2） */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

/** 没有锁可用时的句柄：从不被抢，放开什么也不做 */
const UNTRACKED: HeldLock = { release: () => {}, stolen: new Promise<void>(() => {}) }

/**
 * 请求一次锁：拿到了交回句柄（回调一直挂着，直到 release）；ifAvailable 而锁被占着时为 'busy'；
 * 请求本身出错（没拿到就被拒绝）时为 'unavailable'
 */
async function request(locks: LockApi, name: string, options: LockRequestOptions): Promise<HeldLock | 'busy' | 'unavailable'> {
  let settle: (outcome: HeldLock | 'busy' | 'unavailable') => void = () => {}
  const outcome = new Promise<HeldLock | 'busy' | 'unavailable'>((resolve) => {
    settle = resolve
  })
  let released = false
  let release: () => void = () => {}
  const holding = new Promise<void>((resolve) => {
    release = resolve
  })
  let stolen: () => void = () => {}
  const handle: HeldLock = {
    release: () => {
      released = true
      release()
    },
    stolen: new Promise<void>((resolve) => {
      stolen = resolve
    }),
  }
  let granted = false
  let result: Promise<unknown>
  try {
    result = locks.request(name, options, async (lock) => {
      if (lock === null) {
        settle('busy')
        return
      }
      granted = true
      settle(handle)
      await holding
    })
  }
  catch {
    return 'unavailable'
  }
  result.then(
    () => settle('unavailable'),
    (error: unknown) => {
      // 拿到之后被抢：本页还没放开时才算（放开与被抢同时发生时，放开在先）
      if (granted && !released && isAbortError(error))
        stolen()
      settle('unavailable')
    },
  )
  return outcome
}

/** 本浏览器里有没有标签页持有这把锁（query：别的浏览器、配置文件、无痕窗口与设备都看不到）。浏览器没有锁、查不出时为 false */
async function heldInBrowser(locks: LockApi | undefined, name: string): Promise<boolean> {
  if (locks === undefined)
    return false
  try {
    const snapshot = await locks.query()
    return (snapshot.held ?? []).some(lock => lock.name === name)
  }
  catch {
    return false
  }
}

/**
 * 这份文档的锁与交接频道（见文件头）。apis 由组装处给出：浏览器没有的那一样为 undefined，对应的部分退化
 */
export function sameBrowserFor(documentId: string, apis: SameBrowserApis): SameBrowser {
  const name = lockNameOf(documentId)
  const issuedName = issuedRequestLockNameOf(documentId)
  const { locks, openChannel } = apis
  let channel: ChannelApi | undefined
  let closed = false
  const listeners = new Set<(message: HandoverMessage) => void>()

  function onMessage(event: MessageEvent<unknown>): void {
    const message = parseHandoverMessage(event.data, documentId)
    if (message === undefined)
      return
    for (const listener of [...listeners])
      listener(message)
  }

  /** 频道（第一次收发时打开）：没有 BroadcastChannel、已经关掉、打开出错时为 undefined */
  function channelNow(): ChannelApi | undefined {
    if (channel !== undefined || closed || openChannel === undefined)
      return channel
    try {
      channel = openChannel(channelNameOf(documentId))
    }
    catch {
      return undefined
    }
    channel.addEventListener('message', onMessage)
    return channel
  }

  return {
    tryHold: async () => {
      if (locks === undefined)
        return UNTRACKED
      const outcome = await request(locks, name, { ifAvailable: true })
      if (outcome === 'busy')
        return undefined
      return outcome === 'unavailable' ? UNTRACKED : outcome
    },
    steal: async () => {
      if (locks === undefined)
        return UNTRACKED
      const outcome = await request(locks, name, { steal: true })
      return typeof outcome === 'string' ? UNTRACKED : outcome
    },
    heldHere: async () => heldInBrowser(locks, name),
    untilFree: async (signal) => {
      if (locks === undefined || signal.aborted)
        return false
      try {
        // 轮到时回调立即结束：锁随之放开，不占着它
        await locks.request(name, { signal }, async () => {})
        return true
      }
      catch {
        // 撤销（AbortError、TimeoutError）或请求出错
        return false
      }
    },
    holdIssuedRequest: async () => {
      if (locks === undefined)
        return UNTRACKED
      // 共享：别的标签页也只共享地拿它，ifAvailable 实际上总能拿到；万一拿不到（被独占着）、请求出错，退回从不被抢的句柄
      const outcome = await request(locks, issuedName, { mode: 'shared', ifAvailable: true })
      return typeof outcome === 'string' ? UNTRACKED : outcome
    },
    issuedRequestHeld: async () => heldInBrowser(locks, issuedName),
    post: (message) => {
      const open = channelNow()
      try {
        open?.postMessage({ v: HANDOVER_MESSAGE_VERSION, ...message })
      }
      catch {
        // 频道已经关掉（页面在卸载）：对方按没有回应处理
      }
    },
    subscribe: (listener) => {
      channelNow()
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => {
      closed = true
      listeners.clear()
      channel?.removeEventListener('message', onMessage)
      channel?.close()
      channel = undefined
    },
  }
}

/** 只收 requestId 那一次请求的回应（ack、busy、done、failed）：别的请求的回应、请求本身一律不交出。返回退订的函数 */
export function onReply(browser: Pick<SameBrowser, 'subscribe'>, requestId: string, listener: (reply: HandoverReply) => void): () => void {
  return browser.subscribe((message) => {
    if (message.type !== 'handover-request' && message.requestId === requestId)
      listener(message)
  })
}

/** 只收交接请求（handover-request）。返回退订的函数 */
export function onRequest(browser: Pick<SameBrowser, 'subscribe'>, listener: (request: Extract<HandoverMessage, { readonly type: 'handover-request' }>) => void): () => void {
  return browser.subscribe((message) => {
    if (message.type === 'handover-request')
      listener(message)
  })
}
