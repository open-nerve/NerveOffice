import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import type { AppConfig } from '../config/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG } from '../config/index.ts'
import { AppLogger } from '../logging/index.ts'
import { Clock } from './clock.ts'
import { TrashPurgeJob } from './trash-purge.job.ts'

/** 抖动的幅度：实际的等待在间隔的 ±10% 之间，几个实例不会挤在同一个时刻醒来。 */
const JITTER_RATIO = 0.1

/** 下一轮之前等多久：间隔上下浮动 JITTER_RATIO。random 是 [0, 1) 的随机数（测试里给定值）。 */
export function nextDelayMs(intervalMs: number, random: () => number): number {
  const jitter = intervalMs * JITTER_RATIO
  return Math.max(0, Math.round(intervalMs - jitter + random() * 2 * jitter))
}

/**
 * 按时触发回收站的清理（M2-P4 设计 §3.4 第 6 条）：不引入调度框架，用模块自己的定时器，
 * 应用启动（OnModuleInit）时起、退出（OnModuleDestroy）时停。一轮跑完再排下一轮，所以慢的一轮不会叠在一起。
 *
 * 退出：先不再排下一轮，再等正在跑的那一轮结束。一轮里的每一项都是短事务（语句与锁都有超时），
 * 所以这个等待是有界的，不会把关闭卡住。定时器 unref，等着的定时器也不会把进程留住。
 */
@Injectable()
export class TrashPurgeScheduler implements OnModuleInit, OnModuleDestroy {
  readonly #logger: AppLogger
  readonly #settings: AppConfig['jobs']['trashPurge']
  #timer: NodeJS.Timeout | undefined
  /** 正在跑的那一轮；退出时等它结束 */
  #running: Promise<void> | undefined
  #stopped = false

  constructor(
    private readonly job: TrashPurgeJob,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) config: AppConfig,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'jobs', job: 'trash-purge' })
    this.#settings = config.jobs.trashPurge
  }

  onModuleInit(): void {
    if (!this.#settings.enabled) {
      this.#logger.info('回收站的自动清理已关闭（NERVE_TRASH_PURGE_ENABLED=false）：到期的东西要人工永久删除')
      return
    }
    this.#logger.info('回收站的自动清理已启动', { intervalMs: this.#settings.intervalMs, batchSize: this.#settings.batchSize })
    this.#schedule()
  }

  async onModuleDestroy(): Promise<void> {
    this.#stopped = true
    if (this.#timer !== undefined)
      clearTimeout(this.#timer)
    this.#timer = undefined
    // 正在跑的一轮跑完再退出：不在事务中途丢下连接
    await this.#running
  }

  /** 排下一轮（带抖动）。已经停下就不再排 */
  #schedule(): void {
    if (this.#stopped)
      return
    this.#timer = setTimeout(() => {
      void this.#tick()
    }, nextDelayMs(this.#settings.intervalMs, Math.random))
    // 等着的定时器不该把进程留住：该退出时就退出
    this.#timer.unref()
  }

  async #tick(): Promise<void> {
    this.#timer = undefined
    this.#running = this.#runOnce()
    try {
      await this.#running
    }
    finally {
      this.#running = undefined
      // 一轮结束之后才排下一轮：一轮跑得比间隔还久时也不会叠起来
      this.#schedule()
    }
  }

  /** 一轮：失败只记日志——定时器要继续，进程更不能因此退出 */
  async #runOnce(): Promise<void> {
    try {
      await this.job.runOnce(this.clock.now())
    }
    catch (error) {
      this.#logger.error('这一轮回收站清理没有跑完', { err: error })
    }
  }
}
