// 定时任务的调度（M2-P4 设计 §3.4 第 6 条，M3-P3 设计 §3.9）：启动之后先等一小段跑第一轮、之后按间隔触发、时刻取自时钟、一轮结束才排下一轮、
// 停止之后不再触发、正在跑的一轮等它收尾（退出时中止 signal，分批的任务据此停下）、一轮失败不影响后面几轮；几个任务各自的开关与间隔，互不影响。
// 用假时钟与假的任务，不碰数据库。
import type { DatabaseTime } from '../database/index.ts'
import type { JobSchedule, ScheduledJob } from './scheduled-job.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { Clock, DatabaseClock } from './clock.ts'
import { FIRST_ROUND_DELAY_MS, firstDelayMs, JobScheduler, nextDelayMs } from './job-scheduler.ts'

const INTERVAL_MS = 60_000
/** 一定跨过一轮的等待（间隔的 ±10%） */
const PAST_ONE_ROUND = INTERVAL_MS * 1.2

/** 可控的时钟：测试把它往前推，任务看到的"现在"就变了 */
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

/** 假的任务：runOnce 记下每次的时刻与 signal */
function fakeJob(name: string, schedule: Partial<JobSchedule> = {}) {
  const runOnce = vi.fn(async (_now: Date, _signal: AbortSignal): Promise<unknown> => undefined)
  const job: ScheduledJob = {
    name,
    title: `${name} 的清理`,
    schedule: { enabled: true, intervalMs: INTERVAL_MS, ...schedule },
    disabled: { variable: `NERVE_${name.toUpperCase().replaceAll('-', '_')}_ENABLED`, consequence: '留着不清' },
    settings: { batchSize: 50 },
    runOnce,
  }
  return { job, runOnce }
}

function setup(jobs: readonly ScheduledJob[]) {
  const clock = new FakeClock(new Date('2026-09-30T02:00:00.000Z'))
  const info = vi.spyOn(AppLogger.prototype, 'info')
  const error = vi.spyOn(AppLogger.prototype, 'error')
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  return { clock, info, error, scheduler: new JobScheduler(jobs, clock, logger) }
}

function single(schedule: Partial<JobSchedule> = {}) {
  const { job, runOnce } = fakeJob('trash-purge', schedule)
  return { ...setup([job]), runOnce }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('JobScheduler：一个任务', () => {
  it('启动之后按间隔跑，每一轮的时刻取自时钟（不是本机的时钟）；一轮结束才排下一轮', async () => {
    // 本机的钟与时钟差得很远：拿错了一眼看得出来
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    const { scheduler, runOnce, clock } = single()
    scheduler.onModuleInit()
    expect(runOnce).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(runOnce).toHaveBeenCalledOnce()
    expect(runOnce.mock.calls[0]?.[0]).toEqual(new Date('2026-09-30T02:00:00.000Z'))

    // 时钟往前推 30 天：下一轮拿到的是新的"现在"，到期的判断因此不必真的等
    clock.advanceDays(30)
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(runOnce).toHaveBeenCalledTimes(2)
    expect(runOnce.mock.calls[1]?.[0]).toEqual(new Date('2026-10-30T02:00:00.000Z'))
    await scheduler.onModuleDestroy()
  })

  it('启动之后先等一小段（1 分钟）跑第一轮，不等满一个间隔；之后按间隔（M2-P6 复核 A 的 G-4）', async () => {
    // 抖动取中间值：等待正好是 1 分钟与 1 小时，前后差 1 毫秒都看得出来
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const hour = 3_600_000
    const { scheduler, runOnce } = single({ intervalMs: hour })
    scheduler.onModuleInit()
    await vi.advanceTimersByTimeAsync(FIRST_ROUND_DELAY_MS - 1)
    expect(runOnce).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(runOnce).toHaveBeenCalledTimes(1)
    // 第二轮按间隔
    await vi.advanceTimersByTimeAsync(hour - 1)
    expect(runOnce).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runOnce).toHaveBeenCalledTimes(2)
    await scheduler.onModuleDestroy()
  })

  it('间隔比那一小段还短（测试用的小间隔）：第一轮也只等一个间隔', async () => {
    const { scheduler, runOnce } = single({ intervalMs: 1_000 })
    scheduler.onModuleInit()
    await vi.advanceTimersByTimeAsync(1_100)
    expect(runOnce).toHaveBeenCalledTimes(1)
    await scheduler.onModuleDestroy()
  })

  it('启动的日志带着间隔、任务自己的设置与第一轮的等待；关掉时说明是哪个变量、关掉期间会怎样', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { scheduler, info } = single()
    scheduler.onModuleInit()
    expect(info).toHaveBeenCalledExactlyOnceWith('trash-purge 的清理已启动', { intervalMs: INTERVAL_MS, batchSize: 50, firstDelayMs: INTERVAL_MS })
    await scheduler.onModuleDestroy()

    const disabled = single({ enabled: false })
    disabled.scheduler.onModuleInit()
    expect(disabled.info).toHaveBeenLastCalledWith('trash-purge 的清理已关闭（NERVE_TRASH_PURGE_ENABLED=false）：留着不清')
    await disabled.scheduler.onModuleDestroy()
  })

  it('取不到时间（例如数据库连不上）：这一轮不跑，记日志，下一轮照常', async () => {
    const { scheduler, runOnce, clock, error } = single()
    const failure = new Error('数据库连不上')
    vi.spyOn(clock, 'now').mockRejectedValueOnce(failure)
    scheduler.onModuleInit()
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(runOnce).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('没有跑完'), { err: failure })
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(runOnce).toHaveBeenCalledTimes(1)
    await scheduler.onModuleDestroy()
  })

  it('关掉时不起定时器', async () => {
    const { scheduler, runOnce } = single({ enabled: false })
    scheduler.onModuleInit()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND * 5)
    expect(runOnce).not.toHaveBeenCalled()
    await scheduler.onModuleDestroy()
  })

  it('第一轮还没触发就退出：第一轮的定时器也清掉，之后不再触发（M2-P6 第 3 片复验）', async () => {
    const { scheduler, runOnce } = single()
    scheduler.onModuleInit()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS / 2)
    expect(runOnce).not.toHaveBeenCalled()
    await scheduler.onModuleDestroy()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND * 5)
    expect(runOnce).not.toHaveBeenCalled()
  })

  it('停止之后不再触发', async () => {
    const { scheduler, runOnce } = single()
    scheduler.onModuleInit()
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(runOnce).toHaveBeenCalledTimes(1)

    await scheduler.onModuleDestroy()
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND * 5)
    expect(runOnce).toHaveBeenCalledTimes(1)
  })

  it('退出时：先中止交给这一轮的 signal（分批的任务据此在批与批之间停下），再等这一轮收尾，收尾之后不再排下一轮', async () => {
    const { scheduler, runOnce } = single()
    const round = deferred<undefined>()
    runOnce.mockReturnValueOnce(round.promise)
    scheduler.onModuleInit()
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(runOnce).toHaveBeenCalledTimes(1)
    const signal = runOnce.mock.calls[0]?.[1]
    expect(signal?.aborted).toBe(false)

    let stopped = false
    const stopping = scheduler.onModuleDestroy().then(() => {
      stopped = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(signal?.aborted).toBe(true)
    expect(stopped).toBe(false)

    round.resolve(undefined)
    await stopping
    expect(stopped).toBe(true)
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND * 5)
    expect(runOnce).toHaveBeenCalledTimes(1)
  })

  it('一轮失败：记日志，后面几轮照常跑（定时器不因此停掉，进程也不退出）', async () => {
    const { scheduler, runOnce, error } = single()
    const failure = new Error('数据库连不上')
    runOnce.mockRejectedValueOnce(failure)
    scheduler.onModuleInit()

    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(error).toHaveBeenCalledExactlyOnceWith('这一轮trash-purge 的清理没有跑完', { err: failure })
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)
    expect(runOnce).toHaveBeenCalledTimes(2)
    await scheduler.onModuleDestroy()
  })
})

describe('JobScheduler：几个任务（回收站的清理与修订记录、回执的保留期清理共用一个调度器）', () => {
  it('各自的间隔各自排：一个任务的一轮还没跑完，另一个照常按自己的间隔跑', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const slow = fakeJob('trash-purge', { intervalMs: 10_000 })
    const fast = fakeJob('revision-purge', { intervalMs: 4_000 })
    const blocked = deferred<undefined>()
    slow.runOnce.mockReturnValueOnce(blocked.promise)
    const { scheduler } = setup([slow.job, fast.job])
    scheduler.onModuleInit()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(slow.runOnce).toHaveBeenCalledTimes(1)
    // 快的那个在 4、8 秒各跑了一轮；慢的那一轮还没结束，不耽误它
    expect(fast.runOnce).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(fast.runOnce).toHaveBeenCalledTimes(3)
    expect(slow.runOnce).toHaveBeenCalledTimes(1)

    blocked.resolve(undefined)
    await scheduler.onModuleDestroy()
  })

  it('只关掉其中一个：另一个照常跑；日志带着各自的 job 字段', async () => {
    const off = fakeJob('trash-purge', { enabled: false })
    const on = fakeJob('revision-purge')
    const withBindings = vi.spyOn(AppLogger.prototype, 'with')
    const { scheduler, info } = setup([off.job, on.job])
    expect(withBindings.mock.calls.map(([bindings]) => bindings)).toEqual([{ module: 'jobs', job: 'trash-purge' }, { module: 'jobs', job: 'revision-purge' }])
    scheduler.onModuleInit()
    expect(info.mock.calls.map(([message]) => message)).toEqual(['trash-purge 的清理已关闭（NERVE_TRASH_PURGE_ENABLED=false）：留着不清', 'revision-purge 的清理已启动'])

    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND * 3)
    expect(off.runOnce).not.toHaveBeenCalled()
    expect(on.runOnce).toHaveBeenCalledTimes(3)
    await scheduler.onModuleDestroy()
  })

  it('一个任务的一轮失败不影响另一个', async () => {
    const failing = fakeJob('trash-purge')
    const healthy = fakeJob('revision-purge')
    failing.runOnce.mockRejectedValue(new Error('坏了'))
    const { scheduler, error } = setup([failing.job, healthy.job])
    scheduler.onModuleInit()
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND * 2)
    expect(failing.runOnce).toHaveBeenCalledTimes(2)
    expect(healthy.runOnce).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledTimes(2)
    await scheduler.onModuleDestroy()
  })

  it('退出时等每一个正在跑的一轮都收尾；交给它们的是同一个已经中止的 signal', async () => {
    const first = fakeJob('trash-purge')
    const second = fakeJob('revision-purge')
    const rounds = [deferred<undefined>(), deferred<undefined>()] as const
    first.runOnce.mockReturnValueOnce(rounds[0].promise)
    second.runOnce.mockReturnValueOnce(rounds[1].promise)
    const { scheduler } = setup([first.job, second.job])
    scheduler.onModuleInit()
    await vi.advanceTimersByTimeAsync(PAST_ONE_ROUND)

    let stopped = false
    const stopping = scheduler.onModuleDestroy().then(() => {
      stopped = true
    })
    expect(first.runOnce.mock.calls[0]?.[1].aborted).toBe(true)
    expect(second.runOnce.mock.calls[0]?.[1].aborted).toBe(true)
    rounds[0].resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(false)
    rounds[1].resolve(undefined)
    await stopping
    expect(stopped).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
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
