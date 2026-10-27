import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { AuditService, loadConfig, openDocumentCheckpointApplication, TransactionRunner } from '@nerve-office/api'
import { DatabaseDocumentCheckpointClock, DocumentCheckpointClock, DocumentCheckpointService, DocumentsRepository } from '@nerve-office/api/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp, testEnvironment } from '../support/api-app.ts'
import { uploadTestAsset } from '../support/assets.ts'
import { pageSnapshot } from '../support/conflict-copies.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { saveContent } from '../support/edit-leases.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { captureLogs } from '../support/log-capture.ts'
import { login } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let operations: Awaited<ReturnType<typeof openDocumentCheckpointApplication>>
let owner: TestAccount
let sources: Awaited<ReturnType<typeof seedDocument>>[]
beforeAll(async () => {
  database = await createTestDatabase()
  await database.query(async client => client.query(`CREATE FUNCTION upgrade_audit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('upgrade-audit-gate:' || NEW.action,0));
      RETURN NEW;
    END $$;
    CREATE TRIGGER upgrade_audit_gate BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION upgrade_audit_gate();`))
  app = await startTestApp({ databaseUrl: database.url })
  operations = await openDocumentCheckpointApplication(loadConfig(testEnvironment(database.url)), { logDestination: captureLogs().destination })
  owner = await createAccount(database, { username: 'upgrade-checkpoints-owner' })
})
beforeEach(async () => {
  sources = []
  for (let i = 0; i < 3; i++)
    sources.push(await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: `升级原件 ${i}` }))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await database.query(async (client) => {
    await client.query('UPDATE document_upgrade_barrier SET active_batch_id=NULL')
    await client.query('DELETE FROM document_upgrade_batches')
    await client.query('DELETE FROM document_checkpoints')
    await client.query('DELETE FROM documents')
  })
})
afterAll(async () => {
  await operations?.close()
  await app?.close()
  await database?.drop()
})

async function prepare() {
  const result = await operations.service.prepare('univer@next-1')
  expect(result.batch).not.toBeNull()
  return result.batch!.id
}

async function auditActions(id: string) {
  return database.query(async client => (await client.query<{ action: string }>('SELECT action FROM audit_events WHERE action LIKE \'documents.upgrade_%\' AND details->>\'batchId\'=$1 ORDER BY occurred_at,id', [id])).rows.map(row => row.action))
}

describe('US-M5-11 升级前检查点完整批次', () => {
  it('完整冻结清单，短批复制原 gzip/信封/图片关系；ready 仍冻结，release 后才可写', async () => {
    const session = await login(app.baseUrl, owner.username, owner.password)
    const asset = await uploadTestAsset(app.baseUrl, session)
    const doc = sources[0]!
    const body = gzipSync(Buffer.from(JSON.stringify({ ...JSON.parse(pageSnapshot(doc.unitId, '升级前原文').toString('utf8')) as Record<string, unknown>, images: [`/api/assets/${asset.assetId}`] })))
    const savedRequest = { baseRevision: 1, requestId: randomUUID(), clientInstanceId: randomUUID() }
    expect((await saveContent(app.baseUrl, session, doc.id, body, savedRequest)).status).toBe(200)
    const id = await prepare()
    expect((await saveContent(app.baseUrl, session, doc.id, body, savedRequest)).status).toBe(200)
    const frozenSave = await saveContent(app.baseUrl, session, doc.id, gzipSync(pageSnapshot(doc.unitId, '冻结时的新正文')), { baseRevision: 2 })
    expect(frozenSave.status).toBe(503)
    expect(await operations.service.status()).toMatchObject({ activeBatchId: id, writeFrozen: true, batch: { id, status: 'preparing', sourceCount: 3, completedCount: 0 } })
    await expect(operations.service.release(id)).rejects.toMatchObject({ code: 'not_ready' })
    expect(await operations.service.resume(id, 1)).toMatchObject({ writeFrozen: true, interrupted: false, batch: { status: 'ready', completedCount: 3 } })
    const exact = await database.query(async client => (await client.query<{ unchanged: boolean }>(`SELECT bool_and(
      p.snapshot=c.snapshot AND p.title=d.title AND p.unit_id=d.unit_id AND p.profile=d.profile AND p.format_version=d.format_version
      AND p.sdk_version=d.sdk_version AND p.client_build IS NOT DISTINCT FROM d.client_build AND p.revision=d.revision
      AND p.formulas_pending=d.formulas_pending AND p.raw_bytes=c.raw_bytes AND p.stored_bytes=c.stored_bytes
      AND p.content_hash IS NOT DISTINCT FROM c.content_hash AND p.resource_names IS NOT DISTINCT FROM c.resource_names
      AND p.saved_by=r.saved_by AND p.saved_at=r.created_at
      AND ARRAY(SELECT asset_id FROM document_checkpoint_assets WHERE checkpoint_id=p.id ORDER BY asset_id)
          = ARRAY(SELECT asset_id FROM document_asset_links WHERE document_id=d.id ORDER BY asset_id)) AS unchanged
      FROM document_upgrade_sources s JOIN documents d ON d.id=s.document_id
      JOIN document_checkpoints p ON p.id=s.checkpoint_id JOIN document_contents c ON c.document_id=d.id
      JOIN document_revisions r ON r.document_id=d.id AND r.revision=d.revision WHERE s.batch_id=$1`, [id])).rows[0])
    expect(exact).toEqual({ unchanged: true })
    await expect(database.query(async client => client.query('UPDATE documents SET title=title'))).rejects.toMatchObject({ code: '55P03' })
    const before = await auditActions(id)
    await operations.service.resume(id, 2)
    expect(await auditActions(id)).toEqual(before)
    expect(await operations.service.release(id)).toMatchObject({ writeFrozen: false, batch: { status: 'released', completedCount: 3 } })
    await database.query(async client => client.query('UPDATE documents SET title=title'))
    expect((await auditActions(id)).slice(-3)).toEqual(['documents.upgrade_prepared', 'documents.upgrade_ready', 'documents.upgrade_released'])
    await database.query(async client => client.query('DELETE FROM documents WHERE id=$1', [doc.id]))
    expect(await operations.service.status(id)).toMatchObject({ batch: { status: 'released', sourceCount: 3, completedCount: 3 } })
  })

  it('中止信号只结束当前短批；另一应用上下文接续，已提交检查点不重复', async () => {
    const id = await prepare()
    const controller = new AbortController()
    // eslint-disable-next-line ts/unbound-method -- 故障/信号注入仍通过 apply(this) 调用真实实例的方法，不改变接收者。
    const capture = DocumentCheckpointService.prototype.captureOperation
    let count = 0
    vi.spyOn(DocumentCheckpointService.prototype, 'captureOperation').mockImplementation(async function (this: DocumentCheckpointService, ...args) {
      const result = await capture.apply(this, args)
      if (++count === 2)
        controller.abort()
      return result
    })
    expect(await operations.service.resume(id, 2, controller.signal)).toMatchObject({ writeFrozen: true, interrupted: true, batch: { status: 'preparing', completedCount: 2 } })
    const partial = await database.query(async client => (await client.query<{ id: string }>('SELECT id FROM document_checkpoints WHERE event_id=$1 AND kind=\'before_upgrade\' ORDER BY id', [id])).rows.map(row => row.id))
    vi.restoreAllMocks()
    await operations.close()
    operations = await openDocumentCheckpointApplication(loadConfig(testEnvironment(database.url)), { logDestination: captureLogs().destination })
    expect(await operations.service.resume(id, 2)).toMatchObject({ writeFrozen: true, batch: { status: 'ready', completedCount: 3 } })
    const complete = await database.query(async client => (await client.query<{ id: string }>('SELECT id FROM document_checkpoints WHERE event_id=$1 AND kind=\'before_upgrade\' ORDER BY id', [id])).rows.map(row => row.id))
    expect(complete).toHaveLength(3)
    expect(complete).toEqual(expect.arrayContaining(partial))
  })

  it('同一批并发接续只生成一套；冲突 prepare 和旧 release/abort 都不会误解冻新批次', async () => {
    const id = await prepare()
    await expect(operations.service.prepare('second')).rejects.toMatchObject({ code: 'batch_active' })
    await Promise.all([operations.service.resume(id, 1), operations.service.resume(id, 2)])
    expect((await operations.service.status(id)).batch).toMatchObject({ completedCount: 3, status: 'ready' })
    await operations.service.release(id)
    const second = await prepare()
    expect(await operations.service.release(id)).toMatchObject({ writeFrozen: true, activeBatchId: second, batch: { status: 'released' } })
    await expect(operations.service.abort(id)).rejects.toMatchObject({ code: 'batch_inactive' })
    await expect(operations.service.resume(randomUUID(), 1)).rejects.toMatchObject({ code: 'batch_not_found' })
    expect(await operations.service.abort(second)).toMatchObject({ writeFrozen: false, batch: { status: 'aborted' } })
    const third = await prepare()
    expect(await operations.service.abort(second)).toMatchObject({ writeFrozen: true, activeBatchId: third, batch: { status: 'aborted' } })
  })

  it('prepare 等在途源写提交，清单和后续检查点包含最后一次写入', async () => {
    const result = await raceAgainstHeldLock(database, {
      hold: async client => client.query('UPDATE document_contents SET raw_bytes=raw_bytes WHERE document_id=$1', [sources[0]!.id]),
      request: async () => operations.service.prepare('next'),
      change: async client => client.query('UPDATE documents SET title=$2 WHERE id=$1', [sources[0]!.id, '在途最后标题']),
    })
    await operations.service.resume(result.batch!.id, 2)
    const row = await database.query(async client => (await client.query<{ title: string }>('SELECT title FROM document_checkpoints WHERE event_id=$1 AND source_document_id=$2', [result.batch!.id, sources[0]!.id])).rows[0])
    expect(row).toEqual({ title: '在途最后标题' })
  })

  it('源正文缺失时整份 prepare 回滚，不留下半清单或冻结', async () => {
    await database.query(async client => client.query('DELETE FROM document_contents WHERE document_id=$1', [sources[0]!.id]))
    await expect(operations.service.prepare('next')).rejects.toMatchObject({ code: 'source_incomplete' })
    expect(await operations.service.status()).toEqual({ batch: null, activeBatchId: null, writeFrozen: false })
    expect(await database.query(async client => (await client.query<{ id: string }>('SELECT id FROM document_upgrade_batches')).rows)).toEqual([])
  })

  it('prepare 审计后故障一起回滚；ready 审计后故障回滚当前批并记录 failed，保持冻结可接续', async () => {
    // eslint-disable-next-line ts/unbound-method -- 故障/信号注入仍通过 apply(this) 调用真实实例的方法，不改变接收者。
    const record = AuditService.prototype.record
    const failing = vi.spyOn(AuditService.prototype, 'record').mockImplementationOnce(async function (this: AuditService, ...args) {
      await record.apply(this, args)
      throw new Error('prepare 审计提交前故障')
    })
    await expect(operations.service.prepare('next')).rejects.toThrow()
    expect(await operations.service.status()).toMatchObject({ batch: null, writeFrozen: false })
    failing.mockRestore()
    const id = await prepare()
    vi.spyOn(AuditService.prototype, 'record').mockImplementation(async function (this: AuditService, ...args) {
      await record.apply(this, args)
      if (args[0].action === 'documents.upgrade_ready')
        throw new Error('ready 审计提交前故障')
    })
    await expect(operations.service.resume(id, 3)).rejects.toThrow()
    expect(await operations.service.status(id)).toMatchObject({ writeFrozen: true, batch: { status: 'failed', failureCode: 'database_failure', completedCount: 0 } })
    vi.restoreAllMocks()
    expect(await operations.service.resume(id, 1)).toMatchObject({ writeFrozen: true, batch: { status: 'ready', completedCount: 3, failureCode: null } })
  })

  it('过期回执不能凭旧 ready 释放；到期检查点按同事件重新捕获，失效回执可接续', async () => {
    const id = await prepare()
    await operations.service.resume(id, 2)
    // 用真实 S1 捕获 31 天前的不可变检查点，替换本测试的完成回执；不改 UPDATE 守卫。
    await database.query(async client => client.query('DELETE FROM document_checkpoints WHERE event_id=$1', [id]))
    vi.spyOn(app.runtime.get(DocumentCheckpointClock), 'now').mockResolvedValue(new Date(Date.now() - 31 * 86400_000))
    await app.runtime.get(TransactionRunner).run(async (tx) => {
      for (const source of sources) {
        await app.runtime.get(DocumentsRepository).lockById(source.id, tx)
        await app.runtime.get(DocumentCheckpointService).captureOperation(source.id, 'before_upgrade', id, tx)
      }
    })
    await database.query(async client => client.query(`UPDATE document_upgrade_sources s SET checkpoint_id=p.id
      FROM document_checkpoints p WHERE p.event_id=s.batch_id AND p.source_document_id=s.document_id AND s.batch_id=$1`, [id]))
    await expect(operations.service.release(id)).rejects.toMatchObject({ code: 'checkpoint_incomplete' })
    expect(await operations.service.status(id)).toMatchObject({ writeFrozen: true, batch: { completedCount: 0 } })
    const result = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT id FROM document_checkpoints WHERE event_id=$1 AND source_document_id=$2 FOR UPDATE', [id, sources[0]!.id]),
      request: async () => operations.service.resume(id, 2),
      // 模拟 expiry 的 CP → 回执 FK SET NULL 顺序。resume 若反向先锁回执，这里就会形成死锁。
      change: async client => client.query('DELETE FROM document_checkpoints WHERE event_id=$1 AND source_document_id=$2', [id, sources[0]!.id]),
    })
    expect(result).toMatchObject({ batch: { status: 'ready', completedCount: 3 } })
    expect(await operations.service.release(id)).toMatchObject({ writeFrozen: false, batch: { status: 'released' } })
  })

  it('旧 ready 在本次扫描与最终计数之间刚好过期，必须继续补捕，不能返回 ready/0', async () => {
    const start = new Date('2026-10-22T00:00:00Z')
    const deadline = new Date(start.getTime() + 30 * 86400_000)
    const clock = vi.spyOn(DatabaseDocumentCheckpointClock.prototype, 'now').mockResolvedValue(start)
    const id = await prepare()
    await operations.service.resume(id, 3)
    let calls = 0
    clock.mockImplementation(async () => ++calls === 1 ? new Date(deadline.getTime() - 1) : deadline)
    expect(await operations.service.resume(id, 3)).toMatchObject({ writeFrozen: true, batch: { status: 'ready', completedCount: 3 } })
    const dates = await database.query(async client => (await client.query<{ created_at: Date }>('SELECT created_at FROM document_checkpoints WHERE event_id=$1', [id])).rows)
    expect(dates).toHaveLength(3)
    expect(dates.every(row => row.created_at.getTime() === deadline.getTime())).toBe(true)
  })

  it('release 完成审计期间才到期，也不能提交解冻或伪造完整回执', async () => {
    let at = new Date('2026-10-22T00:00:00Z')
    vi.spyOn(DatabaseDocumentCheckpointClock.prototype, 'now').mockImplementation(async () => at)
    const id = await prepare()
    await operations.service.resume(id, 3)
    // eslint-disable-next-line ts/unbound-method -- 故障/信号注入仍通过 apply(this) 调用真实实例的方法，不改变接收者。
    const record = AuditService.prototype.record
    vi.spyOn(AuditService.prototype, 'record').mockImplementation(async function (this: AuditService, ...args) {
      await record.apply(this, args)
      if (args[0].action === 'documents.upgrade_released')
        at = new Date(at.getTime() + 30 * 86400_000)
    })
    await expect(operations.service.release(id)).rejects.toMatchObject({ code: 'checkpoint_incomplete' })
    expect(await operations.service.status(id)).toMatchObject({ writeFrozen: true, batch: { status: 'ready', completedCount: 0 } })
    expect(await auditActions(id)).not.toContain('documents.upgrade_released')
  })

  it('prepare/ready 已提交但回执丢失，只凭持久状态接续，不新建批次或把已完成批次写成失败', async () => {
    // eslint-disable-next-line ts/unbound-method -- 故障/信号注入仍通过 apply(this) 调用真实实例的方法，不改变接收者。
    const run = TransactionRunner.prototype.run
    vi.spyOn(TransactionRunner.prototype, 'run').mockImplementationOnce(async function (this: TransactionRunner, ...args) {
      await run.apply(this, args)
      throw new Error('提交后的回执丢失')
    })
    await expect(operations.service.prepare('next')).rejects.toThrow('提交后的回执丢失')
    const id = (await operations.service.status()).batch!.id
    await expect(operations.service.prepare('next')).rejects.toMatchObject({ code: 'batch_active' })
    vi.spyOn(TransactionRunner.prototype, 'run').mockImplementationOnce(async function (this: TransactionRunner, ...args) {
      await run.apply(this, args)
      throw new Error('ready 提交后的回执丢失')
    })
    await expect(operations.service.resume(id, 3)).rejects.toThrow('ready 提交后的回执丢失')
    expect(await operations.service.status(id)).toMatchObject({ writeFrozen: true, batch: { status: 'ready', completedCount: 3 } })
    expect((await auditActions(id)).filter(action => action === 'documents.upgrade_failed')).toEqual([])
  })

  it('完成审计在途时 release 等完整短批提交，随后才解除冻结', async () => {
    const id = await prepare()
    const results = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'upgrade-audit-gate:documents.upgrade_ready\',0))'),
      waiting: 2,
      request: async ({ step, waitForWaiting }) => {
        const resumed = step(operations.service.resume(id, 3))
        await waitForWaiting(1)
        const released = step(operations.service.release(id))
        return Promise.all([resumed, released])
      },
      change: async () => {},
    })
    expect(results[0]).toMatchObject({ writeFrozen: true, batch: { status: 'ready', completedCount: 3 } })
    expect(results[1]).toMatchObject({ writeFrozen: false, batch: { status: 'released', completedCount: 3 } })
  })

  it('冻结清单被外部改错时拒绝捕获并记有限失败原因；明确放弃后保留既有检查点', async () => {
    const id = await prepare()
    const controller = new AbortController()
    controller.abort()
    expect(await operations.service.resume(id, 1, controller.signal)).toMatchObject({ interrupted: true, writeFrozen: true, batch: { completedCount: 0 } })
    await database.query(async client => client.query('UPDATE document_upgrade_sources SET revision=revision+1 WHERE batch_id=$1', [id]))
    await expect(operations.service.resume(id, 1)).rejects.toMatchObject({ code: 'source_changed' })
    expect(await operations.service.status(id)).toMatchObject({ writeFrozen: true, batch: { status: 'failed', failureCode: 'source_changed' } })
    await database.query(async client => client.query('UPDATE document_upgrade_sources SET revision=revision-1 WHERE batch_id=$1', [id]))
    await operations.service.resume(id, 3)
    expect(await operations.service.abort(id)).toMatchObject({ writeFrozen: false, batch: { status: 'aborted', completedCount: 3 } })
  })

  it('空库也须显式完成并释放；非法服务参数不建立批次', async () => {
    await expect(operations.service.prepare('bad\n')).rejects.toMatchObject({ code: 'target_invalid' })
    await expect(operations.service.resume(randomUUID(), 101)).rejects.toMatchObject({ code: 'batch_size_invalid' })
    await expect(operations.service.status('bad')).rejects.toMatchObject({ code: 'batch_id_invalid' })
    await database.query(async client => client.query('DELETE FROM documents'))
    const id = await prepare()
    expect(await operations.service.resume(id, 1)).toMatchObject({ writeFrozen: true, batch: { status: 'ready', sourceCount: 0, completedCount: 0 } })
    expect(await operations.service.release(id)).toMatchObject({ writeFrozen: false })
  })
})
