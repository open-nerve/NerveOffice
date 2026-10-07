// 本人接管（"在此编辑"，M3-P5 设计 §3.7，US-M3-08）之前的两种等待。不依赖 Univer 与界面；锁与频道、时钟与读编辑状态都注入，用假的做单元测试
// （self-takeover.test.ts）。编排在 tab-handover.ts，接管本身（申请、拿锁、重建）在 edit-mode.ts。
// - 同一个浏览器里请正在编辑的标签页先保存再交出（交接协议的请求方一侧，回应的一侧在 tab-handover.ts）：经交接频道发 handover-request，同时等
//   这份文档的本机锁空着（same-browser.ts 的 untilFree）——那边存上、放弃那一代（不释放，审查 B4）之后才放锁，关闭、刷新、崩溃时浏览器替它放，
//   所以"锁空了"在任何阶段都算那边做完了（收到 done 也是）：
//   · EDIT_TAB_HANDOVER_ACK_MS（3 秒）内回应 ack：等它做完，至多 EDIT_TAB_HANDOVER_DONE_MS（20 秒，从回应算）；
//   · 回应 failed：那边没能保存、留在编辑（原因）——交给页面让人选"仍在此编辑"或"取消"；
//   · 回应 busy（那边正在进入编辑）：隔 TAB_HANDOVER_BUSY_RETRY_MS 再请求一次，从第一次 busy 起至多 20 秒；
//   · 没有回应（冻结、Safari 暂停了后台页面、页面卡住、载入的是不认识这个版本的协议的页面），或者回应了、到时限没做完：按没有回应处理
//     （页面以本人接管申请、成功之后抢锁）。只认这一次请求的回应（requestId）。
//   时限按注入的时钟排（页面上是 setTimeout，E2E 的 page.clock 拨得动；AbortSignal.timeout 走真实的时间，拨不动），到点撤销等锁；
// - 刷新时在途的保存（设计 §3.7 的 R1）：上一个页面关闭时保存忙、留下了记号（pending-save-marker.ts），30 秒还没过——本人接管会结束那一代，
//   那次保存还在服务端检查快照、等锁的话会被挡掉，所以先等它：立即、之后每 PENDING_SAVE_POLL_MS（2 秒）读一次编辑状态，修订号比记号里的新
//   （那次保存提交了）就不再等；到了 30 秒（从记号的时刻算）也不再等。读失败的那一次不算，接着等。
import type { LeaseClock } from './edit-lease.ts'
import type { HandoverTrace } from './handover-trace.ts'
import type { PendingSave } from './pending-save-marker.ts'
import type { HandoverFailure, HandoverReply, SameBrowser } from './same-browser.ts'
import { EDIT_PENDING_SAVE_WAIT_MS, EDIT_TAB_HANDOVER_ACK_MS, EDIT_TAB_HANDOVER_DONE_MS } from '@nerve-office/contracts'
import { onReply } from './same-browser.ts'

/** 那边回应 busy（正在进入编辑）之后隔多久再请求一次 */
export const TAB_HANDOVER_BUSY_RETRY_MS = 1_000

/** 等刷新之前那次保存时读编辑状态的间隔（设计 §3.7 的 R1） */
export const PENDING_SAVE_POLL_MS = 2_000

/** 请正在编辑的标签页交出的结果 */
export type TabHandoverOutcome
  /**
   * 那边做完了（锁空了、收到 done）：存上、放弃了那一代、放了锁（交给标签页时不释放，审查 B4），或者关了、刷新了、已经不在编辑——页面以本人接管申请
   * （被自己占着就在同一个事务里换代，空着就是普通的取得）
   */
  = | { readonly kind: 'finished' }
  /** 没有回应，或者回应了、到时限没做完：页面以本人接管申请、成功之后抢锁 */
    | { readonly kind: 'silent' }
  /** 那边没能保存、留在编辑：原因（页面让人选"仍在此编辑"或"取消"） */
    | { readonly kind: 'failed', readonly reason: HandoverFailure }
  /** 本页不再等（signal 撤销：卸载、取消） */
    | { readonly kind: 'aborted' }

const FINISHED: TabHandoverOutcome = { kind: 'finished' }
const SILENT: TabHandoverOutcome = { kind: 'silent' }
const ABORTED: TabHandoverOutcome = { kind: 'aborted' }

export interface TabHandoverOptions {
  /** 这份文档的本机锁与交接频道 */
  readonly browser: Pick<SameBrowser, 'post' | 'subscribe' | 'untilFree'>
  readonly clock: LeaseClock
  readonly documentId: string
  /** 本页的标识（clientInstanceId） */
  readonly from: string
  /** 本页的用户：那边只理会同一个人的请求 */
  readonly userId: string
  /** 每次请求的标识 */
  readonly newId: () => string
  /** 本页不再等时撤销 */
  readonly signal: AbortSignal
  /** 测试构建的观察钩子（handover-trace.ts）：发出请求、收到回应、锁空了、到了时限；生产不给 */
  readonly trace?: HandoverTrace | undefined
}

/** 请本浏览器里正在编辑这份文档的标签页先保存再交出（见文件头）。从不失败 */
export async function askTabToHandOver(options: TabHandoverOptions): Promise<TabHandoverOutcome> {
  const { browser, clock, signal } = options
  if (signal.aborted)
    return ABORTED
  /** 等锁：结束时（不论结果）撤销 */
  const waiting = new AbortController()
  return new Promise<TabHandoverOutcome>((resolve) => {
    let settled = false
    let cancelTimer: (() => void) | undefined
    let stopListening: (() => void) | undefined
    /** 第一次回应 busy 的时刻：从它起至多 EDIT_TAB_HANDOVER_DONE_MS */
    let busySince: number | undefined

    function finish(outcome: TabHandoverOutcome): void {
      if (settled)
        return
      settled = true
      cancelTimer?.()
      stopListening?.()
      waiting.abort()
      signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }

    function onAbort(): void {
      finish(ABORTED)
    }

    /** 换一个时限：到点时 then */
    function within(delayMs: number, then: () => void): void {
      cancelTimer?.()
      cancelTimer = clock.schedule(then, delayMs)
    }

    /** 发一次请求，只收它的回应；EDIT_TAB_HANDOVER_ACK_MS 内没有回应就按没有回应处理 */
    function ask(): void {
      stopListening?.()
      const requestId = options.newId()
      stopListening = onReply(browser, requestId, answered)
      browser.post({ type: 'handover-request', requestId, documentId: options.documentId, from: options.from, userId: options.userId })
      options.trace?.({ kind: 'handover-request', at: clock.now(), requestId })
      within(EDIT_TAB_HANDOVER_ACK_MS, silent)
    }

    /** 到了时限：没有回应，或者回应了、没做完 */
    function silent(): void {
      options.trace?.({ kind: 'handover-silent', at: clock.now() })
      finish(SILENT)
    }

    function answered(reply: HandoverReply): void {
      options.trace?.({ kind: 'handover-reply', at: clock.now(), requestId: reply.requestId, reply: replyKindOf(reply), detail: reply.type === 'handover-ack' ? reply.state : (reply.type === 'handover-failed' ? reply.reason : null) })
      switch (reply.type) {
        case 'handover-ack':
          // 回应了：等它做完（锁空了、done、failed），到时限没做完按没有回应处理
          within(EDIT_TAB_HANDOVER_DONE_MS, silent)
          return
        case 'handover-busy': {
          busySince ??= clock.now()
          const left = busySince + EDIT_TAB_HANDOVER_DONE_MS - clock.now()
          if (left <= 0) {
            silent()
            return
          }
          // 不再收这一次的回应：隔一会儿换一个请求再问
          stopListening?.()
          stopListening = undefined
          within(Math.min(TAB_HANDOVER_BUSY_RETRY_MS, left), ask)
          return
        }
        case 'handover-done':
          finish(FINISHED)
          return
        case 'handover-failed':
          finish({ kind: 'failed', reason: reply.reason })
      }
    }

    signal.addEventListener('abort', onAbort)
    // 锁空了就是做完了（任何阶段：回应之前那边就已经关了、刷新了、失去了编辑权，也是）
    void browser.untilFree(waiting.signal).then((free) => {
      if (!free || settled)
        return
      options.trace?.({ kind: 'handover-lock-free', at: clock.now() })
      finish(FINISHED)
    })
    ask()
  })
}

/** 回应的种类（观察钩子里的写法） */
function replyKindOf(reply: HandoverReply): 'ack' | 'busy' | 'done' | 'failed' {
  switch (reply.type) {
    case 'handover-ack':
      return 'ack'
    case 'handover-busy':
      return 'busy'
    case 'handover-done':
      return 'done'
    case 'handover-failed':
      return 'failed'
  }
}

/** 等刷新之前那次保存的结果 */
export type PendingSaveWait
  /** 没有记号，或者记号已经过了 30 秒：不用等 */
  = | 'none'
  /** 那次保存提交了（编辑状态的修订号比记号里的新） */
    | 'committed'
  /** 等到了 30 秒（从记号的时刻算） */
    | 'expired'
  /** 本页不再等（signal 撤销） */
    | 'aborted'

export interface PendingSaveWaitOptions {
  /** 读出的记号（pending-save-marker.ts）；没有时 undefined */
  readonly marker: PendingSave | undefined
  /** 现在的墙上时间（毫秒，Date.now）：与记号的时刻比较（记号由另一个页面写下，单调的时钟各页面各算各的） */
  readonly wallNow: () => number
  /** 读编辑状态的间隔与 30 秒的时限按它排 */
  readonly clock: LeaseClock
  /** 读一次编辑状态，交回修订号；失败时抛出（这一次不算） */
  readonly revision: () => Promise<number>
  /** 要等的话，开始等之前调用一次（页面据此说明"上一个页面的保存还在进行"） */
  readonly onWait: () => void
  readonly signal: AbortSignal
}

/** 本人接管之前等刷新之前那次在途的保存（见文件头）。从不失败 */
export async function awaitPendingSave(options: PendingSaveWaitOptions): Promise<PendingSaveWait> {
  const { marker, clock, signal } = options
  if (marker === undefined)
    return 'none'
  // 墙上时间回拨时记号的时刻可能在"将来"：至多等满 30 秒
  const left = Math.min(EDIT_PENDING_SAVE_WAIT_MS, marker.at + EDIT_PENDING_SAVE_WAIT_MS - options.wallNow())
  if (left <= 0)
    return 'none'
  if (signal.aborted)
    return 'aborted'
  /** 那次保存的基准：编辑状态的修订号比它新就是提交了 */
  const base = marker.revision
  options.onWait()
  return new Promise<PendingSaveWait>((resolve) => {
    let settled = false
    let cancelPoll: (() => void) | undefined
    let cancelDeadline: (() => void) | undefined

    function finish(outcome: PendingSaveWait): void {
      if (settled)
        return
      settled = true
      cancelPoll?.()
      cancelDeadline?.()
      signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }

    function onAbort(): void {
      finish('aborted')
    }

    /** 读一次；没提交（或者读失败）就隔 PENDING_SAVE_POLL_MS 再读 */
    function poll(): void {
      cancelPoll = undefined
      void options.revision().then(
        (revision) => {
          if (revision > base)
            finish('committed')
          else
            next()
        },
        () => next(),
      )
    }

    function next(): void {
      if (!settled)
        cancelPoll = clock.schedule(poll, PENDING_SAVE_POLL_MS)
    }

    cancelDeadline = clock.schedule(() => finish('expired'), left)
    signal.addEventListener('abort', onAbort)
    poll()
  })
}
