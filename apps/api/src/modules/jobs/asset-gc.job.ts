import type { AssetGcAssetPage, AssetGcObjectKind, AssetRetirementPause } from '../assets/index.ts'
import type { AppConfig } from '../config/index.ts'
import type { JobSchedule, ScheduledJob } from './scheduled-job.ts'
import { Inject, Injectable } from '@nestjs/common'
import { AssetGcService, AssetRetirementService, AssetStorageError } from '../assets/index.ts'
import { APP_CONFIG } from '../config/index.ts'
import { ExclusiveRunner } from '../database/index.ts'
import { DocumentAssetRetentionService } from '../documents/index.ts'
import { AppLogger } from '../logging/index.ts'

export const ASSET_GC_LOCK = 'nerve-office:asset-gc'
export type AssetGcEnding = 'drained' | 'contended' | 'paused' | 'stopped' | 'failed'
interface Progress {
  batches: number
  scannedAssets: number
  removedAssets: number
  scannedObjects: number
  queuedObjects: number
  retiredObjects: number
  reclaimedBytes: number
  pausedTasks: number
  pauseReason: AssetRetirementPause | undefined
  stage: 'assets' | 'object' | 'claim' | 'files'
}
export interface AssetGcRound extends Readonly<Progress> {
  readonly ran: boolean
  readonly ending: AssetGcEnding
}
const NEVER_STOPPING = new AbortController().signal

/** 一轮跨事务独占；候选/任务固定上界，文件 IO 与所有数据库短事务分开。 */
@Injectable()
export class AssetGcJob implements ScheduledJob {
  readonly name = 'asset-gc'
  readonly title = '图片资源回收'
  readonly disabled = { variable: 'NERVE_ASSET_GC_ENABLED', consequence: '候选与引用活动暂不整理，资源及文件保持原状，重新启用后分批继续' }
  readonly schedule: JobSchedule
  readonly settings: Readonly<Record<string, unknown>>
  readonly #batchSize: number
  readonly #logger: AppLogger

  constructor(
    private readonly exclusive: ExclusiveRunner,
    private readonly gc: AssetGcService,
    private readonly retention: DocumentAssetRetentionService,
    private readonly retirement: AssetRetirementService,
    @Inject(APP_CONFIG) config: AppConfig,
    logger: AppLogger,
  ) {
    const { enabled, intervalMs, batchSize, graceDays } = config.jobs.assetGc
    this.schedule = { enabled, intervalMs }
    this.settings = { batchSize, graceDays }
    this.#batchSize = batchSize
    this.#logger = logger.with({ module: 'jobs', job: this.name })
  }

  /** 调度的 now 只表示触发时间；每个危险决定必须重新取锁后的数据库时刻。 */
  async runOnce(_now: Date, signal: AbortSignal = NEVER_STOPPING): Promise<AssetGcRound> {
    const progress: Progress = { batches: 0, scannedAssets: 0, removedAssets: 0, scannedObjects: 0, queuedObjects: 0, retiredObjects: 0, reclaimedBytes: 0, pausedTasks: 0, pauseReason: undefined, stage: 'assets' }
    if (signal.aborted)
      return { ...progress, ran: false, ending: 'stopped' }
    let ran = false
    try {
      const outcome = await this.exclusive.run(ASSET_GC_LOCK, async (): Promise<AssetGcEnding> => {
        ran = true
        notePolicy(progress, await this.gc.policyState())
        if (progress.pauseReason === 'disabled')
          return 'paused'
        await this.scanAssets(progress, signal)
        for (const kind of ['object', 'claim'] as const) {
          if (signal.aborted)
            return 'stopped'
          progress.stage = kind
          await this.scanObjects(kind, progress, signal)
        }
        if (signal.aborted)
          return 'stopped'
        notePolicy(progress, await this.gc.policyState())
        if (progress.pauseReason !== undefined)
          return 'paused'
        progress.stage = 'files'
        await this.retireFiles(progress, signal)
        return signal.aborted ? 'stopped' : progress.pauseReason === undefined ? 'drained' : 'paused'
      })
      const result: AssetGcRound = { ...progress, ran: outcome.ran, ending: outcome.ran ? outcome.result : 'contended' }
      this.#logger.info('图片资源回收本轮结束', { ...result })
      return result
    }
    catch (error) {
      const result: AssetGcRound = { ...progress, ran, ending: 'failed' }
      // 原始 FS/数据库异常可能带路径或参数，只记录有限原因与阶段。
      this.#logger.error('图片资源回收本轮停止，保留持久任务供下轮继续', { ...result, failure: error instanceof AssetStorageError ? error.reason : 'transaction-or-state' })
      return result
    }
  }

  private async scanAssets(progress: Progress, signal: AbortSignal): Promise<void> {
    const through = await this.gc.assetUpperBound()
    if (through === undefined)
      return
    let after: string | undefined
    while (!signal.aborted) {
      const page = await this.gc.scanAssets(this.retention, { through, limit: this.#batchSize, ...(after === undefined ? {} : { after }) })
      progress.batches++
      progress.scannedAssets += page.scanned
      progress.removedAssets += page.removed
      notePolicy(progress, page.policy)
      if (page.lastId === undefined)
        return
      after = page.lastId
    }
  }

  private async scanObjects(kind: AssetGcObjectKind, progress: Progress, signal: AbortSignal): Promise<void> {
    const through = await this.gc.objectUpperBound(kind)
    if (through === undefined)
      return
    let after: string | undefined
    while (!signal.aborted) {
      const page = await this.gc.scanObjects(kind, { through, limit: this.#batchSize, ...(after === undefined ? {} : { after }) })
      progress.batches++
      progress.scannedObjects += page.scanned
      progress.queuedObjects += page.queued
      notePolicy(progress, page.policy)
      if (page.lastHash === undefined)
        return
      after = page.lastHash
    }
  }

  private async retireFiles(progress: Progress, signal: AbortSignal): Promise<void> {
    const through = await this.retirement.upperBound()
    if (through === undefined)
      return
    let after: string | undefined
    while (!signal.aborted) {
      const ids = await this.retirement.page({ through, limit: this.#batchSize, ...(after === undefined ? {} : { after }) })
      if (ids.length === 0)
        return
      progress.batches++
      for (const id of ids) {
        if (signal.aborted)
          return
        const outcome = await this.retirement.retire(id, signal)
        progress.retiredObjects += Number(outcome.state === 'completed')
        progress.reclaimedBytes += outcome.bytes
        if (outcome.state === 'paused') {
          progress.pausedTasks++
          progress.pauseReason = outcome.reason
        }
        if (outcome.state === 'stopped')
          return
      }
      after = ids.at(-1)
    }
  }
}

function notePolicy(progress: Progress, state: AssetGcAssetPage['policy']): void {
  progress.pauseReason = state === 'ready' ? undefined : state
}
