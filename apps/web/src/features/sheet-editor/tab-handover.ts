import type { FlushResult } from './autosave.ts'
// 同一个浏览器里的交接（M3-P5 设计 §3.7，US-M3-08）的两头：正在编辑的标签页怎样回应交接请求，与新标签页"在此编辑"的编排。不依赖 Univer 与界面；
// 锁与频道（same-browser.ts）、时钟、读编辑状态与刷新时在途的保存的记号都注入，用假的做单元测试（tab-handover.test.ts）。阅读与编辑的状态机
// （edit-mode.ts）持有它们：离开编辑（先保存再交出）、开始一件事与它的作废、申请并进入编辑都在状态机里，这里经回调调用。
// - 回应（answerTabs）：只理会同一个人的交接请求，而且本页确实还持有本机锁——被抢之后迟到的请求一律不理（页面卡住、冻结之后恢复时，排着的请求与
//   锁被抢的通知一起到，先后不定，探索 §3.2）。编辑时在消息的处理里同步回 ack（那边 3 秒内收不到就当本页没有回应），然后请状态机离开编辑
//   （handover-tab）；正在离开编辑时回 ack、照常离开；正在进入编辑时回 busy（那边稍后再请求）。离开有了结果时（finish）一一告诉回应过 ack 的请求：
//   done（存上、放了锁）或 failed（原因：版本冲突、会话不对、别的都是没存上，handoverFailureOf）；离开的途中失去编辑权时（forget）不另外告诉它们——
//   那边以锁空了为信号；
// - "在此编辑"（takeOverHere）：锁在本浏览器里没人持有（跨设备、另一个浏览器或配置文件、刚关闭或刷新过的页面、孤儿租约）——先等刷新之前在途的保存
//   （记号在 30 秒内时，self-takeover.ts），再以本人接管申请、拿锁；锁被本浏览器的标签页持有——请它先保存再交出（self-takeover.ts）：做完了（锁空了、
//   done）普通申请（它的释放没送到、得到被自己占着时改以本人接管），没有回应（冻结、暂停、卡住）或者回应了、到时限没做完——本人接管，拿锁时抢
//   （那边随即转为失去编辑权）；它没能保存（failed）就把原因交给阅读的进展，让人选"仍在此编辑"（anyway：本人接管并抢锁，不再请它交出）或"取消"。
//   进入了就清掉刷新时在途的保存的记号（它只用来挡住过早的接手）。
import type { AcquireIntent, LeaseClock } from './edit-lease.ts'
import type { HandoverTrace } from './handover-trace.ts'
import type { PendingSaveMarker } from './pending-save-marker.ts'
import type { HandoverFailure, HandoverMessage, SameBrowser } from './same-browser.ts'
import type { SaveStatus } from './save-coordinator.ts'
import { onRequest } from './same-browser.ts'
import { askTabToHandOver, awaitPendingSave } from './self-takeover.ts'

/**
 * "在此编辑"的进展（M3-P5 设计 §3.7）：preparing 刚开始（看锁在不在本浏览器）；asking 正在请本浏览器的另一个标签页先保存再交出；
 * waiting-save 在等刷新之前那个页面在途的保存；failed 是那个标签页没能保存、留在编辑（原因）——让人选"仍在此编辑"或"取消"。
 * 申请编辑权之后就是进入编辑（entering），不在这里
 */
export type TakeoverProgress
  = | { readonly kind: 'preparing' }
    | { readonly kind: 'asking' }
    | { readonly kind: 'waiting-save' }
    | { readonly kind: 'failed', readonly reason: HandoverFailure }

/**
 * 收到交接请求时本页在做什么（状态机按自己的状态给出）：editing 在编辑；exiting 正在离开编辑（退出、空闲释放、交出）；opening、entering 正在进入编辑
 * （?edit=new、"编辑"等：已经拿到锁、编辑器还没建好）；none 不在编辑（这时本页不持有锁，走不到）
 */
export type TabAnswerPhase = 'editing' | 'exiting' | 'opening' | 'entering' | 'none'

/** 离开编辑的结果（告诉回应过 ack 的交接请求）：done 是存上、放了锁；failed 是没能交出、留在编辑（原因） */
export type TabHandoverResult = { readonly kind: 'done' } | { readonly kind: 'failed', readonly reason: HandoverFailure }

/** 交接频道上的请求（M3-P5 设计 §3.7） */
type HandoverRequest = Extract<HandoverMessage, { readonly type: 'handover-request' }>

/**
 * 没能交出的原因（交接频道的 handover-failed）：版本冲突；会话不对（轮到上传时会话已经变差、没有发，或者现在会话不可写）；别的都是没存上
 * （保存失败、断网、单元格提交不了、公式没收齐的退出）
 */
export function handoverFailureOf(status: SaveStatus, flushed: FlushResult | undefined, sessionWritable: boolean): HandoverFailure {
  if (status === 'conflict')
    return 'conflict'
  const skipped = flushed?.outcome?.kind === 'skipped' && flushed.outcome.reason === 'session'
  return skipped || !sessionWritable ? 'session' : 'not-saved'
}

export interface TabAnswersOptions {
  /** 这份文档的本机锁与交接频道：订阅交接请求、发回应 */
  readonly browser: Pick<SameBrowser, 'post' | 'subscribe'>
  /** 本页的标识（clientInstanceId）：回应里是它 */
  readonly clientInstanceId: string
  /** 本页的用户：只理会同一个人的请求 */
  readonly userId: string
  readonly clock: LeaseClock
  /** 本页确实还持有本机锁（被抢之后、离开编辑之后没有） */
  readonly holdsLock: () => boolean
  /** 本页现在在做什么（TabAnswerPhase） */
  readonly phase: () => TabAnswerPhase
  /** 编辑时收到了请求、回了 ack：状态机离开编辑（handover-tab，先保存再交出） */
  readonly leave: () => void
  /** 测试构建的观察钩子（handover-trace.ts）：回应与告诉了它什么；生产不给 */
  readonly trace?: HandoverTrace | undefined
}

export interface TabAnswers {
  /** 离开编辑有了结果：回应过 ack 的交接请求一一告诉它们（done：存上、放了锁；failed：没存上、留在编辑） */
  readonly finish: (result: TabHandoverResult) => void
  /** 离开编辑的途中失去编辑权：等着接手的标签页以锁空了为信号（刚放下），不再另外告诉它们 */
  readonly forget: () => void
  /** 停下（卸载）：不再理会交接请求 */
  readonly dispose: () => void
}

/** 回应本浏览器里别的标签页的交接请求（见文件头） */
export function answerTabs(options: TabAnswersOptions): TabAnswers {
  const { browser, clock, clientInstanceId: from } = options
  /** 本页这一次离开编辑期间回应过 ack 的交接请求：离开结束时发 done，留在编辑时发 failed */
  let acknowledged: string[] = []
  let disposed = false

  function answer(request: HandoverRequest): void {
    if (disposed || request.userId !== options.userId || !options.holdsLock())
      return
    const { requestId } = request
    const phase = options.phase()
    switch (phase) {
      case 'editing':
        // 在这个消息的处理里同步回应（那边 3 秒内收不到就当本页没有回应），然后先保存再交出
        browser.post({ type: 'handover-ack', requestId, from, state: 'editing' })
        options.trace?.({ kind: 'handover-answer', at: clock.now(), requestId, answer: 'ack', state: 'editing' })
        acknowledged.push(requestId)
        options.leave()
        return
      case 'exiting':
        // 正在离开编辑（退出、空闲释放、交出）：照常离开，结束时告诉它
        browser.post({ type: 'handover-ack', requestId, from, state: 'exiting' })
        options.trace?.({ kind: 'handover-answer', at: clock.now(), requestId, answer: 'ack', state: 'exiting' })
        acknowledged.push(requestId)
        return
      case 'opening':
      case 'entering':
        // 正在进入编辑（已经拿到锁、编辑器还没建好）：它稍后再请求
        browser.post({ type: 'handover-busy', requestId, from })
        options.trace?.({ kind: 'handover-answer', at: clock.now(), requestId, answer: 'busy', state: phase })
        break
      case 'none':
        // 这些时候本页不持有锁，走不到这里
        break
    }
  }

  const stopAnswering = onRequest(browser, answer)

  return {
    finish: (result) => {
      const requests = acknowledged
      acknowledged = []
      for (const requestId of requests) {
        browser.post(result.kind === 'done' ? { type: 'handover-done', requestId, from } : { type: 'handover-failed', requestId, from, reason: result.reason })
        options.trace?.({ kind: 'handover-finish', at: clock.now(), requestId, outcome: result.kind, reason: result.kind === 'failed' ? result.reason : null })
      }
    },
    forget: () => {
      acknowledged = []
    },
    dispose: () => {
      disposed = true
      stopAnswering()
    },
  }
}

export interface TakeOverHereOptions {
  /** 这份文档的本机锁与交接频道 */
  readonly browser: SameBrowser
  readonly clock: LeaseClock
  readonly documentId: string
  /** 本页的标识（clientInstanceId） */
  readonly clientInstanceId: string
  /** 本页的用户：那边只理会同一个人的请求 */
  readonly userId: string
  /** 每次交接请求的标识 */
  readonly newId: () => string
  /** 刷新时在途的保存的记号（pending-save-marker.ts） */
  readonly pendingSave: PendingSaveMarker
  /** 现在的墙上时间（毫秒）：与记号的时刻比较 */
  readonly wallNow: () => number
  /** 读一次编辑状态，交回修订号（等刷新之前的保存）；失败时抛出 */
  readonly revision: () => Promise<number>
  /** "仍在此编辑"（那边没能交出之后再按）：本人接管、拿锁时抢，不再请它交出 */
  readonly anyway: boolean
  /** 本页不再等时撤销（取消、卸载、又开始一次） */
  readonly signal: AbortSignal
  /** 这一次接手还在（状态机没有开始别的事、没有卸载） */
  readonly still: () => boolean
  /** "在此编辑"有了新的进展（状态机放进阅读的状态） */
  readonly progress: (progress: TakeoverProgress) => void
  /**
   * 申请并进入编辑（状态机）：intent 是接管方式与"被自己占着要不要再试"；selfAfterHeld：被自己占着时改以本人接管再申请一次（同一个浏览器的交接
   * 做完了、那边的释放没送到）。交回进入了没有
   */
  readonly enter: (intent: AcquireIntent, selfAfterHeld: boolean) => Promise<boolean>
  /** 测试构建的观察钩子（handover-trace.ts）：生产不给 */
  readonly trace?: HandoverTrace | undefined
}

/**
 * "在此编辑"（见文件头）：从看锁在哪里到申请并进入编辑。从不失败。怎样申请按走到的那条路定好，最后只申请一次（进入了就清掉记号）——
 * 状态机按它作废这一次接手的每一步之间都看一眼 still
 */
export async function takeOverHere(options: TakeOverHereOptions): Promise<void> {
  const { browser, clock, signal } = options
  options.trace?.({ kind: 'takeover-start', at: clock.now(), anyway: options.anyway })
  // 本人接管、拿锁时抢：人选了"仍在此编辑"，或者那边没有回应（都不看记号：那边还活着）；本来就不在本浏览器时同样本人接管（看过记号之后）
  let intent: AcquireIntent = { takeover: 'self' }
  let selfAfterHeld = false
  if (!options.anyway) {
    const here = await browser.heldHere()
    if (!options.still())
      return
    options.trace?.({ kind: 'takeover-locate', at: clock.now(), here })
    let silent = false
    if (here) {
      options.progress({ kind: 'asking' })
      const outcome = await askTabToHandOver({ browser, clock, documentId: options.documentId, from: options.clientInstanceId, userId: options.userId, newId: options.newId, signal, trace: options.trace })
      if (!options.still() || outcome.kind === 'aborted')
        return
      if (outcome.kind === 'failed') {
        options.progress({ kind: 'failed', reason: outcome.reason })
        return
      }
      // 没有回应（冻结、暂停、卡住），或者回应了、到时限没做完：本人接管，拿锁时抢（那边随即转为失去编辑权）
      silent = outcome.kind === 'silent'
    }
    if (!silent) {
      // 锁空着（那边做完了、关了、刷新了，或者本来就在别处）：刷新之前那个页面在途的保存先提交，本人接管才不会把它挡掉（设计 §3.7 的 R1）
      const waited = await awaitPendingSave({
        marker: options.pendingSave.read(),
        wallNow: options.wallNow,
        clock,
        revision: options.revision,
        onWait: () => options.progress({ kind: 'waiting-save' }),
        signal,
      })
      if (waited === 'aborted' || !options.still())
        return
      // 那边交出了：普通申请，不再试（它的释放没送到、被自己占着时改以本人接管）
      if (here) {
        intent = { retrySameUser: async () => false }
        selfAfterHeld = true
      }
    }
  }
  // 接手：进入了就清掉刷新时在途的保存的记号（它只用来挡住过早的接手）
  if (await options.enter(intent, selfAfterHeld))
    options.pendingSave.clear()
}
