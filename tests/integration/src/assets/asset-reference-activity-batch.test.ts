// 真实库的批量引用活动：调用次数随语句而非关系行数增长，事务与 GC 活动语义不变。
import type { Client } from 'pg'
import type { PassiveAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { AssetUploadService } from '@nerve-office/api/testing'
import pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createAssetActor } from '../support/assets.ts'
import { createTestDatabase } from '../support/database.ts'
import { captureHistory } from '../support/document-history.ts'
import { seedDocument } from '../support/documents.ts'

const RELATIONS = [
  { name: '当前', table: 'document_asset_links', parent: 'document_id', trigger: 'document_assets_note_reference' },
  { name: '检查点', table: 'document_checkpoint_assets', parent: 'checkpoint_id', trigger: 'checkpoint_assets_note_reference' },
] as const
type Relation = (typeof RELATIONS)[number]
interface Activity { assetId: string, transactionId: string }
interface TriggerCost { 'Trigger Name': string, 'Constraint Name'?: string, 'Relation': string, 'Time': number, 'Calls': number }
interface Explained { 'Triggers'?: TriggerCost[], 'Execution Time': number }

let database: TestDatabase
let app: TestApp
let owner: PassiveAccount
let originalAssetId: string
beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  owner = await createPassiveAccount(database, { username: 'activity-batch-owner' })
  const data = await readFile(new URL('../../../../apps/api/src/modules/assets/testdata/minimum.png', import.meta.url))
  const uploaded = await app.runtime.get(AssetUploadService).upload(await createAssetActor(database, owner.id), async () => ({ data, mimeType: 'image/png', extension: 'png' }), new AbortController().signal)
  originalAssetId = uploaded.assetId
})
afterAll(async () => {
  try {
    await app?.close()
  }
  finally {
    await database?.drop()
  }
})

async function transaction<T>(work: (client: Client, transactionId: string) => Promise<T>, commit = true): Promise<T> {
  return database.query(async (client) => {
    await client.query('BEGIN')
    try {
      const transactionId = (await client.query<{ id: string }>('SELECT pg_current_xact_id()::text AS id')).rows[0]!.id
      const result = await work(client, transactionId)
      await client.query(commit ? 'COMMIT' : 'ROLLBACK')
      return result
    }
    catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  })
}

/** 复用一次真实上传的对象，只有少量独立资源记录；配额与关系 FK 都保留。 */
async function assets(count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID()).sort()
  await transaction(async (client) => {
    await client.query(`INSERT INTO assets (id, uploader_id, object_hash)
      SELECT id, $2, (SELECT object_hash FROM assets WHERE id=$3) FROM unnest($1::uuid[]) AS requested(id)`, [ids, owner.id, originalAssetId])
    await client.query('UPDATE asset_quota SET used_assets=used_assets+$1 WHERE id=1', [count])
  })
  return ids
}

async function target(relation: Relation): Promise<string> {
  const document = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '引用活动小样例' })
  return relation.table === 'document_asset_links' ? document.id : captureHistory(app, document.id)
}

/** 表与列只取上面的固定两种关系，不接收业务输入。 */
function insertion(relation: Relation): string {
  return `INSERT INTO ${relation.table} (${relation.parent}, asset_id)
    SELECT $1::uuid, id FROM unnest($2::uuid[]) AS requested(id) ORDER BY id ON CONFLICT DO NOTHING`
}

async function insert(client: Client, relation: Relation, parent: string, ids: readonly string[]): Promise<string[]> {
  const result = await client.query<{ id: string }>(`${insertion(relation)} RETURNING asset_id AS id`, [parent, ids])
  return result.rows.map(row => row.id).sort()
}

async function activities(ids: readonly string[], client?: Client): Promise<Activity[]> {
  const read = async (connection: Client): Promise<Activity[]> => (await connection.query<Activity>(`SELECT asset_id AS "assetId", transaction_id::text AS "transactionId"
    FROM asset_reference_activity WHERE asset_id=ANY($1::uuid[]) ORDER BY asset_id, transaction_id`, [ids])).rows
  return client === undefined ? database.query(read) : read(client)
}

async function references(relation: Relation, parent: string): Promise<string[]> {
  return database.query(async client => (await client.query<{ id: string }>(`SELECT asset_id AS id FROM ${relation.table} WHERE ${relation.parent}=$1 ORDER BY asset_id`, [parent])).rows.map(row => row.id))
}

it.each(RELATIONS)('$name 256 条实际 INSERT 只调用一次活动触发器，保留全部资源和本事务活动', async (relation) => {
  const ids = await assets(256)
  const parent = await target(relation)
  const observed = await transaction(async (client, transactionId) => {
    const result = await client.query<{ 'QUERY PLAN': Explained[] }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${insertion(relation)}`, [parent, ids])
    return { transactionId, plan: result.rows[0]!['QUERY PLAN'][0]! }
  })
  expect(await references(relation, parent)).toEqual(ids)
  expect(await activities(ids)).toEqual(ids.map(assetId => ({ assetId, transactionId: observed.transactionId })))
  const triggers = observed.plan.Triggers ?? []
  const activity = triggers.filter(trigger => trigger['Trigger Name'] === relation.trigger)
  const foreignKeys = triggers.filter(trigger => trigger['Constraint Name'] !== undefined)
  // EXPLAIN 的外层 FK 与活动函数分别计量；活动函数内部的 FK 成本仍包含在函数时间内。
  process.stdout.write(`${JSON.stringify({ event: 'asset-reference-batch-plan', relation: relation.table, rows: ids.length, executionMs: observed.plan['Execution Time'], activity, foreignKeys })}\n`)
  expect(activity).toHaveLength(1)
  expect(foreignKeys.length).toBeGreaterThan(0)
  for (const trigger of [...activity, ...foreignKeys]) {
    expect(Number.isFinite(trigger.Time)).toBe(true)
    expect(trigger.Time).toBeGreaterThanOrEqual(0)
  }
  // 回归契约是数据库实际执行次数，不把本机/CI 的绝对运行时间当作断言。
  expect(activity[0]!.Calls).toBe(1)
})

it('同一事务跨当前与检查点、多语句和 savepoint 的同资源活动去重，回滚子事务不留下活动', async () => {
  const [first, second, rolledBack] = await assets(3)
  const current = await target(RELATIONS[0])
  const another = await target(RELATIONS[0])
  const checkpoint = await target(RELATIONS[1])
  const transactionId = await transaction(async (client, id) => {
    await insert(client, RELATIONS[0], current, [first!, second!])
    await client.query('SAVEPOINT activity_batch')
    await insert(client, RELATIONS[1], checkpoint, [first!, rolledBack!])
    await client.query('ROLLBACK TO SAVEPOINT activity_batch')
    await client.query('RELEASE SAVEPOINT activity_batch')
    await insert(client, RELATIONS[0], another, [first!])
    await insert(client, RELATIONS[1], checkpoint, [first!, second!])
    return id
  })
  expect(await activities([first!, second!, rolledBack!])).toEqual([
    { assetId: first, transactionId },
    { assetId: second, transactionId },
  ])
  expect(await references(RELATIONS[1], checkpoint)).toEqual([first, second])
})

it('不同事务引用同一资源各自保留数据库事务号，不合并成一条共享活动', async () => {
  const [id] = await assets(1)
  const current = await target(RELATIONS[0])
  const checkpoint = await target(RELATIONS[1])
  const first = await transaction(async (client, transactionId) => {
    await insert(client, RELATIONS[0], current, [id!])
    return transactionId
  })
  const second = await transaction(async (client, transactionId) => {
    await insert(client, RELATIONS[1], checkpoint, [id!])
    return transactionId
  })
  expect(second).not.toBe(first)
  expect(await activities([id!])).toEqual([{ assetId: id, transactionId: first }, { assetId: id, transactionId: second }])
})

it.each(RELATIONS)('$name 空 INSERT、全冲突与部分冲突只为实际新关系记录活动', async (relation) => {
  const [existing, added] = await assets(2)
  const parent = await target(relation)
  const first = await transaction(async (client, id) => {
    await insert(client, relation, parent, [existing!])
    return id
  })
  await transaction(async (client) => {
    expect(await insert(client, relation, parent, [])).toEqual([])
    expect(await insert(client, relation, parent, [existing!])).toEqual([])
  })
  expect(await activities([existing!, added!])).toEqual([{ assetId: existing, transactionId: first }])
  const second = await transaction(async (client, id) => {
    expect(await insert(client, relation, parent, [existing!, added!])).toEqual([added])
    return id
  })
  expect(await activities([existing!, added!])).toEqual([{ assetId: existing, transactionId: first }, { assetId: added, transactionId: second }])
})

it.each(RELATIONS)('$name 同事务 INSERT 后 DELETE 仍保留实际活动，让下一轮 GC 重算宽限', async (relation) => {
  const ids = await assets(2)
  const parent = await target(relation)
  const transactionId = await transaction(async (client, id) => {
    await insert(client, relation, parent, ids)
    await client.query(`DELETE FROM ${relation.table} WHERE ${relation.parent}=$1`, [parent])
    return id
  })
  expect(await references(relation, parent)).toEqual([])
  expect(await activities(ids)).toEqual(ids.map(assetId => ({ assetId, transactionId })))
})

it.each(RELATIONS)('$name 主动回滚同时撤销关系与活动', async (relation) => {
  const ids = await assets(2)
  const parent = await target(relation)
  await transaction(async (client, transactionId) => {
    await insert(client, relation, parent, ids)
    expect(await activities(ids, client)).toEqual(ids.map(assetId => ({ assetId, transactionId })))
  }, false)
  expect(await references(relation, parent)).toEqual([])
  expect(await activities(ids)).toEqual([])
})

it.each(RELATIONS)('$name 批内坏资源 FK 使本事务此前成功写入的关系与活动一起回滚', async (relation) => {
  const ids = await assets(2)
  const parent = await target(relation)
  await expect(transaction(async (client) => {
    await insert(client, relation, parent, [ids[0]!])
    await insert(client, relation, parent, [ids[1]!, randomUUID()])
  })).rejects.toMatchObject({ code: '23503' })
  expect(await references(relation, parent)).toEqual([])
  expect(await activities(ids)).toEqual([])
})

it.each(RELATIONS)('$name 活动 INSERT 自身失败时，外层批量关系与已经写入的活动一起回滚', async (relation) => {
  const ids = await assets(2)
  const parent = await target(relation)
  // 只在本文件的隔离库拒绝一个本用例新资源，不改变外层关系 FK 或生产触发器。
  await database.query(async client => client.query(`ALTER TABLE asset_reference_activity
    ADD CONSTRAINT test_activity_batch_reject CHECK (asset_id <> ${pg.escapeLiteral(ids[1]!)}::uuid)`))
  try {
    await expect(transaction(async (client) => {
      await insert(client, relation, parent, ids)
    })).rejects.toMatchObject({ code: '23514', constraint: 'test_activity_batch_reject' })
  }
  finally {
    await database.query(async client => client.query('ALTER TABLE asset_reference_activity DROP CONSTRAINT test_activity_batch_reject'))
  }
  expect(await references(relation, parent)).toEqual([])
  expect(await activities(ids)).toEqual([])
  const transactionId = await transaction(async (client, id) => {
    await insert(client, relation, parent, ids)
    return id
  })
  expect(await references(relation, parent)).toEqual(ids)
  expect(await activities(ids)).toEqual(ids.map(assetId => ({ assetId, transactionId })))
})

it.each(RELATIONS)('$name 同值 UPDATE 不记录新活动，实际更换 assetId 只记录新资源', async (relation) => {
  const [oldId, nextId] = await assets(2)
  const parent = await target(relation)
  const first = await transaction(async (client, id) => {
    await insert(client, relation, parent, [oldId!])
    return id
  })
  await transaction(async (client) => {
    await client.query(`UPDATE ${relation.table} SET asset_id=asset_id WHERE ${relation.parent}=$1`, [parent])
  })
  expect(await activities([oldId!, nextId!])).toEqual([{ assetId: oldId, transactionId: first }])
  const second = await transaction(async (client, id) => {
    await client.query(`UPDATE ${relation.table} SET asset_id=$2 WHERE ${relation.parent}=$1`, [parent, nextId])
    return id
  })
  expect(await references(relation, parent)).toEqual([nextId])
  expect(await activities([oldId!, nextId!])).toEqual([{ assetId: oldId, transactionId: first }, { assetId: nextId, transactionId: second }])
})

it.each(RELATIONS)('$name 混合 INSERT/DO UPDATE 区分实际新增、同值冲突与冲突后更换资源', async (relation) => {
  const [existing, added, changed] = await assets(3)
  const parent = await target(relation)
  const first = await transaction(async (client, id) => {
    await insert(client, relation, parent, [existing!])
    return id
  })
  const second = await transaction(async (client, id) => {
    await client.query(`INSERT INTO ${relation.table} (${relation.parent}, asset_id)
      SELECT $1::uuid, id FROM unnest($2::uuid[]) AS requested(id) ORDER BY id
      ON CONFLICT (${relation.parent}, asset_id) DO UPDATE SET asset_id=EXCLUDED.asset_id`, [parent, [existing, added]])
    return id
  })
  expect(await references(relation, parent)).toEqual([existing, added])
  expect(await activities([existing!, added!])).toEqual([{ assetId: existing, transactionId: first }, { assetId: added, transactionId: second }])
  const third = await transaction(async (client, id) => {
    await client.query(`INSERT INTO ${relation.table} (${relation.parent}, asset_id) VALUES ($1,$2)
      ON CONFLICT (${relation.parent}, asset_id) DO UPDATE SET asset_id=$3`, [parent, existing, changed])
    return id
  })
  expect(await references(relation, parent)).toEqual([added, changed])
  expect(await activities([existing!, added!, changed!])).toEqual([
    { assetId: existing, transactionId: first },
    { assetId: added, transactionId: second },
    { assetId: changed, transactionId: third },
  ])
})
