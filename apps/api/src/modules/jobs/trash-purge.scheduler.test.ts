// 定时器（M2-P4 设计 §3.4 第 6 条）：启动之后先等一小段跑第一轮、之后按间隔触发、时刻取自时钟、一轮结束才排下一轮、
// 停止之后不再触发、正在跑的一轮等它收尾、一轮失败不影响后面几轮。用假时钟与假的清理，不碰数据库。
import type { AppConfig } from '../config/index.ts'
import type { DatabaseTime } from '../database/index.ts'
import type { TrashPurgeJob, TrashPurgeRound } from './trash-purge.job.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { Clock, DatabaseClock } from './clock.ts'
import { FIRST_ROUND_DELAY_MS, firstDelayMs, nextDelayMs, TrashPurgeScheduler } from './trash-purge.scheduler.ts'

const INTERVAL_MS = 60_000
/** 一定跨过一轮的等待（间隔的 ±10%） */
const PAST_ONE_ROUND = INTERVAL_MS * 1.2
const ROUND: TrashPurgeRound = { ran: true, purged: 0, skipped: 0, failed: 0 }

/** 可控的时钟：测试把它往前推，服务看到的"现在"就变了 */
class FakeClock extends Clock {
  #current: Date

  constructor(start: Date) {
    super()
    this.#current = start
  }

  async now(): Promise<Date> {
    return this.#current
  }

  advanceDays(days: number): void {
    this.#current = new Date(this.#current.getTime() + days * 24 * 3_600_000)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((settle) => {
    resolve = settle
  }), resolve }
}

function setup(enabled = true, intervalMs = INTERVAL_MS) {
  const clock = new FakeClock(new Date('2026-09-30T02:00:00.000Z'))
  const job = { runOnce: vi.fn(async () => ROUND) }
  const config = { jobs: { trashPurge: { enabled, intervalMs, batchSize: 50 } } } as AppConfig
  const error = vi.spyOn(AppLogger.prototype, 'error')
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  return { clock, job, error, scheduler: new TrashPurgeScheduler(job as unknown as TrashPurgeJob, clock, config, logger) }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('TrashPurgeScheduler', () => {
  it('启动之后按间隔跑，每一轮的时刻取自时钟；一轮结束才排下一轮', async () => {
    const { scheduler, job, clock } = setup()
    scheduler.onModuleInit()
    expect(job.runOnce).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(job.runOnce).toHaveBeenCalledExactlyOnceWith(new Date('2026-09-30T02:00:00.000Z'))

    // 时钟往前推 30 天：下一轮拿到的是新的"现在"，到期的判断因此不必真的等
    clock.advanceDays(30)
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(job.runOnce).toHaveBeenCalledTimes(2)
    expect(job.runOnce).toHaveBeenLastCalledWith(new Date('2026-10-30T02:00:00.000Z'))
    await scheduler.onModuleDestroy()
  })

  it('启动之后先等一小段（1 分钟）跑第一轮，不等满一个间隔；之后按间隔（M2-P6 复核 A 的 G-4）', async () => {
    // 抖动取中间值：等待正好是 1 分钟与 1 小时，前后差 1 毫秒都看得出来
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const hour = 3_600_000
    const { scheduler, job } = setup(true, hour)
    scheduler.onModuleInit()
    await vi.advanceTimersByTimeAsync(FIRST_ROUND_DELAY_MS - 1)
    expect(job.runOnce).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(job.runOnce).toHaveBeenCalledTimes(1)
    // 第二轮按间隔
    await vi.advanceTimersByTimeAsync(hour - 1)
    expect(job.runOnce).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(job.runOnce).toHaveBeenCalledTimes(2)
    await scheduler.onModuleDestroy()
  })

  it('间隔比那一小段还短（测试用的小间隔）：第一轮也只等一个间隔', async () => {
    const { scheduler, job } = setup(true, 1_000)
    scheduler.onModuleInit()
    await vi.advanceTimersByTimeAsync(1_100)
    expect(job.runOnce).toHaveBeenCalledTimes(1)
    await scheduler.onModuleDestroy()
  })

  it('取不到时间（例如数据库连不上）：这一轮不跑，记日志，下一轮照常', async () => {
    const { scheduler, job, clock, error } = setup()
    const failure = new Error('数据库连不上')
    vi.spyOn(clock, 'now').mockRejectedValueOnce(failure)
    scheduler.onModuleInit()
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(job.runOnce).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('没有跑完'), { err: failure })
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(job.runOnce).toHaveBeenCalledTimes(1)
    await scheduler.onModuleDestroy()
  })

  it('关掉时不起定时器', async () => {
    const { scheduler, job } = setup(false)
    scheduler.onModuleInit()
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND * 5)
    expect(job.runOnce).not.toHaveBeenCalled()
    await scheduler.onModuleDestroy()
  })

  it('停止之后不再触发', async () => {
    const { scheduler, job } = setup()
    scheduler.onModuleInit()
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(job.runOnce).toHaveBeenCalledTimes(1)

    await scheduler.onModuleDestroy()
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND * 5)
    expect(job.runOnce).toHaveBeenCalledTimes(1)
  })

  it('退出时正在跑的一轮等它收尾，收尾之后不再排下一轮', async () => {
    const { scheduler, job } = setup()
    const round = deferred<TrashPurgeRound>()
    job.runOnce.mockReturnValueOnce(round.promise)
    scheduler.onModuleInit()
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(job.runOnce).toHaveBeenCalledTimes(1)

    let stopped = false
    const stopping = scheduler.onModuleDestroy().then(() => {
      stopped = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(false)

    round.resolve(ROUND)
    await stopping
    expect(stopped).toBe(true)
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND * 5)
    expect(job.runOnce).toHaveBeenCalledTimes(1)
  })

  it('一轮失败：记日志，后面几轮照常跑（定时器不因此停掉，进程也不退出）', async () => {
    const { scheduler, job, error } = setup()
    const failure = new Error('数据库连不上')
    job.runOnce.mockRejectedValueOnce(failure)
    scheduler.onModuleInit()

    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('没有跑完'), { err: failure })
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(job.runOnce).toHaveBeenCalledTimes(2)
    await scheduler.onModuleDestroy()
  })
})

describe('nextDelayMs', () => {
  it('在间隔的 ±10% 之间抖动：几个实例不会挤在同一个时刻醒来', () => {
    expect(nextDelayMs(60_000, () => 0)).toBe(54_000)
    expect(nextDelayMs(60_000, () => 0.5)).toBe(60_000)
    expect(nextDelayMs(60_000, () => 0.999)).toBe(65_988)
  })
})

describe('firstDelayMs', () => {
  it('第一轮之前等 FIRST_ROUND_DELAY_MS（1 分钟）与间隔里短的那个，同样带 ±10% 的抖动', () => {
    expect(FIRST_ROUND_DELAY_MS).toBe(60_000)
    expect(firstDelayMs(3_600_000, () => 0.5)).toBe(60_000)
    expect(firstDelayMs(86_400_000, () => 0)).toBe(54_000)
    expect(firstDelayMs(1_000, () => 0.5)).toBe(1_000)
    expect(firstDelayMs(1_000, () => 0)).toBe(900)
  })
})

describe('DatabaseClock', () => {
  it('给出数据库的当前时间，不看应用主机的时钟（M2-P6 复核 A 的疑点 Q-1）', async () => {
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    const time = { now: vi.fn(async () => new Date('2026-09-30T02:00:00.000Z')) }
    await expect(new DatabaseClock(time as unknown as DatabaseTime).now()).resolves.toEqual(new Date('2026-09-30T02:00:00.000Z'))
    expect(time.now).toHaveBeenCalledOnce()
  })
})
