import type { DocumentUpgradeFailureCode, DocumentUpgradeStatus } from '@nerve-office/contracts'
import type { Database, Transaction } from '../database/index.ts'
import type { DocumentUpgradeBatch } from './document-upgrade.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, sql } from 'drizzle-orm'
import { documentCheckpoints, documentUpgradeBarrier, documentUpgradeBatches, documentUpgradeSources } from '../../db/schema/documents/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'
import { DOCUMENT_UPGRADE_LOCK, DocumentUpgradeError } from './document-upgrade.ts'

interface UpgradeSource {
  readonly documentId: string
  readonly revision: number
}

interface UpgradeCounts {
  readonly sources: number
  readonly completed: number
}

/** 运维仓储只返回有界元数据或聚合计数；gzip 和完整源清单不经过 JS。 */
@Injectable()
export class DocumentUpgradeRepository {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async acquirePreparationLock(tx: Transaction): Promise<void> {
    await executorOf(this.database, tx).execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${DOCUMENT_UPGRADE_LOCK}, 0))`)
  }

  async barrier(tx: Transaction, lock?: 'share' | 'update'): Promise<string | null> {
    const query = executorOf(this.database, tx).select().from(documentUpgradeBarrier).where(eq(documentUpgradeBarrier.id, 1))
    const [row] = await (lock === undefined ? query : query.for(lock))
    if (row === undefined)
      throw new DocumentUpgradeError('database_failure')
    return row.activeBatchId
  }

  async batch(id: string, tx: Transaction, lock = false): Promise<DocumentUpgradeBatch> {
    const query = executorOf(this.database, tx).select().from(documentUpgradeBatches).where(eq(documentUpgradeBatches.id, id))
    const [row] = await (lock ? query.for('update') : query)
    if (row === undefined)
      throw new DocumentUpgradeError('batch_not_found')
    return row
  }

  async prepare(targetVersion: string, tx: Transaction): Promise<DocumentUpgradeBatch> {
    const db = executorOf(this.database, tx)
    const [batch] = await db.insert(documentUpgradeBatches).values({ targetVersion, sourceCount: 0 }).returning()
    if (batch === undefined)
      throw new DocumentUpgradeError('database_failure')
    const result = await db.execute<{ sources: number, complete: number }>(sql`
      WITH manifest AS (INSERT INTO document_upgrade_sources (batch_id,document_id,revision)
        SELECT ${batch.id}::uuid,d.id,d.revision FROM documents d
        JOIN document_contents c ON c.document_id=d.id
        JOIN document_revisions r ON r.document_id=d.id AND r.revision=d.revision
        ORDER BY d.id RETURNING 1)
      SELECT (SELECT count(*)::int FROM documents) AS sources,(SELECT count(*)::int FROM manifest) AS complete`)
    const counts = result.rows[0]
    if (counts === undefined || counts.sources !== counts.complete)
      throw new DocumentUpgradeError('source_incomplete')
    await db.update(documentUpgradeBatches).set({ sourceCount: counts.sources }).where(eq(documentUpgradeBatches.id, batch.id))
    await this.setActive(batch.id, tx)
    return { ...batch, sourceCount: counts.sources }
  }

  async setActive(id: string | null, tx: Transaction): Promise<void> {
    const changed = await executorOf(this.database, tx).update(documentUpgradeBarrier).set({ activeBatchId: id }).where(eq(documentUpgradeBarrier.id, 1)).returning({ id: documentUpgradeBarrier.id })
    if (changed.length !== 1)
      throw new DocumentUpgradeError('database_failure')
  }

  async pending(batchId: string, at: Date, limit: number, tx: Transaction): Promise<UpgradeSource[]> {
    // 不锁回执行：expiry 按 CP → 回执的 FK SET NULL 顺序，不能在这里反向持锁。
    const result = await executorOf(this.database, tx).execute<{ documentId: string, revision: number }>(sql`
      SELECT s.document_id AS "documentId",s.revision FROM document_upgrade_sources s
      LEFT JOIN document_checkpoints p ON p.id=s.checkpoint_id AND p.kind='before_upgrade'
        AND p.event_id=s.batch_id AND p.source_document_id=s.document_id AND p.revision=s.revision
        AND p.expires_at > ${at.toISOString()}::timestamptz
      WHERE s.batch_id=${batchId}::uuid AND p.id IS NULL ORDER BY s.document_id LIMIT ${limit}`)
    return result.rows
  }

  async holdSource(source: UpgradeSource, tx: Transaction): Promise<void> {
    const db = executorOf(this.database, tx)
    const result = await db.execute<{ revision: number }>(sql`SELECT revision FROM documents WHERE id=${source.documentId}::uuid FOR SHARE`)
    const row = result.rows[0]
    if (row === undefined)
      throw new DocumentUpgradeError('source_incomplete')
    if (row.revision !== source.revision)
      throw new DocumentUpgradeError('source_changed')
    const current = await db.execute(sql`SELECT 1 FROM document_contents c JOIN document_revisions r ON r.document_id=c.document_id
      WHERE c.document_id=${source.documentId}::uuid AND r.revision=${source.revision}`)
    if (current.rows.length !== 1)
      throw new DocumentUpgradeError('source_incomplete')
  }

  async eventCheckpoint(documentId: string, batchId: string, tx: Transaction): Promise<{ id: string, revision: number, expiresAt: Date } | undefined> {
    const p = documentCheckpoints
    const [row] = await executorOf(this.database, tx).select({ id: p.id, revision: p.revision, expiresAt: p.expiresAt }).from(p).where(and(eq(p.sourceDocumentId, documentId), eq(p.kind, 'before_upgrade'), eq(p.eventId, batchId))).for('update')
    return row
  }

  async deleteCheckpoint(id: string, tx: Transaction): Promise<void> {
    await executorOf(this.database, tx).delete(documentCheckpoints).where(eq(documentCheckpoints.id, id))
  }

  async acknowledge(batchId: string, documentId: string, checkpointId: string, tx: Transaction): Promise<void> {
    const s = documentUpgradeSources
    const changed = await executorOf(this.database, tx).update(s).set({ checkpointId }).where(and(eq(s.batchId, batchId), eq(s.documentId, documentId))).returning({ id: s.documentId })
    if (changed.length !== 1)
      throw new DocumentUpgradeError('checkpoint_incomplete')
  }

  async counts(batchId: string, at: Date, tx: Transaction): Promise<UpgradeCounts> {
    const result = await executorOf(this.database, tx).execute<{ sources: number, completed: number }>(sql`
      SELECT count(*)::int AS sources,count(p.id)::int AS completed FROM document_upgrade_sources s
      LEFT JOIN document_checkpoints p ON p.id=s.checkpoint_id AND p.kind='before_upgrade'
        AND p.event_id=s.batch_id AND p.source_document_id=s.document_id AND p.revision=s.revision
        AND p.expires_at > ${at.toISOString()}::timestamptz WHERE s.batch_id=${batchId}::uuid`)
    const row = result.rows[0]
    if (row === undefined)
      throw new DocumentUpgradeError('database_failure')
    return row
  }

  async holdProof(batchId: string, tx: Transaction): Promise<void> {
    // 到期删除也要 CP 写锁；所有证明行持到完成/释放事务提交。计数只为迫使数据库消费所有锁行。
    await executorOf(this.database, tx).execute(sql`SELECT count(*) FROM (
      SELECT p.id FROM document_checkpoints p JOIN document_upgrade_sources s ON s.checkpoint_id=p.id
      WHERE s.batch_id=${batchId}::uuid ORDER BY p.id FOR SHARE OF p) AS held`)
  }

  async transition(batchId: string, status: DocumentUpgradeStatus, at: Date, tx: Transaction, failureCode: DocumentUpgradeFailureCode | null = null): Promise<DocumentUpgradeBatch> {
    const values = { status, updatedAt: at, failureCode, ...(status === 'ready' ? { completedAt: at } : {}), ...(status === 'preparing' || status === 'failed' ? { completedAt: null } : {}) }
    const [row] = await executorOf(this.database, tx).update(documentUpgradeBatches).set(values).where(eq(documentUpgradeBatches.id, batchId)).returning()
    if (row === undefined)
      throw new DocumentUpgradeError('batch_not_found')
    return row
  }
}
