// 定时器（M2-P4 设计 §3.4 第 6 条）：按间隔触发、时刻取自时钟、一轮结束才排下一轮、
// 停止之后不再触发、正在跑的一轮等它收尾、一轮失败不影响后面几轮。用假时钟与假的清理，不碰数据库。
import type { AppConfig } from '../config/index.ts'
import type { TrashPurgeJob, TrashPurgeRound } from './trash-purge.job.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { Clock, SystemClock } from './clock.ts'
import { nextDelayMs, TrashPurgeScheduler } from './trash-purge.scheduler.ts'

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

  now(): Date {
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

function setup(enabled = true) {
  const clock = new FakeClock(new Date('2026-09-30T02:00:00.000Z'))
  const job = { runOnce: vi.fn(async () => ROUND) }
  const config = { jobs: { trashPurge: { enabled, intervalMs: INTERVAL_MS, batchSize: 50 } } } as AppConfig
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

describe('SystemClock', () => {
  it('给出系统当前时间', () => {
    vi.setSystemTime(new Date('2026-09-30T02:00:00.000Z'))
    expect(new SystemClock().now()).toEqual(new Date('2026-09-30T02:00:00.000Z'))
  })
})
