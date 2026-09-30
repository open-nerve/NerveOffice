import type { AppConfig } from '../config/index.ts'
import type { ExpiredTrashEntry } from '../documents/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG } from '../config/index.ts'
import { ExclusiveRunner } from '../database/index.ts'
import { TrashPurgeService } from '../documents/index.ts'
import { AppLogger } from '../logging/index.ts'

/** 防止多个实例同时清理的锁名（DEF-024 的多实例；单实例时它总是拿得到）。 */
export const TRASH_PURGE_LOCK = 'nerve-office:trash-purge'

/** 一轮清理的结果。`ran` 为 false 说明锁在别处，这一轮什么都没做。 */
export interface TrashPurgeRound {
  readonly ran: boolean
  /** 真的永久删除了几个删除单元 */
  readonly purged: number
  /** 跳过了几个（锁下重新读时已经不在，或者刚被移到别的空间，留给下一轮） */
  readonly skipped: number
  /** 失败了几个（只记日志，不影响这一轮的其他条目） */
  readonly failed: number
}

const EMPTY_ROUND = { purged: 0, skipped: 0, failed: 0 } as const

/**
 * 回收站里到期的删除单元的清理（M2-P4 设计 §3.4 第 6 条）：**一轮**做什么。
 * 什么时候跑由 TrashPurgeScheduler 决定，删除的语义在 documents 里（TrashPurgeService），这里只有编排：
 *
 * 1. 先取会话级的 advisory lock，拿不到就跳过这一轮（将来多实例时，同一时刻只有一个实例在清理）；
 * 2. 按到期时间取一批（默认 50 个），**逐个在各自的短事务里**永久删除；
 * 3. 单个失败只记日志，不影响这一轮的其他条目，也不让定时器与进程出问题。
 */
@Injectable()
export class TrashPurgeJob {
  readonly #logger: AppLogger
  readonly #batchSize: number

  constructor(
    private readonly exclusive: ExclusiveRunner,
    private readonly trash: TrashPurgeService,
    @Inject(APP_CONFIG) config: AppConfig,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'jobs', job: 'trash-purge' })
    this.#batchSize = config.jobs.trashPurge.batchSize
  }

  /** 跑一轮：清理到 now 为止已经到期的删除单元（now 由调用方从时钟取，测试因此能把时间推到 30 天之后）。 */
  async runOnce(now: Date): Promise<TrashPurgeRound> {
    const outcome = await this.exclusive.run(TRASH_PURGE_LOCK, async () => this.#purgeBatch(now))
    if (!outcome.ran) {
      this.#logger.debug('这一轮跳过：另一个实例正在清理回收站')
      return { ran: false, ...EMPTY_ROUND }
    }
    return { ran: true, ...outcome.result }
  }

  async #purgeBatch(now: Date): Promise<Omit<TrashPurgeRound, 'ran'>> {
    const expired = await this.trash.listExpired(now, this.#batchSize)
    if (expired.length === 0) {
      this.#logger.debug('回收站里没有到期的东西')
      return EMPTY_ROUND
    }
    let purged = 0
    let skipped = 0
    let failed = 0
    for (const entry of expired) {
      // 逐个来：前一个的失败不影响后面的，整批也不放进同一个事务里（各自的短事务，锁不长时间占着一个空间）
      const result = await this.#purgeOne(entry)
      if (result === 'failed')
        failed += 1
      else if (result === 'purged')
        purged += 1
      else
        skipped += 1
    }
    this.#logger.info('清理了回收站里到期的东西', { expired: expired.length, purged, skipped, failed })
    return { purged, skipped, failed }
  }

  async #purgeOne(entry: ExpiredTrashEntry): Promise<'purged' | 'skipped' | 'failed'> {
    const fields = { trashEntryId: entry.id, spaceId: entry.spaceId, kind: entry.kind }
    try {
      const result = await this.trash.purgeExpired(entry)
      if (!result.purged) {
        this.#logger.debug('跳过一个到期的删除单元，留给下一轮', { ...fields, reason: result.reason })
        return 'skipped'
      }
      this.#logger.debug('永久删除了一个到期的删除单元', { ...fields, folders: result.outcome.folders, documents: result.outcome.documents })
      return 'purged'
    }
    catch (error) {
      // 单个失败不影响这一轮的其他条目；它的到期时间不变，下一轮会再试
      this.#logger.error('清理一个到期的删除单元失败，这一轮的其他条目照常清理', { ...fields, err: error })
      return 'failed'
    }
  }
}
