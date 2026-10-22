import type { TestAccount } from '../support/accounts.ts'
import type { TestDatabase } from '../support/database.ts'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { raceAgainstHeldLock, whileHolding } from '../support/held-lock.ts'

const LOCK = 'nerve-office:document-upgrade-writes'
let database: TestDatabase
let owner: TestAccount
let documentId: string
beforeAll(async () => {
  database = await createTestDatabase()
  owner = await createAccount(database, { username: 'upgrade-barrier-owner' })
  documentId = (await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '升级冻结源' })).id
})
afterEach(async () => {
  await database.query(async (client) => {
    await client.query('INSERT INTO document_upgrade_barrier (id) VALUES (1) ON CONFLICT DO NOTHING')
    await client.query('UPDATE document_upgrade_barrier SET active_batch_id=NULL WHERE id=1')
    await client.query('DELETE FROM document_upgrade_batches')
  })
})
afterAll(async () => database?.drop())

async function freeze() {
  const id = randomUUID()
  await database.query(async (client) => {
    await client.query('BEGIN')
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [LOCK])
      await client.query('INSERT INTO document_upgrade_batches (id,target_version,source_count) VALUES ($1,$2,0)', [id, 'univer@0.21.0'])
      await client.query('UPDATE document_upgrade_barrier SET active_batch_id=$1 WHERE id=1', [id])
      await client.query('COMMIT')
    }
    finally {
      await client.query('ROLLBACK')
    }
  })
  return id
}

/** 即使旧实现意外放行，也回滚这个反例，不让它损坏后续夹具。 */
async function attempted(statement: string) {
  return database.query(async (client) => {
    await client.query('BEGIN')
    try {
      return await client.query(statement)
    }
    finally {
      await client.query('ROLLBACK')
    }
  })
}

describe('US-M5-11 升级写入屏障', () => {
  it('迁移建立唯一且默认开放的屏障行；缺行也拒绝源写入', async () => {
    const rows = await database.query(async client => (await client.query<{ id: number, active_batch_id: string | null }>('SELECT * FROM document_upgrade_barrier')).rows)
    expect(rows).toEqual([{ id: 1, active_batch_id: null }])
    await expect(attempted('INSERT INTO document_upgrade_barrier (id) VALUES (2)')).rejects.toMatchObject({ code: '23514' })
    await database.query(async client => client.query('DELETE FROM document_upgrade_barrier'))
    await expect(attempted('UPDATE document_contents SET raw_bytes=raw_bytes WHERE false')).rejects.toMatchObject({ code: '55P03' })
  })

  it.each([
    'INSERT INTO documents SELECT * FROM documents WHERE false',
    'DELETE FROM documents WHERE false',
    'TRUNCATE documents CASCADE',
    ...['id', 'title', 'type', 'unit_id', 'profile', 'format_version', 'sdk_version', 'client_build', 'revision', 'formulas_pending'].map(column => `UPDATE documents SET ${column}=${column} WHERE false`),
    ...['document_contents', 'document_asset_links', 'document_revisions'].flatMap(table => [
      `INSERT INTO ${table} SELECT * FROM ${table} WHERE false`,
      `DELETE FROM ${table} WHERE false`,
      `UPDATE ${table} SET document_id=document_id WHERE false`,
      `TRUNCATE ${table} CASCADE`,
    ]),
  ])('冻结后连零行语句也拒绝：%s', async (statement) => {
    await freeze()
    await expect(attempted(statement)).rejects.toMatchObject({ code: '55P03' })
  })

  it('冻结不妨碍读取、写入代次和权限撤销；解冻后源写恢复', async () => {
    await freeze()
    await database.query(async (client) => {
      expect((await client.query('SELECT snapshot FROM document_contents WHERE document_id=$1', [documentId])).rows).toHaveLength(1)
      expect((await client.query('UPDATE documents SET write_epoch=write_epoch+1,updated_at=now() WHERE id=$1 RETURNING id', [documentId])).rows).toHaveLength(1)
      await client.query('DELETE FROM document_grants WHERE document_id=$1', [documentId])
      await client.query('UPDATE document_upgrade_barrier SET active_batch_id=NULL WHERE id=1')
      await client.query('UPDATE documents SET title=$2 WHERE id=$1', [documentId, '解冻后标题'])
    })
  })

  it('已触发源写的事务先提交，冻结才能建立；不是只等元数据表', async () => {
    const batchId = await raceAgainstHeldLock(database, {
      hold: async client => client.query('UPDATE document_contents SET raw_bytes=raw_bytes WHERE document_id=$1', [documentId]),
      request: freeze,
      change: async client => client.query('UPDATE documents SET title=$2 WHERE id=$1', [documentId, '冻结前最后保存']),
    })
    const row = await database.query(async client => (await client.query<{ active_batch_id: string | null }>('SELECT active_batch_id FROM document_upgrade_barrier')).rows[0])
    expect(row).toEqual({ active_batch_id: batchId })
  })

  it('冻结前建立的旧 REPEATABLE READ 快照不能绕过；仍交出确定回滚的 55P03', async () => {
    await database.query(async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      try {
        expect((await client.query<{ active_batch_id: string | null }>('SELECT active_batch_id FROM document_upgrade_barrier')).rows[0]).toEqual({ active_batch_id: null })
        await freeze()
        await expect(client.query('UPDATE document_contents SET raw_bytes=raw_bytes WHERE false')).rejects.toMatchObject({ code: '55P03' })
      }
      finally {
        await client.query('ROLLBACK')
      }
    })
  })

  it('源写已拿文档业务锁时，全局独占锁竞争立即拒绝，不反向等待形成死锁', async () => {
    await database.query(async (client) => {
      await client.query('BEGIN')
      try {
        await client.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE', [documentId])
        await whileHolding(database, async holder => holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [LOCK]), async () => {
          // statement_timeout 是反例兜底：错误实现若等待独占锁，应报 57014 而不能伪装成 55P03。
          await client.query('SET LOCAL statement_timeout=\'1s\'')
          await expect(client.query('UPDATE documents SET title=title WHERE id=$1', [documentId])).rejects.toMatchObject({ code: '55P03' })
        })
      }
      finally {
        await client.query('ROLLBACK')
      }
    })
  })

  it.each(['', '-bad', '含中文', 'a b', 'x'.repeat(129)])('拒绝非法目标版本 %s', async (target) => {
    await expect(database.query(async client => client.query('INSERT INTO document_upgrade_batches (target_version,source_count) VALUES ($1,0)', [target]))).rejects.toMatchObject({ code: '23514' })
  })

  it.each([
    '\'unknown\',0,NULL,NULL',
    '\'preparing\',-1,NULL,NULL',
    '\'ready\',0,NULL,NULL',
    '\'released\',0,NULL,NULL',
    '\'preparing\',0,now(),NULL',
    '\'failed\',0,now(),\'database_failure\'',
    '\'failed\',0,NULL,NULL',
    '\'preparing\',0,NULL,\'database_failure\'',
    '\'failed\',0,NULL,\'unbounded_raw_error\'',
  ])('批次状态、完成时刻与有限失败原因不能互相矛盾：%s', async (values) => {
    await expect(attempted(`INSERT INTO document_upgrade_batches (target_version,status,source_count,completed_at,failure_code) VALUES ('test',${values})`)).rejects.toMatchObject({ code: '23514' })
  })
})
