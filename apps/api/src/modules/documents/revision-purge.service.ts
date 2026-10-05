import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG } from '../config/index.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { DocumentSaveReceiptsRepository } from './document-save-receipts.repository.ts'

/** 一批删掉了多少：修订记录与回执各几条（各自至多一批的数量） */
export interface PurgedRecords {
  readonly revisions: number
  readonly receipts: number
}

/**
 * 修订记录与保存回执的保留期清理（M3-P3 设计 §3.9）：**只给 modules/jobs 用**（eslint 的 no-restricted-imports 限定）。
 * jobs 决定什么时候跑、防重复执行与分批（RevisionPurgeJob）；什么算过期在这里，保留的天数来自配置（NERVE_REVISION_RETENTION_DAYS）：
 * - 修订记录：早于保留期、**而且不是文档的当前修订**——当前修订那一行一直留着：修订号冲突的来源（"自己追自己"）、申请编辑权的来源
 *   （续上时认出本页那次结果未知的保存）与"内容相同不递增"给出的保存时间都读它；
 * - 回执：早于保留期。
 * 删掉之后，那次保存、新建、复制、另存为副本的 requestId 不再有记录：同一个请求的重试不再是重放，按一次新的请求处理。所以保留期就是
 * 这些写入的幂等窗口（下限 15 天，长于 M4 发件箱的 14 天，见 config.ts）。当前修订那一行的重放不受影响（那一行还在）。
 * 与并发的保存不需要锁（修订号只增不减，见 DocumentRevisionsRepository.deleteExpired）；不记审计：删的是请求的记录，不是文档的内容
 */
@Injectable()
export class RevisionPurgeService {
  readonly #retentionDays: number

  constructor(
    private readonly revisions: DocumentRevisionsRepository,
    private readonly receipts: DocumentSaveReceiptsRepository,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.#retentionDays = config.revisions.retentionDays
  }

  /**
   * 删一批：至多 limit 条修订记录、至多 limit 条回执，都在调用方的事务里（jobs 在这个事务里持着防重复执行的事务级锁）。
   * now 是这一轮的"现在"（jobs 的时钟，生产里是数据库的时间）；早于 now 减保留天数的算过期，换算在 SQL 里
   */
  async purgeExpired(now: Date, limit: number, transaction: Transaction): Promise<PurgedRecords> {
    const revisions = await this.revisions.deleteExpired(now, this.#retentionDays, limit, transaction)
    const receipts = await this.receipts.deleteExpired(now, this.#retentionDays, limit, transaction)
    return { revisions, receipts }
  }
}
