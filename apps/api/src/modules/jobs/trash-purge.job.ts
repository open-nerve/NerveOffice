import type { AppConfig } from '../config/index.ts'
import type { ExpiredTrashEntry } from '../documents/index.ts'
import type { JobSchedule, ScheduledJob } from './scheduled-job.ts'
import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG } from '../config/index.ts'
import { ExclusiveRunner } from '../database/index.ts'
import { TrashPurgeService } from '../documents/index.ts'
import { AppLogger } from '../logging/index.ts'

/** 防止多个实例同时清理的锁名（DEF-024 的多实例；单实例时它总是拿得到）。 */
export const TRASH_PURGE_LOCK = 'nerve-office:trash-purge'

/** 日志里的 job 字段 */
const JOB_NAME = 'trash-purge'

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

/** 失败过的条目最多暂缓多久再试：大约一天（按两轮之间的间隔折算成轮数） */
const MAX_RETRY_DEFERRAL_MS = 86_400_000

/** 一个一直失败的删除单元：连续失败了几次、暂缓到第几轮（这一轮及之前取批时让开它） */
interface FailingEntry {
  readonly failures: number
  readonly deferredThroughRound: number
}

/**
 * 回收站里到期的删除单元的清理（M2-P4 设计 §3.4 第 6 条）：**一轮**做什么。
 * 什么时候跑由 JobScheduler 决定，删除的语义在 documents 里（TrashPurgeService），这里只有编排：
 *
 * 1. 先取会话级的 advisory lock，拿不到就跳过这一轮（将来多实例时，同一时刻只有一个实例在清理）：一轮的各项在各自的短事务里，
 *    锁要跨这些事务一直持有（ExclusiveRunner.run）。一轮至多一批（默认 50 项），退出时不中途停下，等这一批做完；
 * 2. 按到期时间取一批（默认 50 个），**逐个在各自的短事务里**永久删除；
 * 3. 单个失败只记日志，不影响这一轮的其他条目，也不让定时器与进程出问题；
 * 4. 失败过的条目暂缓重试（M2-P6 复核 A 的 S-1、B 的 G2）：一直失败的条目到期最早，每一批都从它们取起，
 *    攒够一批之后后面到期的就再也轮不到，整个实例的自动清理等于停了。所以本进程记下失败过的条目，之后的几轮取批时让开它们：
 *    连续失败 n 次就让开 2^(n-1) 轮，最多约一天（MAX_RETRY_DEFERRAL_MS）；成功或跳过就忘掉。
 *    日志带着连续失败的次数（consecutiveFailures），将来据此告警（M7）。只记在内存里：重启之后重新试一次，可以接受。
 */
@Injectable()
export class TrashPurgeJob implements ScheduledJob {
  readonly name = JOB_NAME
  readonly title = '回收站的自动清理'
  readonly schedule: JobSchedule
  readonly disabled = { variable: 'NERVE_TRASH_PURGE_ENABLED', consequence: '到期的东西要人工永久删除' }
  readonly settings: Readonly<Record<string, unknown>>
  readonly #logger: AppLogger
  readonly #batchSize: number
  /** 暂缓最多几轮：约一天，至少一轮 */
  readonly #maxDeferredRounds: number
  /** 失败过、还记着的条目（按删除单元 id） */
  readonly #failing = new Map<string, FailingEntry>()
  /** 本进程真正跑过的轮数（拿不到锁的那些轮不算）：暂缓按它计 */
  #round = 0

  constructor(
    private readonly exclusive: ExclusiveRunner,
    private readonly trash: TrashPurgeService,
    @Inject(APP_CONFIG) config: AppConfig,
    logger: AppLogger,
  ) {
    const { enabled, intervalMs, batchSize } = config.jobs.trashPurge
    this.schedule = { enabled, intervalMs }
    this.settings = { batchSize }
    this.#logger = logger.with({ module: 'jobs', job: JOB_NAME })
    this.#batchSize = batchSize
    this.#maxDeferredRounds = Math.max(1, Math.floor(MAX_RETRY_DEFERRAL_MS / intervalMs))
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
    this.#round += 1
    const deferred = [...this.#failing].flatMap(([id, failing]) => failing.deferredThroughRound >= this.#round ? [id] : [])
    const expired = await this.trash.listExpired(now, this.#batchSize, deferred)
    this.#forgetGone(expired, deferred)
    if (expired.length === 0) {
      this.#logger.debug('回收站里没有要清理的到期条目', { deferred: deferred.length })
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
    this.#logger.info('清理了回收站里到期的东西', { expired: expired.length, purged, skipped, failed, deferred: deferred.length })
    return { purged, skipped, failed }
  }

  async #purgeOne(entry: ExpiredTrashEntry): Promise<'purged' | 'skipped' | 'failed'> {
    const fields = { trashEntryId: entry.id, spaceId: entry.spaceId, kind: entry.kind }
    try {
      const result = await this.trash.purgeExpired(entry)
      // 不是失败（清掉了，或者锁下看到它已经不在、刚被移走）：连续失败的记录到此为止
      this.#failing.delete(entry.id)
      if (!result.purged) {
        this.#logger.debug('跳过一个到期的删除单元，留给下一轮', { ...fields, reason: result.reason })
        return 'skipped'
      }
      this.#logger.debug('永久删除了一个到期的删除单元', { ...fields, folders: result.outcome.folders, documents: result.outcome.documents })
      return 'purged'
    }
    catch (error) {
      // 单个失败不影响这一轮的其他条目；它的到期时间不变，暂缓几轮之后再试
      const { failures, deferredRounds } = this.#deferAfterFailure(entry.id)
      this.#logger.error('清理一个到期的删除单元失败，这一轮的其他条目照常清理', { ...fields, consecutiveFailures: failures, deferredRounds, err: error })
      return 'failed'
    }
  }

  /** 又失败了一次：连续失败 n 次就让开之后的 2^(n-1) 轮，最多 #maxDeferredRounds 轮。 */
  #deferAfterFailure(id: string): { readonly failures: number, readonly deferredRounds: number } {
    const failures = (this.#failing.get(id)?.failures ?? 0) + 1
    const deferredRounds = Math.min(2 ** (failures - 1), this.#maxDeferredRounds)
    this.#failing.set(id, { failures, deferredThroughRound: this.#round + deferredRounds })
    return { failures, deferredRounds }
  }

  /**
   * 忘掉已经不在回收站里的条目（被人恢复或永久删除了）：这一批没有取满，说明到期的、没有让开的条目全在里面了——
   * 不再让开、却没有出现在这一批里的，就不再是到期的删除单元。取满时判断不了，留着等下一轮。记着的条目因此不会越攒越多
   */
  #forgetGone(expired: readonly ExpiredTrashEntry[], deferred: readonly string[]): void {
    if (expired.length >= this.#batchSize)
      return
    const listed = new Set(expired.map(entry => entry.id))
    const stillDeferred = new Set(deferred)
    for (const id of [...this.#failing.keys()]) {
      if (!listed.has(id) && !stillDeferred.has(id))
        this.#failing.delete(id)
    }
  }
}
