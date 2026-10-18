import type { AssetObjectMetadata, Database } from '@nerve-office/api/testing'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { createHash, randomUUID } from 'node:crypto'
import { TransactionRunner } from '@nerve-office/api'
import { AssetsRepository, DATABASE } from '@nerve-office/api/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { invariantViolations } from '../support/invariants.ts'

let database: TestDatabase
let app: TestApp
let repository: AssetsRepository
let transactions: TransactionRunner
let uploader: string
const quotas = { quotaBytes: 1000, quotaCount: 10 }
// 仓储只接收已处理的元数据；四格式字节另由真实 runner/HTTP 用例检查。
function image(label: string, bytes = 100): AssetObjectMetadata {
  return { sha256: createHash('sha256').update(label).digest('hex'), bytes, mimeType: 'image/png', width: 2, height: 3, frames: 1 }
}
const a = image('a')
const b = image('b', 200)

async function state() {
  return database.query(async (client) => {
    const quota = (await client.query<{ bytes: number, count: number }>('SELECT used_bytes::integer AS bytes, used_assets AS count FROM asset_quota')).rows[0] ?? { bytes: 0, count: 0 }
    const claims = (await client.query<{ sha256: string, bytes: number }>('SELECT sha256, bytes FROM asset_object_claims ORDER BY sha256')).rows
    const objects = (await client.query<{ sha256: string, bytes: number }>('SELECT sha256, bytes FROM asset_objects ORDER BY sha256')).rows
    const assets = (await client.query<{ id: string, uploader_id: string }>('SELECT id, uploader_id FROM assets ORDER BY id')).rows
    return { quota, claims, objects, assets }
  })
}

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  repository = new AssetsRepository(app.runtime.get<Database>(DATABASE))
  transactions = app.runtime.get(TransactionRunner)
  uploader = (await createPassiveAccount(database, { username: 'asset-quota-uploader' })).id
})
beforeEach(async () => {
  await database.query(async client => client.query('TRUNCATE document_asset_links, assets, asset_objects, asset_object_claims, asset_quota'))
})
afterEach(async () => {
  expect(await database.query(invariantViolations)).toEqual([])
})
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

describe('持久资源配额（真实 PostgreSQL）', () => {
  it('预留先提交字节；转正只移动占用，每次上传创建独立 ID', async () => {
    await transactions.run(async tx => repository.reserve(a, quotas, tx))
    expect(await state()).toEqual({ quota: { bytes: 100, count: 0 }, claims: [{ sha256: a.sha256, bytes: 100 }], objects: [], assets: [] })
    const first = randomUUID()
    await transactions.run(async tx => repository.finalize(first, uploader, a, quotas, tx))
    const second = randomUUID()
    await transactions.run(async tx => repository.reserve(a, quotas, tx))
    await transactions.run(async tx => repository.finalize(second, uploader, a, quotas, tx))
    const actual = await state()
    expect(actual.quota).toEqual({ bytes: 100, count: 2 })
    expect(actual.claims).toEqual([])
    expect(actual.objects).toEqual([{ sha256: a.sha256, bytes: 100 }])
    expect(actual.assets.map(row => row.id).sort()).toEqual([first, second].sort())
  })

  it('字节恰好到上限成立；新 hash 超限不留 claim；相同 hash 仍可新增记录', async () => {
    const limits = { ...quotas, quotaBytes: 100 }
    await transactions.run(async tx => repository.reserve(a, limits, tx))
    await transactions.run(async tx => repository.finalize(randomUUID(), uploader, a, limits, tx))
    await expect(transactions.run(async tx => repository.reserve(b, limits, tx))).rejects.toMatchObject({ code: 'ASSET_QUOTA_EXCEEDED', details: { kind: 'bytes' } })
    await transactions.run(async tx => repository.reserve(a, limits, tx))
    await transactions.run(async tx => repository.finalize(randomUUID(), uploader, a, limits, tx))
    expect((await state()).quota).toEqual({ bytes: 100, count: 2 })
  })

  it('记录配额同时约束预检与转正，竞争失败仍保留已提交的字节预留', async () => {
    const limits = { ...quotas, quotaCount: 1 }
    await transactions.run(async tx => repository.reserve(a, limits, tx))
    await transactions.run(async tx => repository.reserve(b, limits, tx))
    await transactions.run(async tx => repository.finalize(randomUUID(), uploader, a, limits, tx))
    await expect(transactions.run(async tx => repository.finalize(randomUUID(), uploader, b, limits, tx))).rejects.toMatchObject({ code: 'ASSET_QUOTA_EXCEEDED', details: { kind: 'count' } })
    await expect(transactions.run(async tx => repository.reserve(image('third'), limits, tx))).rejects.toMatchObject({ code: 'ASSET_QUOTA_EXCEEDED', details: { kind: 'count' } })
    expect((await state()).quota).toEqual({ bytes: 300, count: 1 })
    expect((await state()).claims).toEqual([{ sha256: b.sha256, bytes: 200 }])
  })

  it('下调字节配额不删除存量，允许零新增字节的重用，拒绝新占用', async () => {
    await transactions.run(async tx => repository.reserve(b, quotas, tx))
    const reduced = { ...quotas, quotaBytes: 100 }
    await transactions.run(async tx => repository.reserve(b, reduced, tx))
    await transactions.run(async tx => repository.finalize(randomUUID(), uploader, b, reduced, tx))
    await expect(transactions.run(async tx => repository.reserve(a, reduced, tx))).rejects.toMatchObject({ details: { kind: 'bytes' } })
    expect((await state()).quota).toEqual({ bytes: 200, count: 1 })
  })

  it('同 hash 并发只预留一次字节，各自产生记录', async () => {
    await Promise.all(Array.from({ length: 8 }, async () => {
      await transactions.run(async tx => repository.reserve(a, quotas, tx))
      await transactions.run(async tx => repository.finalize(randomUUID(), uploader, a, quotas, tx))
    }))
    const actual = await state()
    expect(actual.quota).toEqual({ bytes: 100, count: 8 })
    expect(actual.assets).toHaveLength(8)
    expect(new Set(actual.assets.map(row => row.id)).size).toBe(8)
    expect(actual.objects).toHaveLength(1)
    expect(actual.claims).toEqual([])
  })

  it('不同 hash 竞争最后字节额度，仅一个预留成功', async () => {
    const results = await Promise.allSettled([a, image('same-size')].map(async value => transactions.run(async tx => repository.reserve(value, { ...quotas, quotaBytes: 100 }, tx))))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect((await state()).quota).toEqual({ bytes: 100, count: 0 })
    expect((await state()).claims).toHaveLength(1)
  })

  it('预留事务回滚不收费；转正事务回滚保留先前预留，再次转正可恢复', async () => {
    await expect(transactions.run(async (tx) => {
      await repository.reserve(a, quotas, tx)
      throw new Error('controlled reserve rollback')
    })).rejects.toThrow('controlled reserve rollback')
    expect((await state()).quota).toEqual({ bytes: 0, count: 0 })
    await transactions.run(async tx => repository.reserve(a, quotas, tx))
    await expect(transactions.run(async (tx) => {
      await repository.finalize(randomUUID(), uploader, a, quotas, tx)
      throw new Error('controlled finalize rollback')
    })).rejects.toThrow('controlled finalize rollback')
    expect((await state()).quota).toEqual({ bytes: 100, count: 0 })
    expect((await state()).claims).toHaveLength(1)
    expect((await state()).objects).toEqual([])
    await transactions.run(async tx => repository.finalize(randomUUID(), uploader, a, quotas, tx))
    expect((await state()).quota).toEqual({ bytes: 100, count: 1 })
  })

  it('同 hash 的字节/媒体事实不一致或没有持久预留时，不能转正', async () => {
    await expect(transactions.run(async tx => repository.finalize(randomUUID(), uploader, a, quotas, tx))).rejects.toThrow()
    await transactions.run(async tx => repository.reserve(a, quotas, tx))
    await expect(transactions.run(async tx => repository.reserve({ ...a, bytes: 99 }, quotas, tx))).rejects.toThrow()
    await transactions.run(async tx => repository.finalize(randomUUID(), uploader, a, quotas, tx))
    await expect(transactions.run(async tx => repository.reserve({ ...a, width: 4 }, quotas, tx))).rejects.toThrow()
    expect((await state()).quota).toEqual({ bytes: 100, count: 1 })
  })
})
