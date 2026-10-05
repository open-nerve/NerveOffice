import type { AppConfig } from '../config/index.ts'
import type { PurgedRecords } from '../documents/index.ts'
import type { JobSchedule, ScheduledJob } from './scheduled-job.ts'
import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG } from '../config/index.ts'
import { ExclusiveRunner } from '../database/index.ts'
import { RevisionPurgeService } from '../documents/index.ts'
import { AppLogger } from '../logging/index.ts'

/** 防止多个实例同时清理的锁名（DEF-024 的多实例；单实例时它总是拿得到）：每一批的事务里取 */
export const REVISION_PURGE_LOCK = 'nerve-office:revision-purge'

/** 日志里的 job 字段 */
const JOB_NAME = 'revision-purge'

/**
 * 一轮怎样结束的：
 * - drained：删完了（最后一批修订记录与回执都不满一批）；
 * - contended：某一批拿不到锁（另一个实例正在清理），余下的留给它；
 * - stopped：应用正在退出，做完手上这一批就停，余下的留给下一轮；
 * - failed：一批失败（这一批回滚），这一轮到此为止，余下的留给下一轮
 */
export type RevisionPurgeEnding = 'drained' | 'contended' | 'stopped' | 'failed'

/** 一轮的结果 */
export interface RevisionPurgeRound {
  /** false：第一批就拿不到锁，这一轮什么都没做 */
  readonly ran: boolean
  /** 删了几条修订记录 */
  readonly revisions: number
  /** 删了几条回执 */
  readonly receipts: number
  /** 提交了几批（每批一个短事务） */
  readonly batches: number
  readonly ending: RevisionPurgeEnding
}

/** 不会被中止的 signal：直接调用 runOnce（集成测试）时的默认 */
const NEVER_STOPPING = new AbortController().signal

/**
 * 修订记录与回执的保留期清理（M3-P3 设计 §3.9）：**一轮**做什么。什么时候跑由 JobScheduler 决定，什么算过期在 documents 里
 * （RevisionPurgeService：早于保留期、而且不是当前修订的修订记录，早于保留期的回执），这里只有编排：
 *
 * 1. 分批：每批是一个短事务，删至多一批的修订记录与至多一批的回执；一轮删到修订记录与回执都不满一批为止。自动保存每 2–15 秒写一版，
 *    一轮只删一批（像回收站那样）跟不上，所以一轮之内分批删完；每批之间不占着连接，也不长时间持锁；
 * 2. 防重复执行：每一批的事务里先取事务级的 advisory lock（ExclusiveRunner.runTransaction），拿不到就停下这一轮——另一个实例正在清理，
 *    余下的留给它。不像回收站的清理那样整轮持一把会话级的锁：这里的一批本身就是一个事务，事务级的锁正好盖住它，任何时刻只占一个连接、
 *    从不拿着一个连接去等另一个，连接池的下限因此不变（config.ts 的 TRASH_PURGE_MIN_POOL）。多实例时几个实例可能轮流删几批，
 *    这不影响结果：删的条件只看数据本身（过期、不是当前修订），被别人锁着的行跳过，删两遍也只是删不到；
 * 3. 退出：signal 中止之后，做完手上这一批就停（不在事务中途丢下连接，也不必等完一整轮）；
 * 4. 一批失败（数据库繁忙、语句超时）：这一批回滚，记日志、这一轮到此为止，下一轮再来；不抛给调度器。
 *    删的条件不针对哪一行，一批失败多半是数据库的问题，不像回收站那样有"一直失败的条目"要暂缓。
 */
@Injectable()
export class RevisionPurgeJob implements ScheduledJob {
  readonly name = JOB_NAME
  readonly title = '修订记录与回执的保留期清理'
  readonly schedule: JobSchedule
  readonly disabled = { variable: 'NERVE_REVISION_PURGE_ENABLED', consequence: '过了保留期的修订记录与回执留着（不影响使用），重新打开之后下一轮一起清' }
  readonly settings: Readonly<Record<string, unknown>>
  readonly #logger: AppLogger
  readonly #batchSize: number

  constructor(
    private readonly exclusive: ExclusiveRunner,
    private readonly purge: RevisionPurgeService,
    @Inject(APP_CONFIG) config: AppConfig,
    logger: AppLogger,
  ) {
    const { enabled, intervalMs, batchSize } = config.jobs.revisionPurge
    this.schedule = { enabled, intervalMs }
    this.settings = { batchSize, retentionDays: config.revisions.retentionDays }
    this.#logger = logger.with({ module: 'jobs', job: JOB_NAME })
    this.#batchSize = batchSize
  }

  /**
   * 跑一轮：删掉到 now 为止过了保留期的修订记录与回执（now 由调用方从时钟取，测试因此能把时间推到 30 天之后）。
   * signal 中止之后做完手上这一批就停（JobScheduler 在应用退出时中止它）
   */
  async runOnce(now: Date, signal: AbortSignal = NEVER_STOPPING): Promise<RevisionPurgeRound> {
    let revisions = 0
    let receipts = 0
    let batches = 0
    const round = (ending: RevisionPurgeEnding): RevisionPurgeRound => ({ ran: batches > 0 || ending !== 'contended', revisions, receipts, batches, ending })
    for (;;) {
      let batch: PurgedRecords | undefined
      try {
        const outcome = await this.exclusive.runTransaction(REVISION_PURGE_LOCK, async transaction => this.purge.purgeExpired(now, this.#batchSize, transaction))
        batch = outcome.ran ? outcome.result : undefined
      }
      catch (error) {
        this.#logger.error('删一批过了保留期的修订记录与回执时失败，这一批回滚，这一轮到此为止，下一轮再来', { revisions, receipts, batches, err: error })
        return round('failed')
      }
      if (batch === undefined)
        return this.#finished(round('contended'))
      batches += 1
      revisions += batch.revisions
      receipts += batch.receipts
      // 两样都不满一批：删完了。满了的那一样可能还有，接着删下一批
      if (batch.revisions < this.#batchSize && batch.receipts < this.#batchSize)
        return this.#finished(round('drained'))
      if (signal.aborted)
        return this.#finished(round('stopped'))
    }
  }

  /** 一轮一条日志：删了东西记 info（每样删了几条、几批、怎样结束的），别的记 debug */
  #finished(result: RevisionPurgeRound): RevisionPurgeRound {
    const fields = { revisions: result.revisions, receipts: result.receipts, batches: result.batches, ending: result.ending }
    if (!result.ran)
      this.#logger.debug('这一轮跳过：另一个实例正在清理修订记录与回执')
    else if (result.revisions + result.receipts > 0)
      this.#logger.info('删掉了过了保留期的修订记录与回执', fields)
    else
      this.#logger.debug('没有过了保留期的修订记录与回执', fields)
    return result
  }
}
