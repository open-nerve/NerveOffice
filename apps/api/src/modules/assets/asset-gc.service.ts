import type { AppConfig } from '../config/index.ts'
import type { AssetGcObjectRow } from './asset-gc.repository.ts'
import type { AssetGcAssetPage, AssetGcObjectKind, AssetGcObjectPage, AssetGcPage, AssetRetentionProbe } from './asset-gc.ts'
import { Inject, Injectable } from '@nestjs/common'
import { AuditService } from '../audit/index.ts'
import { APP_CONFIG } from '../config/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { AssetGcClock } from './asset-gc-clock.ts'
import { assetGcPolicy, canRetire } from './asset-gc-policy.ts'
import { AssetGcRepository } from './asset-gc.repository.ts'

/** Assets 只消费保留判定端口，不依赖文档域或将授权条件误当成保留条件。 */
@Injectable()
export class AssetGcService {
  constructor(
    private readonly repository: AssetGcRepository,
    private readonly transactions: TransactionRunner,
    private readonly clock: AssetGcClock,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 仅供调度结果说明，不是后续删除的授权；每批和文件 IO 之前仍独立核对。 */
  async policyState(): Promise<AssetGcAssetPage['policy']> {
    return this.transactions.readSnapshot(async tx => assetGcPolicy(this.config.jobs.assetGc, await this.clock.now(tx)).state)
  }

  async assetUpperBound(): Promise<string | undefined> {
    return this.transactions.readSnapshot(async tx => this.repository.assetUpperBound(tx))
  }

  async scanAssets(probe: AssetRetentionProbe, page: AssetGcPage): Promise<AssetGcAssetPage> {
    this.validatePage(page)
    return this.transactions.run(async (tx) => {
      const rows = await this.repository.lockAssets(page, tx)
      const last = rows.at(-1)
      if (last === undefined)
        return { scanned: 0, marked: 0, reset: 0, removed: 0, policy: assetGcPolicy(this.config.jobs.assetGc, await this.clock.now(tx)).state }
      const ids = rows.map(row => row.id)
      const retained = await probe.retained(ids, tx)
      const active = await this.repository.activeAssets(ids, tx)
      // 移除引用不必锁资产；必须等保留查询完成后取时刻，不能把宽限起点回溯到仍有引用时。
      const at = await this.clock.now(tx)
      const recent = await this.repository.recentAssets(ids, at, tx)
      const policy = assetGcPolicy(this.config.jobs.assetGc, at)
      const marked: string[] = []
      const reset: string[] = []
      const removed: string[] = []
      for (const row of rows) {
        if (retained.has(row.id) || recent.has(row.id)) {
          if (row.unreferencedAt !== null)
            reset.push(row.id)
        }
        else if (row.unreferencedAt === null || active.has(row.id)) {
          marked.push(row.id)
        }
        else if (canRetire(row.unreferencedAt, policy)) {
          removed.push(row.id)
        }
      }
      await this.repository.updateCandidates(marked, reset, at, tx)
      await this.repository.consumeActivity(ids, tx)
      await this.repository.removeAssets(removed, tx)
      if (removed.length > 0) {
        await this.audit.record({ action: 'assets.records_collected', actor: { type: 'system' }, origin: { source: 'job' }, details: { count: removed.length } }, { transaction: tx })
      }
      return { scanned: rows.length, marked: marked.length, reset: reset.length, removed: removed.length, policy: policy.state, lastId: last.id }
    })
  }

  async objectUpperBound(kind: AssetGcObjectKind): Promise<string | undefined> {
    return this.transactions.readSnapshot(async tx => this.repository.objectUpperBound(kind, tx))
  }

  async scanObjects(kind: AssetGcObjectKind, page: AssetGcPage): Promise<AssetGcObjectPage> {
    this.validatePage(page)
    return this.transactions.run(async (tx) => {
      const rows = await this.repository.lockObjects(kind, page, tx)
      const last = rows.at(-1)
      const retained = kind === 'object' ? await this.repository.objectsWithAssets(rows.map(row => row.sha256), tx) : new Set<string>()
      const at = await this.clock.now(tx)
      const policy = assetGcPolicy(this.config.jobs.assetGc, at)
      const marked: string[] = []
      const reset: string[] = []
      const queued: AssetGcObjectRow[] = []
      for (const row of rows) {
        if (retained.has(row.sha256)) {
          if (row.unreferencedAt !== null)
            reset.push(row.sha256)
        }
        else if (row.unreferencedAt === null) {
          marked.push(row.sha256)
        }
        else if (canRetire(row.unreferencedAt, policy)) {
          queued.push(row)
        }
      }
      await this.repository.updateObjectCandidates(kind, marked, reset, at, tx)
      await this.repository.queueObjects(kind, queued, at, tx)
      const bytes = queued.reduce((sum, row) => sum + row.bytes, 0)
      if (queued.length > 0) {
        await this.audit.record({ action: 'assets.retirement_queued', actor: { type: 'system' }, origin: { source: 'job' }, details: { count: queued.length, bytes } }, { transaction: tx })
      }
      return { scanned: rows.length, marked: marked.length, reset: reset.length, queued: queued.length, bytes, policy: policy.state, ...(last === undefined ? {} : { lastHash: last.sha256 }) }
    })
  }

  private validatePage(page: AssetGcPage): void {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 1000)
      throw new Error('资源回收页大小须在 1 至 1000 之间')
  }
}
