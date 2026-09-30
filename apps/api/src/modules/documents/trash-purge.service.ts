import type { TrashEntryKind } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { PurgeOutcome } from './trash-entry-purger.ts'
import { Injectable } from '@nestjs/common'
import { TransactionRunner } from '../database/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { SpaceTreeRepository } from './space-tree.repository.ts'
import { TrashEntriesRepository } from './trash-entries.repository.ts'
import { TrashEntryPurger } from './trash-entry-purger.ts'

/**
 * 到期的一个删除单元：jobs 只按 id 与所在空间逐个清理，内容与规则都在 documents 里。
 * 不带标题：jobs 的日志与审计不经手标题与名称（M2-P6 复核 M-1）
 */
export interface ExpiredTrashEntry {
  readonly id: string
  readonly spaceId: string
  readonly kind: TrashEntryKind
  readonly expiresAt: Date
}

/**
 * 清理一个到期的删除单元的结果：真的清掉了，或者跳过了（它已经不在了，或者刚被移到别的空间）。
 * 跳过不是错误：下一轮重新取、重新判断。
 */
export type ExpiredPurgeResult
  = | { readonly purged: true, readonly outcome: PurgeOutcome }
    | { readonly purged: false, readonly reason: 'gone' | 'moved' }

/** 自动清理的审计来源：不是谁发来的请求，也不是运维在命令行里做的，是应用自己的定时任务。 */
const JOB_ORIGIN: AuditOrigin = { source: 'job' }

/**
 * 到期的删除单元的自动清理（M2-P4 设计 §3.4 第 6 条，规则见 specs/P4-S3-回收站的规则.md §4）：
 * **只给 modules/jobs 用**（eslint 的 no-restricted-imports 限定），它负责"按时触发 + 防重复执行"，
 * 删除的语义仍然在这里。
 *
 * 与人工的永久删除（TrashService.purge）的差别只有两点：不判断人的权限（操作者是系统，归档的空间照样清），
 * 以及按到期时间成批取。锁的顺序、连带删除、审计与人工的那条路径完全相同——同一个 TrashEntryPurger。
 */
@Injectable()
export class TrashPurgeService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly documents: DocumentsRepository,
    private readonly entries: TrashEntriesRepository,
    private readonly tree: SpaceTreeRepository,
    private readonly spaces: SpacesService,
    private readonly purger: TrashEntryPurger,
  ) {}

  /**
   * 到这个时刻为止已经到期的删除单元，最早到期的在前，最多 limit 条；except 里的不取（jobs 暂缓重试的那些，
   * 一直失败的条目不挡住后面到期的，M2-P6 复核 A 的 S-1）。
   * 到期与否按调用方给的时刻判断（时钟由 jobs 提供），不用数据库的 now()
   */
  async listExpired(now: Date, limit: number, except: readonly string[] = []): Promise<ExpiredTrashEntry[]> {
    const rows = await this.entries.listExpired(now, limit, except)
    return rows.map(row => ({ id: row.id, spaceId: row.spaceId, kind: row.kind, expiresAt: row.expiresAt }))
  }

  /**
   * 永久删除一个到期的删除单元，一个短事务（一轮里的其他条目各有各的事务，互不影响）。
   * 取锁的顺序与人工的永久删除相同：空间树的 advisory lock → 空间行 → 文档行 → 回收站行（ADR-007）。
   * 锁下重新读：这期间它可能被人恢复、被人永久删除（都是"已经不在"），或者随子树被移到别的空间
   * （这时手里的树锁保护不到它，留给下一轮）。审计的操作者记为系统。
   */
  async purgeExpired(entry: ExpiredTrashEntry): Promise<ExpiredPurgeResult> {
    return this.transactions.run(async (transaction) => {
      await this.tree.lock([entry.spaceId], transaction)
      await this.spaces.holdSpace(entry.spaceId, transaction)
      await this.documents.lockInEntries([entry.id], transaction)
      const locked = await this.entries.lockById(entry.id, transaction)
      if (locked === undefined)
        return { purged: false, reason: 'gone' }
      if (locked.spaceId !== entry.spaceId)
        return { purged: false, reason: 'moved' }
      return { purged: true, outcome: await this.purger.purge(locked, { type: 'system' }, JOB_ORIGIN, transaction) }
    })
  }
}
