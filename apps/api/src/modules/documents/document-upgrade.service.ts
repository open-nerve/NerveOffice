import type { DocumentUpgradeFailureCode } from '@nerve-office/contracts'
import type { Transaction } from '../database/index.ts'
import type { DocumentUpgradeBatch, DocumentUpgradeReceipt } from './document-upgrade.ts'
import { DOCUMENT_UPGRADE_FAILURE_CODES, isDocumentUpgradeTarget } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { z } from 'zod'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { DocumentCheckpointClock } from './document-checkpoint-clock.ts'
import { DocumentCheckpointService } from './document-checkpoint.service.ts'
import { DocumentUpgradeRepository } from './document-upgrade.repository.ts'
import { DocumentUpgradeError } from './document-upgrade.ts'

type UpgradeAction = 'documents.upgrade_prepared' | 'documents.upgrade_ready' | 'documents.upgrade_released' | 'documents.upgrade_aborted'

/** 运维入口：短事务提交一批，进程退出不会自动释放持久冻结。无 HTTP/用户权限旁路。 */
@Injectable()
export class DocumentUpgradeService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly repository: DocumentUpgradeRepository,
    private readonly checkpoints: DocumentCheckpointService,
    private readonly clock: DocumentCheckpointClock,
    private readonly audit: AuditService,
  ) {}

  async prepare(targetVersion: string): Promise<DocumentUpgradeReceipt> {
    if (!isDocumentUpgradeTarget(targetVersion))
      throw new DocumentUpgradeError('target_invalid')
    return this.transactions.run(async (tx) => {
      await this.repository.acquirePreparationLock(tx)
      if (await this.repository.barrier(tx, 'update') !== null)
        throw new DocumentUpgradeError('batch_active')
      const batch = await this.repository.prepare(targetVersion, tx)
      await this.#audit('documents.upgrade_prepared', batch, tx)
      return this.#receipt(batch, batch.id, tx)
    })
  }

  async status(id?: string): Promise<DocumentUpgradeReceipt> {
    if (id !== undefined)
      this.#requireId(id)
    return this.transactions.readSnapshot(async (tx) => {
      const active = await this.repository.barrier(tx)
      const requested = id ?? active
      const batch = requested === null ? null : await this.repository.batch(requested, tx)
      return this.#receipt(batch, active, tx)
    })
  }

  async resume(id: string, batchSize = 20, signal?: AbortSignal): Promise<DocumentUpgradeReceipt & { readonly interrupted: boolean }> {
    this.#requireId(id)
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
      throw new DocumentUpgradeError('batch_size_invalid')
    const stopped = (): boolean => signal?.aborted === true
    try {
      // 即使信号预先到达，也先核对批次身份；不把不存在的批次报告为成功中止。
      if (stopped())
        return { ...await this.status(id), interrupted: true }
      for (;;) {
        const result = await this.transactions.run(async tx => this.#captureBatch(id, batchSize, tx))
        if (result.batch?.status === 'ready')
          return { ...result, interrupted: false }
        if (stopped())
          return { ...result, interrupted: true }
      }
    }
    catch (error) {
      const reason = this.#failureCode(error)
      if (reason !== undefined)
        await this.#recordFailure(id, reason).catch(() => {}) // 即使数据库暂不可用，原冻结也仍然持久；保留原错误。
      throw error
    }
  }

  async release(id: string): Promise<DocumentUpgradeReceipt> {
    this.#requireId(id)
    return this.transactions.run(async (tx) => {
      const active = await this.repository.barrier(tx, 'update')
      let batch = await this.repository.batch(id, tx, true)
      if (batch.status === 'released')
        return this.#receipt(batch, active, tx)
      this.#requireActive(batch, active)
      if (batch.status !== 'ready')
        throw new DocumentUpgradeError('not_ready')
      await this.#prove(batch, tx)
      batch = await this.repository.transition(id, 'released', await this.clock.now(tx), tx)
      await this.repository.setActive(null, tx)
      await this.#audit('documents.upgrade_released', batch, tx)
      return this.#completeReceipt(batch, null, tx)
    })
  }

  async abort(id: string): Promise<DocumentUpgradeReceipt> {
    this.#requireId(id)
    return this.transactions.run(async (tx) => {
      const active = await this.repository.barrier(tx, 'update')
      let batch = await this.repository.batch(id, tx, true)
      if (batch.status === 'aborted')
        return this.#receipt(batch, active, tx)
      this.#requireActive(batch, active)
      batch = await this.repository.transition(id, 'aborted', await this.clock.now(tx), tx)
      await this.repository.setActive(null, tx)
      await this.#audit('documents.upgrade_aborted', batch, tx)
      return this.#receipt(batch, null, tx)
    })
  }

  async #captureBatch(id: string, limit: number, tx: Transaction): Promise<DocumentUpgradeReceipt> {
    const active = await this.repository.barrier(tx, 'share')
    let batch = await this.repository.batch(id, tx, true)
    this.#requireActive(batch, active)
    const pending = await this.repository.pending(id, await this.clock.now(tx), limit, tx)
    if (batch.status === 'failed' || (batch.status === 'ready' && pending.length > 0))
      batch = await this.repository.transition(id, 'preparing', await this.clock.now(tx), tx)
    for (const source of pending) {
      await this.repository.holdSource(source, tx)
      let checkpoint = await this.repository.eventCheckpoint(source.documentId, id, tx)
      const now = await this.clock.now(tx)
      if (checkpoint !== undefined && checkpoint.revision !== source.revision)
        throw new DocumentUpgradeError('source_changed')
      if (checkpoint !== undefined && checkpoint.expiresAt <= now) {
        await this.repository.deleteCheckpoint(checkpoint.id, tx)
        checkpoint = undefined
      }
      if (checkpoint === undefined) {
        await this.checkpoints.captureOperation(source.documentId, 'before_upgrade', id, tx)
        checkpoint = await this.repository.eventCheckpoint(source.documentId, id, tx)
      }
      if (checkpoint === undefined || checkpoint.revision !== source.revision)
        throw new DocumentUpgradeError('checkpoint_incomplete')
      await this.repository.acknowledge(id, source.documentId, checkpoint.id, tx)
    }
    const counts = await this.repository.counts(id, await this.clock.now(tx), tx)
    if (counts.sources !== batch.sourceCount)
      throw new DocumentUpgradeError('checkpoint_incomplete')
    if (counts.completed === batch.sourceCount) {
      await this.#prove(batch, tx)
      if (batch.status !== 'ready') {
        batch = await this.repository.transition(id, 'ready', await this.clock.now(tx), tx)
        await this.#audit('documents.upgrade_ready', batch, tx)
      }
    }
    else if (batch.status === 'ready') {
      // 扫描后才到期也须重新接续，不能凭旧 ready 提前结束循环。
      batch = await this.repository.transition(id, 'preparing', await this.clock.now(tx), tx)
    }
    return batch.status === 'ready' ? this.#completeReceipt(batch, active, tx) : this.#receipt(batch, active, tx)
  }

  async #prove(batch: DocumentUpgradeBatch, tx: Transaction): Promise<void> {
    await this.repository.holdProof(batch.id, tx)
    const counts = await this.repository.counts(batch.id, await this.clock.now(tx), tx)
    if (counts.sources !== batch.sourceCount || counts.completed !== batch.sourceCount)
      throw new DocumentUpgradeError('checkpoint_incomplete')
  }

  async #receipt(batch: DocumentUpgradeBatch | null, active: string | null, tx: Transaction): Promise<DocumentUpgradeReceipt> {
    const completedCount = batch === null ? 0 : (await this.repository.counts(batch.id, await this.clock.now(tx), tx)).completed
    return { batch: batch === null ? null : { ...batch, completedCount }, activeBatchId: active, writeFrozen: active !== null }
  }

  async #completeReceipt(batch: DocumentUpgradeBatch, active: string | null, tx: Transaction): Promise<DocumentUpgradeReceipt> {
    // CP 锁仍持有，但期限会走动；审计等锁后再按数据库新时刻复核，失败则状态和审计一起回滚。
    const receipt = await this.#receipt(batch, active, tx)
    if (receipt.batch?.completedCount !== batch.sourceCount)
      throw new DocumentUpgradeError('checkpoint_incomplete')
    return receipt
  }

  async #audit(action: UpgradeAction, batch: DocumentUpgradeBatch, tx: Transaction): Promise<void> {
    await this.audit.record({ action, actor: { type: 'system' }, origin: { source: 'cli' }, details: { batchId: batch.id, targetVersion: batch.targetVersion, documents: batch.sourceCount } }, { transaction: tx })
  }

  async #recordFailure(id: string, reason: DocumentUpgradeFailureCode): Promise<void> {
    await this.transactions.run(async (tx) => {
      const active = await this.repository.barrier(tx, 'share')
      const batch = await this.repository.batch(id, tx, true)
      if (active !== batch.id || batch.status === 'released' || batch.status === 'aborted')
        return
      // COMMIT 回执丢失时，别把已经完整提交的 ready 覆盖成 failed。
      if (batch.status === 'ready') {
        await this.repository.holdProof(id, tx)
        const counts = await this.repository.counts(id, await this.clock.now(tx), tx)
        if (counts.sources === batch.sourceCount && counts.completed === batch.sourceCount)
          return
      }
      if (batch.status === 'failed' && batch.failureCode === reason)
        return
      await this.repository.transition(id, 'failed', await this.clock.now(tx), tx, reason)
      await this.audit.record({ action: 'documents.upgrade_failed', actor: { type: 'system' }, origin: { source: 'cli' }, details: { batchId: id, targetVersion: batch.targetVersion, documents: batch.sourceCount, reason } }, { transaction: tx })
    })
  }

  #failureCode(error: unknown): DocumentUpgradeFailureCode | undefined {
    if (!(error instanceof DocumentUpgradeError))
      return 'database_failure'
    return DOCUMENT_UPGRADE_FAILURE_CODES.find(code => code === error.code)
  }

  #requireActive(batch: DocumentUpgradeBatch, active: string | null): void {
    if (active !== batch.id || batch.status === 'released' || batch.status === 'aborted')
      throw new DocumentUpgradeError('batch_inactive')
  }

  #requireId(id: string): void {
    if (!z.uuid().safeParse(id).success)
      throw new DocumentUpgradeError('batch_id_invalid')
  }
}
