import type { TestAccount } from '../support/accounts.ts'
import type { ApiProcess } from '../support/api-process.ts'
import type { TestDatabase } from '../support/database.ts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { testEnvironment } from '../support/api-app.ts'
import { startApiProcess } from '../support/api-process.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { raceAgainstHeldLock, whileHolding } from '../support/held-lock.ts'

let database: TestDatabase
let owner: TestAccount
let ids: string[]
const processes: ApiProcess[] = []
beforeAll(async () => {
  database = await createTestDatabase()
  owner = await createAccount(database, { username: 'checkpoint-cli-owner' })
  // 只在此隔离测试库暂停第二份检查点的 INSERT；真实进程会在已提交第一短批之后停在这一把锁上。
  await database.query(async client => client.query(`CREATE TABLE checkpoint_process_gate (document_id uuid PRIMARY KEY);
    CREATE FUNCTION checkpoint_process_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM checkpoint_process_gate WHERE document_id=NEW.source_document_id) THEN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('checkpoint-process-gate',0));
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER checkpoint_process_gate BEFORE INSERT ON document_checkpoints FOR EACH ROW EXECUTE FUNCTION checkpoint_process_gate();`))
})
beforeEach(async () => {
  ids = []
  for (let i = 0; i < 3; i++)
    ids.push((await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: `CLI 原件 ${i}` })).id)
  ids.sort()
})
afterEach(async () => {
  for (const process of processes)
    process.kill('SIGKILL')
  await Promise.all(processes.map(async process => process.exited))
  await database.query(async (client) => {
    await client.query('DELETE FROM checkpoint_process_gate')
    await client.query('UPDATE document_upgrade_barrier SET active_batch_id=NULL')
    await client.query('DELETE FROM document_upgrade_batches')
    await client.query('DELETE FROM document_checkpoints')
    await client.query('DELETE FROM documents')
  })
})
afterAll(async () => database?.drop())

function run(args: readonly string[]) {
  // 三个 Job 的默认开关也保持 true；窄 CLI 不组装 Jobs，因此不会启动它们。
  const process = startApiProcess(testEnvironment(database.url, { NERVE_TRASH_PURGE_ENABLED: 'true', NERVE_REVISION_PURGE_ENABLED: 'true', NERVE_HISTORY_PURGE_ENABLED: 'true' }), 'document-checkpoints', { args })
  processes.push(process)
  return process
}

async function receipt(args: readonly string[]) {
  const process = run(args)
  expect(await process.exited, process.output()).toEqual({ code: 0, signal: null })
  const value: unknown = JSON.parse(process.stdout())
  expect(process.stdout().trim().split('\n')).toHaveLength(1)
  expect(process.output()).not.toContain(database.url)
  expect(process.output()).not.toContain('JobsModule')
  expect(process.output()).not.toContain('SnapshotInspector')
  expect(process.output()).not.toContain('ImageRunner')
  expect(process.output()).not.toContain('已监听')
  return value as { batch: { id: string, status: string, sourceCount: number, completedCount: number }, writeFrozen: boolean }
}

describe('US-M5-11 升级检查点真实进程', () => {
  it('五种命令跨进程读同一持久批次；stdout 只有 JSON，无 HTTP、Jobs 或图片进程', async () => {
    const prepared = await receipt(['prepare', '--target', 'univer@next'])
    expect(prepared).toMatchObject({ writeFrozen: true, batch: { status: 'preparing', sourceCount: 3, completedCount: 0 } })
    const id = prepared.batch.id
    expect(await receipt(['status'])).toEqual(prepared)
    const failedRelease = run(['release', '--batch', id])
    expect((await failedRelease.exited).code).toBe(1)
    expect(JSON.parse(failedRelease.stdout())).toEqual({ error: 'not_ready' })
    expect(await receipt(['resume', '--batch', id, '--batch-size', '1'])).toMatchObject({ writeFrozen: true, batch: { status: 'ready', completedCount: 3 } })
    expect(await receipt(['release', '--batch', id])).toMatchObject({ writeFrozen: false, batch: { status: 'released' } })
    const other = await receipt(['prepare', '--target', 'cancelled'])
    expect(await receipt(['abort', '--batch', other.batch.id])).toMatchObject({ writeFrozen: false, batch: { status: 'aborted', completedCount: 0 } })
  })

  it.each(['SIGKILL', 'SIGTERM'] as const)('%s 在第二个短批持锁时到来；首批保留、当前批按语义回滚或提交，异进程继续', async (signal) => {
    const id = (await receipt(['prepare', '--target', 'restartable'])).batch.id
    await database.query(async client => client.query('INSERT INTO checkpoint_process_gate (document_id) VALUES ($1)', [ids[1]]))
    let child: ApiProcess | undefined
    let committed: string | undefined
    const rememberFirst = async () => {
      const partial = await database.query(async client => (await client.query<{ id: string }>('SELECT id FROM document_checkpoints WHERE event_id=$1 ORDER BY id', [id])).rows)
      expect(partial).toHaveLength(1)
      committed = partial[0]!.id
    }
    if (signal === 'SIGTERM') {
      const result = await raceAgainstHeldLock(database, {
        hold: async client => client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'checkpoint-process-gate\',0))'),
        request: async () => {
          child = run(['resume', '--batch', id, '--batch-size', '1'])
          return child.exited
        },
        change: async () => {
          await rememberFirst()
          child!.kill('SIGTERM')
          await child!.waitForLog(entry => String(entry.msg).includes('收到退出信号'))
        },
      })
      expect(result).toEqual({ code: 1, signal: null })
      expect(JSON.parse(child!.stdout())).toMatchObject({ writeFrozen: true, interrupted: true, batch: { completedCount: 2 } })
    }
    else {
      await whileHolding(database, async client => client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'checkpoint-process-gate\',0))'), async () => {
        const killed = run(['resume', '--batch', id, '--batch-size', '1'])
        await expect.poll(async () => database.query(async client => (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name=\'nerve-office-api\' AND cardinality(pg_blocking_pids(pid))>0')).rows[0]!.n)).toBe(1)
        await rememberFirst()
        killed.kill('SIGKILL')
        expect(await killed.exited).toEqual({ code: null, signal: 'SIGKILL' })
      })
      expect(await receipt(['status', '--batch', id])).toMatchObject({ writeFrozen: true, batch: { completedCount: 1, status: 'preparing' } })
    }
    await database.query(async client => client.query('DELETE FROM checkpoint_process_gate'))
    expect(await receipt(['resume', '--batch', id, '--batch-size', '1'])).toMatchObject({ writeFrozen: true, batch: { status: 'ready', completedCount: 3 } })
    expect(await database.query(async client => (await client.query<{ id: string }>('SELECT id FROM document_checkpoints WHERE id=$1', [committed])).rows)).toEqual([{ id: committed }])
  })

  it('非法用法退出 2，不回显误传参数，也不改动屏障', async () => {
    const command = run(['prepare', '--target', 'bad secret\n'])
    expect((await command.exited).code).toBe(2)
    expect(command.stdout()).toBe('')
    expect(command.output()).not.toContain('bad secret')
    expect(await receipt(['status'])).toMatchObject({ batch: null, writeFrozen: false })
  })
})
