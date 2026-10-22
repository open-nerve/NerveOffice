import type { AppConfig } from '../config/index.ts'
import type { AssetGcPause } from './asset-gc-policy.ts'
import type { AssetGcPage } from './asset-gc.ts'
import type { AssetRetirementReceipt } from './asset-retirement.repository.ts'
import type { StorageAdapter } from './storage-adapter.ts'
import { Inject, Injectable } from '@nestjs/common'
import { AuditService } from '../audit/index.ts'
import { APP_CONFIG } from '../config/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { AssetGcClock } from './asset-gc-clock.ts'
import { assetGcPolicy, canRetire } from './asset-gc-policy.ts'
import { AssetRetirementRepository } from './asset-retirement.repository.ts'
import { ASSET_STORAGE, assetObjectKey, parseAssetObjectKey } from './storage-adapter.ts'

export type AssetRetirementPause = AssetGcPause | 'candidate-protected'
export type AssetRetirementResult
  = { readonly state: 'paused', readonly reason: AssetRetirementPause, readonly bytes: 0 }
    | { readonly state: 'completed' | 'already-completed' | 'missing' | 'stopped', readonly bytes: number }
const NEVER_STOPPING = new AbortController().signal

/** 只接收持久任务 id。读取/确认是短事务；文件 IO 不持 quota 或任务行锁。 */
@Injectable()
export class AssetRetirementService {
  constructor(
    private readonly repository: AssetRetirementRepository,
    private readonly transactions: TransactionRunner,
    private readonly clock: AssetGcClock,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ASSET_STORAGE) private readonly storage: StorageAdapter,
  ) {}

  async upperBound(): Promise<string | undefined> {
    return this.transactions.readSnapshot(async tx => this.repository.upperBound(tx))
  }

  async page(page: AssetGcPage): Promise<readonly string[]> {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 1000)
      throw new Error('资源回收页大小须在 1 至 1000 之间')
    return this.transactions.readSnapshot(async tx => this.repository.page(page, tx))
  }

  async retire(id: string, signal: AbortSignal = NEVER_STOPPING): Promise<AssetRetirementResult> {
    if (signal.aborted)
      return { state: 'stopped', bytes: 0 }
    const prepared = await this.transactions.run(async (tx) => {
      const receipt = await this.repository.lock(id, tx)
      if (receipt === undefined)
        return { result: { state: 'missing', bytes: 0 } as const }
      if (receipt.completedAt !== null)
        return { result: { state: 'already-completed', bytes: 0 } as const }
      await this.repository.requireNoLivePath(receipt, tx)
      const reason = this.protectedReason(receipt, await this.clock.now(tx))
      if (reason !== undefined)
        return { result: { state: 'paused', reason, bytes: 0 } as const }
      if (receipt.storageKey !== assetObjectKey(receipt.sha256, receipt.generation))
        throw new Error('文件回收路径与持久代次不一致')
      return { receipt }
    })
    if (prepared.result !== undefined)
      return prepared.result
    if (signal.aborted)
      return { state: 'stopped', bytes: 0 }
    const expected = prepared.receipt
    await this.storage.retire(parseAssetObjectKey(expected.storageKey, expected.sha256), { sha256: expected.sha256, bytes: expected.bytes })
    // 文件成功以后即使收到退出信号，也完成这一安全单元；结果未知由下轮重读，不补偿。
    return this.transactions.run(async (tx) => {
      const receipt = await this.repository.lock(id, tx)
      if (receipt === undefined || !sameReceipt(receipt, expected))
        throw new Error('文件回收确认时持久回执发生变化')
      if (receipt.completedAt !== null)
        return { state: 'already-completed', bytes: 0 }
      await this.repository.requireNoLivePath(receipt, tx)
      const at = await this.clock.now(tx)
      const reason = this.protectedReason(receipt, at)
      if (reason !== undefined)
        return { state: 'paused', reason, bytes: 0 }
      await this.repository.complete(receipt, at, tx)
      await this.audit.record({ action: 'assets.bytes_reclaimed', actor: { type: 'system' }, origin: { source: 'job' }, details: { count: 1, bytes: receipt.bytes } }, { transaction: tx })
      return { state: 'completed', bytes: receipt.bytes }
    })
  }

  private protectedReason(receipt: AssetRetirementReceipt, at: Date): AssetRetirementPause | undefined {
    if (at.getTime() < receipt.createdAt.getTime())
      throw new Error('数据库时刻早于退休任务登记时刻，停止文件回收')
    const policy = assetGcPolicy(this.config.jobs.assetGc, at)
    if (policy.state !== 'ready')
      return policy.state
    return canRetire(receipt.unreferencedAt, policy) ? undefined : 'candidate-protected'
  }
}

function sameReceipt(left: AssetRetirementReceipt, right: AssetRetirementReceipt): boolean {
  return left.id === right.id && left.sha256 === right.sha256 && left.generation === right.generation
    && left.storageKey === right.storageKey && left.bytes === right.bytes
    && left.unreferencedAt.getTime() === right.unreferencedAt.getTime()
    && left.createdAt.getTime() === right.createdAt.getTime()
}
