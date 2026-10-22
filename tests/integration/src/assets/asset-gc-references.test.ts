import type { AssetUploadActor } from '@nerve-office/api'
import type { Buffer } from 'node:buffer'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { TransactionRunner } from '@nerve-office/api'
import { AssetGcClock, AssetGcService, AssetUploadService, DocumentAssetRetentionService, DocumentCheckpointClock, DocumentCheckpointService, DocumentsRepository } from '@nerve-office/api/testing'
import { createdDocumentSchema } from '@nerve-office/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createAssetActor } from '../support/assets.ts'
import { createTestDatabase } from '../support/database.ts'
import { captureHistory } from '../support/document-history.ts'
import { seedDocument } from '../support/documents.ts'
import { completesWithoutWaiting, whileHolding } from '../support/held-lock.ts'
import { invariantViolations } from '../support/invariants.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

const START = Date.parse('2026-12-01T10:20:30.123Z')
const DAY = 86_400_000
let database: TestDatabase
let app: TestApp
let owner: TestAccount
let session: LoggedIn
let actor: AssetUploadActor
let input: Buffer
let at: Date
beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  owner = await createAccount(database, { username: 'asset-gc-reference-owner' })
  session = await login(app.baseUrl, owner.username, owner.password)
  actor = await createAssetActor(database, owner.id)
  input = await readFile(new URL('../../../../apps/api/src/modules/assets/testdata/minimum.png', import.meta.url))
})
beforeEach(async () => {
  await database.query(async (client) => {
    await client.query('DELETE FROM document_checkpoints')
    await client.query('DELETE FROM documents')
    await client.query('DELETE FROM trash_entries')
    await client.query('TRUNCATE document_asset_links, document_checkpoint_assets, asset_reference_activity, assets, asset_objects, asset_object_claims, asset_quota CASCADE')
  })
  at = new Date(START)
  vi.spyOn(app.runtime.get(AssetGcClock), 'now').mockImplementation(async () => at)
  vi.spyOn(app.runtime.get(DocumentCheckpointClock), 'now').mockImplementation(async () => at)
})
afterEach(async () => {
  vi.restoreAllMocks()
  expect(await database.query(invariantViolations)).toEqual([])
})
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

async function asset(age = 25 * 3600_000) {
  const uploaded = await app.runtime.get(AssetUploadService).upload(actor, async () => ({ data: input, mimeType: 'image/png', extension: 'png' }), new AbortController().signal)
  await database.query(async client => client.query('UPDATE assets SET created_at=$2 WHERE id=$1', [uploaded.assetId, new Date(at.getTime() - age)]))
  return uploaded.assetId
}
async function document(spaceId = owner.personalSpaceId) {
  return seedDocument(database, { spaceId, createdBy: owner.id, title: '资源保留判定' })
}
async function link(documentId: string, assetId: string) {
  await database.query(async client => client.query('INSERT INTO document_asset_links(document_id,asset_id) VALUES ($1,$2)', [documentId, assetId]))
}
async function scan(limit = 100, after?: string) {
  const gc = app.runtime.get(AssetGcService)
  const through = await gc.assetUpperBound()
  if (through === undefined)
    throw new Error('此用例需要已有资源')
  return gc.scanAssets(app.runtime.get(DocumentAssetRetentionService), { through, limit, ...(after === undefined ? {} : { after }) })
}
async function since(id: string) {
  return database.query(async client => (await client.query<{ since: Date | null }>('SELECT unreferenced_at AS since FROM assets WHERE id=$1', [id])).rows[0]!.since)
}
async function activityCount() {
  return database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM asset_reference_activity')).rows[0]!.count)
}
function gate() {
  let open!: () => void
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

describe('资源保留候选与引用活动', () => {
  it('从观察到无引用时开始计时，不用旧上传日期，上传窗口的精确边界仍保留', async () => {
    const old = await asset(100 * DAY)
    const young = await asset(DAY - 1)
    const boundary = await asset(DAY)
    expect(await scan()).toMatchObject({ scanned: 3, marked: 2, reset: 0 })
    expect(await since(old)).toEqual(at)
    expect(await since(boundary)).toEqual(at)
    expect(await since(young)).toBeNull()
    at = new Date(START + 1)
    expect(await scan()).toMatchObject({ marked: 1 })
    expect(await since(old)).toEqual(new Date(START))
    expect(await since(young)).toEqual(at)
  })

  it('当前、历史、两种运维与到期未清关系都保留；不按现在的可读权限判定', async () => {
    const ids: string[] = []
    for (const kind of ['current', 'hourly', 'before_delete', 'before_upgrade', 'expired'] as const) {
      const id = await asset()
      const doc = await document()
      ids.push(id)
      await link(doc.id, id)
      if (kind === 'hourly' || kind === 'expired') {
        if (kind === 'expired')
          at = new Date(START - 40 * DAY)
        await captureHistory(app, doc.id)
        at = new Date(START)
      }
      else if (kind !== 'current') {
        await app.runtime.get(TransactionRunner).run(async (tx) => {
          await app.runtime.get(DocumentsRepository).lockById(doc.id, tx)
          await app.runtime.get(DocumentCheckpointService).captureOperation(doc.id, kind, randomUUID(), tx)
        })
      }
      if (kind !== 'current')
        await database.query(async client => client.query('DELETE FROM document_asset_links WHERE document_id=$1', [doc.id]))
    }
    const archivedSpace = await createTeamSpace(database, { name: '不可见的归档团队', createdBy: owner.id, status: 'archived' })
    const archived = await asset()
    ids.push(archived)
    await link((await document(archivedSpace)).id, archived)
    expect(await scan()).toMatchObject({ scanned: 6, marked: 0 })
    for (const id of ids)
      expect(await since(id)).toBeNull()
    expect(await activityCount()).toBe(0)
  })

  it('同一事务多次新建又移除引用仍重新计时，活动消费与候选更新时间一起提交', async () => {
    const id = await asset()
    const first = await document()
    const second = await document()
    await scan()
    await database.query(async (client) => {
      await client.query('BEGIN')
      await client.query('INSERT INTO document_asset_links(document_id,asset_id) VALUES ($1,$3),($2,$3)', [first.id, second.id, id])
      await client.query('DELETE FROM document_asset_links WHERE asset_id=$1', [id])
      await client.query('COMMIT')
    })
    expect(await activityCount()).toBe(1)
    at = new Date(START + 10)
    expect(await scan()).toMatchObject({ marked: 1 })
    expect(await since(id)).toEqual(at)
    expect(await activityCount()).toBe(0)
  })

  it('正式复制后删除源文档，以及副本进入回收站后，图片仍受保留', async () => {
    const id = await asset()
    const source = await document()
    await link(source.id, id)
    const response = await asUser(app.baseUrl, session, `/api/documents/${source.id}/copy`, {
      method: 'POST',
      body: { requestId: randomUUID(), spaceId: owner.personalSpaceId },
    })
    expect(response.status).toBe(201)
    const copy = createdDocumentSchema.parse(await response.json())
    await database.query(async client => client.query('DELETE FROM documents WHERE id=$1', [source.id]))
    expect(await scan()).toMatchObject({ scanned: 1, marked: 0 })
    const trashed = await asUser(app.baseUrl, session, `/api/documents/${copy.id}`, { method: 'DELETE' })
    expect(trashed.status).toBe(204)
    await trashed.arrayBuffer()
    expect(await database.query(async client => (await client.query<{ status: string }>('SELECT status FROM documents WHERE id=$1', [copy.id])).rows)).toEqual([{ status: 'trashed' }])
    expect(await scan()).toMatchObject({ scanned: 1, marked: 0 })
    expect(await since(id)).toBeNull()
  })

  it('替换关系的 assetId 记录新资源活动，同值更新不制造新的使用记录', async () => {
    const old = await asset()
    const next = await asset()
    const doc = await document()
    await link(doc.id, old)
    await scan()
    await database.query(async client => client.query('UPDATE document_asset_links SET asset_id=asset_id WHERE document_id=$1', [doc.id]))
    expect(await activityCount()).toBe(0)
    await database.query(async client => client.query('UPDATE document_asset_links SET asset_id=$2 WHERE document_id=$1', [doc.id, next]))
    expect(await activityCount()).toBe(1)
    at = new Date(START + 10)
    expect(await scan()).toMatchObject({ marked: 1, reset: 1 })
    expect(await since(old)).toEqual(at)
    expect(await since(next)).toBeNull()
  })

  it('回收先锁住资源时，新引用等待提交；随后记录活动并清空旧候选', async () => {
    const id = await asset()
    const doc = await document()
    const entered = gate()
    const resume = gate()
    const probe = app.runtime.get(DocumentAssetRetentionService)
    const retained = probe.retained.bind(probe)
    vi.spyOn(probe, 'retained').mockImplementationOnce(async (...args) => {
      entered.open()
      await resume.wait
      return retained(...args)
    })
    const scanning = scan()
    let referencing: Promise<void> | undefined
    try {
      await Promise.race([entered.wait, scanning.then(() => {
        throw new Error('扫描未进入保留核对就结束')
      })])
      referencing = link(doc.id, id)
      expect(await completesWithoutWaiting(database, referencing, 1)).toBe(false)
      resume.open()
      expect(await scanning).toMatchObject({ marked: 1 })
      await referencing
      expect(await since(id)).toEqual(at)
      expect(await activityCount()).toBe(1)
      expect(await scan()).toMatchObject({ reset: 1 })
      expect(await since(id)).toBeNull()
    }
    finally {
      resume.open()
      await Promise.allSettled([scanning, referencing])
    }
  })

  it('两个多文档捕获按相反资源顺序交错时，不把共享资源锁升级成死锁', async () => {
    const ids = [await asset(), await asset()]
    const docs = []
    for (const id of [ids[0]!, ids[1]!, ids[1]!, ids[0]!]) {
      const doc = await document()
      await link(doc.id, id)
      docs.push(doc.id)
    }
    await scan()
    const entered = [gate(), gate()]
    const resume = gate()
    const jobs = [[docs[0]!, docs[1]!], [docs[2]!, docs[3]!]].map(async (pair, index) => app.runtime.get(TransactionRunner).run(async (tx) => {
      for (const id of [...pair].sort())
        await app.runtime.get(DocumentsRepository).lockById(id, tx)
      await app.runtime.get(DocumentCheckpointService).captureOperation(pair[0]!, 'before_upgrade', randomUUID(), tx)
      entered[index]!.open()
      await resume.wait
      await app.runtime.get(DocumentCheckpointService).captureOperation(pair[1]!, 'before_upgrade', randomUUID(), tx)
    }))
    try {
      await Promise.race([
        Promise.all(entered.map(async item => item.wait)),
        Promise.race(jobs).then(() => { throw new Error('批量捕获未到交错点就结束') }),
      ])
      resume.open()
      await Promise.all(jobs)
      expect(await activityCount()).toBe(4)
      await database.query(async client => client.query('DELETE FROM document_asset_links'))
      expect(await scan()).toMatchObject({ scanned: 2, marked: 0 })
      expect(await activityCount()).toBe(0)
    }
    finally {
      resume.open()
      await Promise.allSettled(jobs)
    }
  })

  it('回滚的引用不重置候选；后来持久存在的新引用清空候选', async () => {
    const id = await asset()
    const doc = await document()
    await scan()
    await database.query(async (client) => {
      await client.query('BEGIN')
      await client.query('INSERT INTO document_asset_links(document_id,asset_id) VALUES ($1,$2)', [doc.id, id])
      await client.query('ROLLBACK')
    })
    at = new Date(START + 10)
    await scan()
    expect(await since(id)).toEqual(new Date(START))
    expect(await activityCount()).toBe(0)
    await link(doc.id, id)
    expect(await scan()).toMatchObject({ reset: 1 })
    expect(await since(id)).toBeNull()
  })

  it('每页有界并按稳定游标推进；已被引用方持共享锁的资源留待下轮', async () => {
    const ids = [await asset(), await asset(), await asset()].sort()
    const first = await scan(1)
    expect(first).toMatchObject({ scanned: 1, lastId: ids[0] })
    expect(await scan(1, first.lastId)).toMatchObject({ scanned: 1, lastId: ids[1] })
    await whileHolding(database, async client => client.query('SELECT id FROM assets WHERE id=$1 FOR SHARE', [ids[2]]), async () => {
      expect(await scan(1, ids[1])).toMatchObject({ scanned: 0 })
    })
    expect(await since(ids[2]!)).toBeNull()
    expect(await scan(1, ids[1])).toMatchObject({ scanned: 1, lastId: ids[2] })
    for (const limit of [0, 1001, 1.5])
      await expect(scan(limit)).rejects.toThrow()
  })

  it('数据库旧 RR 快照不能在候选更新后取得过期的资产共享锁', async () => {
    const id = await asset()
    await database.query(async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      try {
        await client.query('SELECT id FROM assets WHERE id=$1', [id])
        await scan()
        await expect(client.query('SELECT id FROM assets WHERE id=$1 FOR SHARE', [id])).rejects.toMatchObject({ code: '40001' })
      }
      finally {
        await client.query('ROLLBACK')
      }
    })
  })

  it('保留核对期间最后引用被删除时，从核对后的新时刻开始宽限', async () => {
    const id = await asset()
    await link((await document()).id, id)
    const probe = app.runtime.get(DocumentAssetRetentionService)
    const retained = probe.retained.bind(probe)
    vi.spyOn(probe, 'retained').mockImplementationOnce(async (...args) => {
      await database.query(async client => client.query('DELETE FROM document_asset_links WHERE asset_id=$1', [id]))
      at = new Date(START + 5000)
      return retained(...args)
    })
    await scan()
    expect(await since(id)).toEqual(new Date(START + 5000))
  })

  it('活动消费失败使候选变化一起回滚，下次仍重新计算完整宽限', async () => {
    const id = await asset()
    const doc = await document()
    await scan()
    await link(doc.id, id)
    await database.query(async (client) => {
      await client.query('DELETE FROM document_asset_links WHERE asset_id=$1', [id])
      await client.query('CREATE FUNCTION reject_activity_consume() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'controlled consume failure\'; END $$')
      await client.query('CREATE TRIGGER reject_activity_consume BEFORE DELETE ON asset_reference_activity FOR EACH ROW EXECUTE FUNCTION reject_activity_consume()')
    })
    at = new Date(START + 100)
    try {
      await expect(scan()).rejects.toThrow()
      expect(await since(id)).toEqual(new Date(START))
      expect(await activityCount()).toBe(1)
    }
    finally {
      await database.query(async (client) => {
        await client.query('DROP TRIGGER reject_activity_consume ON asset_reference_activity')
        await client.query('DROP FUNCTION reject_activity_consume()')
      })
    }
    await scan()
    expect(await since(id)).toEqual(at)
    expect(await activityCount()).toBe(0)
  })
})
