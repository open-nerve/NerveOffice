import type { AssetUploadActor, Transaction } from '@nerve-office/api'
import type { Database } from '@nerve-office/api/testing'
import type { PassiveAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { TransactionRunner } from '@nerve-office/api'
import { AssetReferenceService, AssetUploadService, DocumentAssetReferences, DocumentsRepository } from '@nerve-office/api/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createAssetActor } from '../support/assets.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let references: DocumentAssetReferences
let assets: AssetReferenceService
let documents: DocumentsRepository
let transactions: TransactionRunner
let owner: PassiveAccount
let editor: PassiveAccount
let admin: PassiveAccount
const actors = new Map<string, AssetUploadActor>()

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  references = app.runtime.get(DocumentAssetReferences)
  assets = app.runtime.get(AssetReferenceService)
  documents = app.runtime.get(DocumentsRepository)
  transactions = app.runtime.get(TransactionRunner)
  owner = await createPassiveAccount(database, { username: 'ref-owner' })
  editor = await createPassiveAccount(database, { username: 'ref-editor' })
  admin = await createPassiveAccount(database, { username: 'ref-admin' })
  await database.query(async client => client.query('UPDATE users SET system_role = \'admin\' WHERE id = $1', [admin.id]))
  for (const account of [owner, editor, admin])
    actors.set(account.id, await createAssetActor(database, account.id))
})
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

async function upload(account = owner, expired = false): Promise<string> {
  const data = await readFile(new URL('../../../../apps/api/src/modules/assets/testdata/minimum.png', import.meta.url))
  const uploaded = await app.runtime.get(AssetUploadService).upload(actors.get(account.id)!, async () => ({ data, mimeType: 'image/png', extension: 'png' }), new AbortController().signal)
  if (expired)
    await database.query(async client => client.query('UPDATE assets SET created_at = now() - interval \'25 hours\' WHERE id = $1', [uploaded.assetId]))
  return uploaded.assetId
}
async function document(account = owner) {
  const created = await seedDocument(database, { spaceId: account.personalSpaceId, createdBy: account.id, title: '引用服务' })
  return (await documents.findById(created.id))!
}
async function link(documentId: string, assetIds: readonly string[]): Promise<void> {
  await database.query(async client => client.query('INSERT INTO document_asset_links (document_id, asset_id) SELECT $1, unnest($2::uuid[])', [documentId, assetIds]))
}
async function grant(documentId: string, userId = editor.id): Promise<void> {
  await database.query(async client => client.query('INSERT INTO document_grants (document_id, user_id, role, granted_by) VALUES ($1,$2,\'viewer\',$3)', [documentId, userId, owner.id]))
}
async function current(documentId: string): Promise<string[]> {
  return database.query(async client => (await client.query<{ asset_id: string }>('SELECT asset_id FROM document_asset_links WHERE document_id=$1 ORDER BY asset_id', [documentId])).rows.map(row => row.asset_id))
}
async function eligible(userId: string, ids: readonly string[], transaction: Transaction, target?: Awaited<ReturnType<typeof document>>) {
  const prepared = await references.prepare(userId, ids, transaction, target)
  const held = await references.hold(prepared, { mode: 'update' }, transaction)
  return references.authorize(held, transaction)
}

describe('图片引用的批量授权与真实事务', () => {
  it('合并已有目标引用、本人窗口和可读来源；同物理对象的陌生 assetId 与未知 ID 不获权', async () => {
    const target = await document(editor)
    const source = await document()
    const kept = await upload(owner, true)
    const recent = await upload(editor)
    const shared = await upload(owner, true)
    const hidden = await upload()
    await link(target.id, [kept])
    await link(source.id, [shared])
    await grant(source.id)
    const expected = [kept, recent, shared].sort()
    await transactions.run(async (transaction) => {
      const allowed = await eligible(editor.id, [shared, hidden, randomUUID(), recent, kept, recent], transaction, target)
      expect(allowed).toEqual(expected)
      await references.replace(target.id, allowed, transaction)
    })
    expect(await current(target.id)).toEqual(expected)
    const hashes = await database.query(async client => (await client.query('SELECT DISTINCT object_hash FROM assets WHERE id = ANY($1::uuid[])', [[kept, recent, shared, hidden]])).rowCount)
    expect(hashes).toBe(1)
    expect(await transactions.run(async transaction => eligible(admin.id, [kept, shared, hidden], transaction))).toEqual([])
  })

  it.each([[86_399_999, true], [86_400_000, false], [86_400_001, false]] as const)('本人上传距事务时刻 %i ms：严格窗口为 %s，公开元数据不含对象路径', async (age, allowed) => {
    const id = await upload(editor)
    await transactions.run(async (transaction) => {
      await (transaction as unknown as Database).execute(sql`UPDATE assets SET created_at = now() - ${age} * interval '1 millisecond' WHERE id = ${id}`)
      const expected = [{ assetId: id, uploaderId: editor.id, withinUploadWindow: allowed }]
      expect(await assets.inspect([id, id, randomUUID()], transaction)).toEqual(expected)
      expect(await eligible(editor.id, [id], transaction)).toEqual(allowed ? [id] : [])
    })
  })

  it.each(['撤销分享', '移除引用', '删除文档', '移到未锁空间'] as const)('预选后%s：不能凭旧事实建立引用', async (change) => {
    const id = await upload(owner, true)
    const source = await document()
    await link(source.id, [id])
    await grant(source.id)
    await transactions.run(async (transaction) => {
      const prepared = await references.prepare(editor.id, [id], transaction)
      expect(prepared.sources.map(row => row.id)).toEqual([source.id])
      await database.query(async (client) => {
        if (change === '撤销分享')
          await client.query('DELETE FROM document_grants WHERE document_id=$1', [source.id])
        else if (change === '移除引用')
          await client.query('DELETE FROM document_asset_links WHERE document_id=$1', [source.id])
        else if (change === '删除文档')
          await client.query('DELETE FROM documents WHERE id=$1', [source.id])
        else
          await client.query('UPDATE documents SET space_id=$2 WHERE id=$1', [source.id, admin.personalSpaceId])
      })
      const held = await references.hold(prepared, { mode: 'share' }, transaction)
      expect(await references.authorize(held, transaction)).toEqual([])
    })
  })

  it('同一资源多个可读来源只预选一个；其失效后不临时补锁，下一事务再选择', async () => {
    const id = await upload(owner, true)
    const first = await document()
    const second = await document()
    for (const source of [first, second]) {
      await link(source.id, [id])
      await grant(source.id)
    }
    await transactions.run(async (transaction) => {
      const prepared = await references.prepare(editor.id, [id], transaction)
      expect(prepared.sources).toHaveLength(1)
      const selected = prepared.sources[0]!.id
      await database.query(async client => client.query('DELETE FROM document_grants WHERE document_id=$1', [selected]))
      const held = await references.hold(prepared, { mode: 'share' }, transaction)
      expect([...held.documents.keys()]).toEqual([selected])
      expect(await references.authorize(held, transaction)).toEqual([])
    })
    expect(await transactions.run(async transaction => eligible(editor.id, [id], transaction))).toEqual([id])
  })

  it('替换去重、删除旧关系，事务失败恢复原集合；空集合明确清空', async () => {
    const target = await document(editor)
    const first = await upload(editor)
    const second = await upload(editor)
    await link(target.id, [first])
    await expect(transactions.run(async (transaction) => {
      const allowed = await eligible(editor.id, [second, second], transaction, target)
      await references.replace(target.id, allowed, transaction)
      throw new Error('故障回滚')
    })).rejects.toThrow('故障回滚')
    expect(await current(target.id)).toEqual([first])
    await transactions.run(async (transaction) => {
      const allowed = await eligible(editor.id, [], transaction, target)
      expect(allowed).toEqual([])
      await references.replace(target.id, allowed, transaction)
    })
    expect(await current(target.id)).toEqual([])
  })

  it('来源锁证明不能跨事务复用', async () => {
    const id = await upload(editor)
    const prepared = await transactions.run(async transaction => references.prepare(editor.id, [id], transaction))
    await expect(transactions.run(async transaction => references.hold(prepared, { mode: 'share' }, transaction))).rejects.toThrow('资源引用事务不一致')
    const held = await transactions.run(async (transaction) => {
      const plan = await references.prepare(editor.id, [id], transaction)
      return references.hold(plan, { mode: 'share' }, transaction)
    })
    await expect(transactions.run(async transaction => references.authorize(held, transaction))).rejects.toThrow('资源引用事务不一致')
  })

  it('目标已有引用要求可编辑；仅能查看时不能把它冒充保留资格', async () => {
    const id = await upload(owner, true)
    const target = await document()
    await link(target.id, [id])
    await grant(target.id)
    expect(await transactions.run(async transaction => eligible(editor.id, [id], transaction, target))).toEqual([])
  })

  it('可读的归档空间仍可作为来源；移出成员后按同一权限策略不再合格', async () => {
    const spaceId = await createTeamSpace(database, { name: '归档图片来源', createdBy: admin.id, members: { [editor.id]: 'viewer' }, status: 'archived' })
    const source = await seedDocument(database, { spaceId, createdBy: owner.id, title: '归档只读来源' })
    const id = await upload(owner, true)
    await link(source.id, [id])
    expect(await transactions.run(async transaction => eligible(editor.id, [id], transaction))).toEqual([id])
    await transactions.run(async (transaction) => {
      const prepared = await references.prepare(editor.id, [id], transaction)
      await database.query(async client => client.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [spaceId, editor.id]))
      const held = await references.hold(prepared, { mode: 'share' }, transaction)
      expect(await references.authorize(held, transaction)).toEqual([])
    })
  })

  it('普通复制只承接源的当前集合，之后删除源不会改变副本关系', async () => {
    const source = await document()
    const target = await document(editor)
    const id = await upload(owner, true)
    await link(source.id, [id])
    await grant(source.id)
    await transactions.run(async (transaction) => {
      const prepared = await references.prepare(editor.id, [], transaction)
      const held = await references.hold(prepared, { mode: 'share', documents: [source], spaceIds: [target.spaceId] }, transaction)
      await references.copy(held.documents.get(source.id)!, target.id, transaction)
    })
    await database.query(async client => client.query('DELETE FROM documents WHERE id=$1', [source.id]))
    expect(await current(target.id)).toEqual([id])
    expect(await transactions.run(async transaction => eligible(editor.id, [id], transaction))).toEqual([id])
  })
})
