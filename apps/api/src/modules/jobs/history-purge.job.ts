import type { AppConfig } from '../config/index.ts'
import type { PurgedHistory } from '../documents/index.ts'
import type { JobSchedule, ScheduledJob } from './scheduled-job.ts'
import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG } from '../config/index.ts'
import { ExclusiveRunner } from '../database/index.ts'
import { DocumentHistoryPurgeService } from '../documents/index.ts'
import { AppLogger } from '../logging/index.ts'

export const HISTORY_PURGE_LOCK = 'nerve-office:history-purge'
export type HistoryPurgeEnding = 'drained' | 'contended' | 'stopped' | 'failed'
export interface HistoryPurgeRound extends PurgedHistory {
  readonly ran: boolean
  readonly batches: number
  readonly ending: HistoryPurgeEnding
}
const NEVER_STOPPING = new AbortController().signal

/** 每批独立事务与独占锁；失去锁、退出或失败时停止本轮，不在调度器里排队。 */
@Injectable()
export class HistoryPurgeJob implements ScheduledJob {
  readonly name = 'history-purge'
  readonly title = '历史与运维检查点的保留期清理'
  readonly disabled = { variable: 'NERVE_HISTORY_PURGE_ENABLED', consequence: '到期检查点和占位暂时留着；读取和图片授权仍按期限失效，重新开启后续清' }
  readonly schedule: JobSchedule
  readonly settings: Readonly<Record<string, unknown>>
  readonly #batchSize: number
  readonly #logger: AppLogger

  constructor(
    private readonly exclusive: ExclusiveRunner,
    private readonly purge: DocumentHistoryPurgeService,
    @Inject(APP_CONFIG) config: AppConfig,
    logger: AppLogger,
  ) {
    const { enabled, intervalMs, batchSize } = config.jobs.historyPurge
    this.schedule = { enabled, intervalMs }
    this.settings = { batchSize }
    this.#batchSize = batchSize
    this.#logger = logger.with({ module: 'jobs', job: this.name })
  }

  async runOnce(now: Date, signal: AbortSignal = NEVER_STOPPING): Promise<HistoryPurgeRound> {
    let checkpoints = 0
    let buckets = 0
    let batches = 0
    const round = (ending: HistoryPurgeEnding): HistoryPurgeRound => ({ ran: batches > 0 || ending !== 'contended', checkpoints, buckets, batches, ending })
    for (;;) {
      let batch: PurgedHistory | undefined
      try {
        const outcome = await this.exclusive.runTransaction(HISTORY_PURGE_LOCK, async tx => this.purge.purgeExpired(now, this.#batchSize, tx))
        batch = outcome.ran ? outcome.result : undefined
      }
      catch (error) {
        this.#logger.error('清理一批到期检查点失败，本批已回滚，下轮继续', { checkpoints, buckets, batches, err: error })
        return round('failed')
      }
      if (batch === undefined)
        return this.finished(round('contended'))
      checkpoints += batch.checkpoints
      buckets += batch.buckets
      batches += 1
      if (batch.checkpoints < this.#batchSize && batch.buckets < this.#batchSize)
        return this.finished(round('drained'))
      if (signal.aborted)
        return this.finished(round('stopped'))
    }
  }

  private finished(result: HistoryPurgeRound): HistoryPurgeRound {
    if (result.checkpoints + result.buckets > 0)
      this.#logger.info('已清理到期检查点与小时占位', { ...result })
    else
      this.#logger.debug('本轮没有删除到期检查点与小时占位', { ...result })
    return result
  }
}
