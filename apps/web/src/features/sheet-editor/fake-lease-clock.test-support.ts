// 测试用：编辑租约的假时钟（edit-lease.ts 的 LeaseClock）。时间只在 advance 时前进，到点的计时器按时间顺序执行，
// 每执行一个都让排着的 Promise 跑完（假的接口的回包、续租之后排下一次），所以一次 advance 可以走过好几轮心跳。
import type { LeaseClock } from './edit-lease.ts'

interface Timer {
  readonly at: number
  readonly callback: () => void
  cancelled: boolean
}

/** 让已经排着的 Promise 回调都执行完（借一个真实的宏任务） */
export async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

export interface FakeLeaseClock {
  readonly clock: LeaseClock
  /** 时间前进 ms 毫秒，途中到点的计时器依次执行 */
  readonly advance: (ms: number) => Promise<void>
  /** 时间同步地前进 ms 毫秒，不执行计时器：模拟一段同步的耗时（例如自动保存的捕获），到点的计时器在下一次 advance 时执行 */
  readonly elapse: (ms: number) => void
  /** 还没执行、没取消的计时器个数 */
  readonly pending: () => number
  /** 现在（毫秒） */
  readonly now: () => number
}

export function fakeLeaseClock(start = 1_000): FakeLeaseClock {
  let now = start
  const timers: Timer[] = []
  const clock: LeaseClock = {
    now: () => now,
    schedule: (callback, delayMs) => {
      const timer: Timer = { at: now + delayMs, callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  }
  const live = (): Timer[] => timers.filter(timer => !timer.cancelled)
  return {
    clock,
    advance: async (ms) => {
      const target = now + ms
      await settle()
      for (;;) {
        const due = live().filter(timer => timer.at <= target).sort((a, b) => a.at - b.at)[0]
        if (due === undefined)
          break
        // 计时器里可能用 elapse 拨快过：时间只往前走
        now = Math.max(now, due.at)
        due.cancelled = true
        due.callback()
        await settle()
      }
      now = Math.max(now, target)
      await settle()
    },
    elapse: (ms) => {
      now += ms
    },
    pending: () => live().length,
    now: () => now,
  }
}
