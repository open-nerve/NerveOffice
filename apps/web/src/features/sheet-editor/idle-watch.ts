// 空闲释放的计时（M3-P5 设计 §3.9，US-M3-07）：编辑时本页多久没有键盘、鼠标操作，满了阈值（EDIT_IDLE_RELEASE_SECONDS）就交给编辑模式
// 先保存再释放。不依赖 Univer 与界面；时钟与页面的可见性注入，用假的做单元测试（idle-watch.test.ts）。
// - 截止时刻：max(最后一次操作, 进入编辑的时刻) + 阈值——起点不早于进入编辑：打开很久才进入编辑（请求被批准之后自动进入的人也是）另有完整的
//   一段。一个计时器排在截止时刻，到点重算：其间有过操作就按新的截止时刻重排，没有就交出（onIdle），之后停下，直到 resume；
// - 后台：Chrome 隐藏的页面计时器降频（空闲释放最多晚约一分钟），Safari 隐藏约 6 秒之后计时器停止——回到前台时（可见性变成 visible 的
//   通知里，同步）立即判断。隐藏期间不会有操作，这一刻的"最后一次操作"就是隐藏之前的那一次：回来时的第一下鼠标移动还没到，不会把它冲掉
//   （之后照样停在暂停里的计时器恢复时再到点，这时已经交出或者重排过了，不会交出两次）；
// - "有操作"由页面记下（edit-lease.ts 的 trackActivity：只认可信事件，零位移的移动不算）。
import type { LeaseClock } from './edit-lease.ts'
import type { PageVisibility } from './reading-checks.ts'

export interface IdleWatchOptions {
  readonly clock: LeaseClock
  readonly visibility: PageVisibility
  /** 本页最后一次键盘、鼠标操作的时刻（clock.now 的时间轴上） */
  readonly lastActivity: () => number
  /** 进入编辑的时刻（同一个时间轴）：空闲从它与最后一次操作中较晚的那个算起 */
  readonly since: number
  /** 阈值（毫秒） */
  readonly thresholdMs: number
  /** 空闲满了阈值：之后停下（不再到点、回到前台也不判断），直到 resume */
  readonly onIdle: () => void
}

export interface IdleWatch {
  /** 停下（开始离开编辑时）：取消计时器，回到前台也不再判断，直到 resume */
  readonly stop: () => void
  /**
   * 接着看：delayMs 之后判断一次（空闲释放没存上、留在编辑时，过一个心跳周期再看），那时还没满就按截止时刻重排。不给时尽快判断
   * （下一个计时器；退出编辑没有成功：人刚按过，多半按截止时刻重排）
   */
  readonly resume: (delayMs?: number) => void
  /** 停下并退订页面的可见性（离开编辑之后） */
  readonly dispose: () => void
}

export function createIdleWatch(options: IdleWatchOptions): IdleWatch {
  const { clock, thresholdMs } = options
  let watching = true
  let disposed = false
  let cancelTimer: (() => void) | undefined

  /** 截止时刻：最后一次操作与进入编辑中较晚的那个，加上阈值 */
  function deadline(): number {
    return Math.max(options.lastActivity(), options.since) + thresholdMs
  }

  function stopTimer(): void {
    cancelTimer?.()
    cancelTimer = undefined
  }

  function scheduleCheck(at: number): void {
    stopTimer()
    cancelTimer = clock.schedule(() => {
      cancelTimer = undefined
      check()
    }, Math.max(0, at - clock.now()))
  }

  /** 判断一次：满了就停下、交出；没满就按（可能被操作推后了的）截止时刻重排 */
  function check(): void {
    if (!watching || disposed)
      return
    const due = deadline()
    if (clock.now() < due) {
      scheduleCheck(due)
      return
    }
    watching = false
    stopTimer()
    options.onIdle()
  }

  const stopWatchingVisibility = options.visibility.onChange(() => {
    if (!options.visibility.hidden())
      check()
  })
  scheduleCheck(deadline())

  return {
    stop: () => {
      watching = false
      stopTimer()
    },
    resume: (delayMs = 0) => {
      if (disposed)
        return
      watching = true
      scheduleCheck(clock.now() + delayMs)
    },
    dispose: () => {
      disposed = true
      watching = false
      stopTimer()
      stopWatchingVisibility()
    },
  }
}
