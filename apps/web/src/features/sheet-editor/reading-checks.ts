// 阅读时的检查（US-M3-05；M3-P2 设计 §3.4 的"阅读者的定时检查"）：阅读时每 30 秒读一次编辑状态；进入阅读、回到前台、回到本人时
// 立即读一次；页面隐藏时暂停。结果怎样套用由阅读与编辑的状态机（edit-mode.ts）决定，这里只管什么时候读、哪一次的结果算数。
//
// 每一次检查都记着它发出时的轮次：立即读一次（checkNow）与停下（stop）都开始新的一轮，更早发出的那次回来时结果丢弃、也不再排下一次
// （审查 A9：阅读时有一次检查在途，进入编辑又退出，回到阅读时立即读的那一次与它并行，它的持有者、能不能编辑已经过时）。
// 所以同一时刻至多一个计时器，只有最新的那一次的结果有效。
import type { LeaseClock } from './edit-lease.ts'
import type { FetchedEditStatus } from './editor-api.ts'

/** 阅读时读编辑状态的间隔（M3 总设计 §2.1、US-M3-05）：30 秒 */
export const READING_CHECK_INTERVAL_MS = 30_000

/** 页面的可见性（document.visibilityState）：隐藏时暂停阅读时的检查 */
export interface PageVisibility {
  readonly hidden: () => boolean
  /** 隐藏与否变了；返回退订的函数 */
  readonly onChange: (listener: () => void) => () => void
}

/** 一次检查的结果：读到的编辑状态，或者请求失败的原因 */
export type ReadingCheckResult
  = | { readonly kind: 'status', readonly fetched: FetchedEditStatus }
    | { readonly kind: 'failed', readonly error: unknown }

export interface ReadingChecksOptions {
  readonly clock: LeaseClock
  readonly visibility: PageVisibility
  /** 读一次编辑状态 */
  readonly fetch: () => Promise<FetchedEditStatus>
  /** 现在可以检查：阅读中、会话是本人（页面的可见性由这里自己看） */
  readonly allowed: () => boolean
  /** 最新发出的那一次检查的结果（之后照常排下一次） */
  readonly onResult: (result: ReadingCheckResult) => void
}

export interface ReadingChecks {
  /** 立即读一次（进入阅读、回到本人时）：之前在途的那一次作废；之后每 30 秒一次 */
  readonly checkNow: () => void
  /** 停下（离开阅读、会话不是本人）：取消计时器，在途的那一次作废 */
  readonly stop: () => void
  readonly dispose: () => void
}

export function createReadingChecks(options: ReadingChecksOptions): ReadingChecks {
  /** 轮次：checkNow、stop 各加一，发出时记下的轮次不是现在的就作废 */
  let round = 0
  let cancelTimer: (() => void) | undefined
  let disposed = false

  function allowed(): boolean {
    return !disposed && !options.visibility.hidden() && options.allowed()
  }

  function stop(): void {
    round += 1
    cancelTimer?.()
    cancelTimer = undefined
  }

  function checkNow(): void {
    stop()
    run(round)
  }

  function run(issued: number): void {
    if (!allowed())
      return
    void options.fetch().then(
      fetched => finish(issued, { kind: 'status', fetched }),
      (error: unknown) => finish(issued, { kind: 'failed', error }),
    )
  }

  /** 一次检查回来了：之后又立即读过、停下过的，结果不再成立；否则交出结果，排下一次 */
  function finish(issued: number, result: ReadingCheckResult): void {
    if (issued !== round)
      return
    options.onResult(result)
    // 套用结果可能让检查停下（例如确认会话之后不是本人）：那就不排
    if (issued !== round || !allowed())
      return
    cancelTimer = options.clock.schedule(() => {
      cancelTimer = undefined
      run(issued)
    }, READING_CHECK_INTERVAL_MS)
  }

  // 隐藏时暂停（在途的那一次作废），回到前台时立即读一次
  const stopWatchingVisibility = options.visibility.onChange(() => {
    if (options.visibility.hidden())
      stop()
    else
      checkNow()
  })

  return {
    checkNow,
    stop,
    dispose: () => {
      disposed = true
      stop()
      stopWatchingVisibility()
    },
  }
}
