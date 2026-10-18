import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { HeldLease } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { APPLICATION_NAME, DocumentAssetReferences } from '@nerve-office/api/testing'
import { createdDocumentSchema, saveContentResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { uploadTestAsset } from '../support/assets.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, releaseLease, saveContent } from '../support/edit-leases.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

interface Client { readonly account: TestAccount, readonly session: LoggedIn }
let database: TestDatabase
let app: TestApp
let root: Client
let owner: Client
let editor: Client
async function person(username: string, systemRole: 'member' | 'admin' = 'member'): Promise<Client> {
  const account = await createAccount(database, { username, systemRole })
  return { account, session: await login(app.baseUrl, username, account.password) }
}
beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await person('reference-race-root', 'admin')
  owner = await person('reference-race-owner')
  editor = await person('reference-race-editor')
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

async function document(client: Client, spaceId = client.account.personalSpaceId): Promise<SeededDocument> {
  return seedDocument(database, { spaceId, createdBy: client.account.id, title: '图片引用交错' })
}
function body(doc: SeededDocument, ids: readonly string[]): Buffer {
  return gzipSync(Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: doc.unitId, extra: ids.map(id => `/api/assets/${id}`) })))
}
async function save(client: Client, doc: SeededDocument, ids: readonly string[], baseRevision: number, lease?: HeldLease): Promise<Response> {
  return saveContent(app.baseUrl, client.session, doc.id, body(doc, ids), { baseRevision, ...(lease === undefined ? {} : { lease }) })
}
async function saved(response: Response): Promise<void> {
  expect(response.status).toBe(200)
  expect(saveContentResponseSchema.parse(await response.json()).unchanged).toBe(false)
}
async function references(doc: SeededDocument): Promise<string[]> {
  return database.query(async client => (await client.query<{ id: string }>('SELECT asset_id AS id FROM document_asset_links WHERE document_id=$1 ORDER BY asset_id', [doc.id])).rows.map(row => row.id))
}
async function expire(ids: readonly string[]): Promise<void> {
  await database.query(async client => client.query('UPDATE assets SET created_at=now()-interval \'25 hours\' WHERE id=ANY($1::uuid[])', [ids]))
}
async function share(doc: SeededDocument): Promise<void> {
  const response = await asUser(app.baseUrl, owner.session, `/api/documents/${doc.id}/grants/${editor.account.id}`, { method: 'PUT', body: { role: 'viewer' } })
  expect(response.status).toBe(200)
  await response.arrayBuffer()
}
function signal() {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function oneWriterWaiting(): Promise<void> {
  await vi.waitFor(async () => {
    const waiting = await database.query(async client => (await client.query<{ query: string }>(
      'SELECT query FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type=\'Lock\'',
      [database.name, APPLICATION_NAME],
    )).rows)
    expect(waiting).toHaveLength(1)
    // 观察真实空间/文档行等待，不能把测试门闩或请求账本当成锁顺序证据。
    expect(waiting[0]!.query).toMatch(/(?:from|update) "(?:spaces|documents)"/u)
  }, { timeout: 10_000 })
}

const changes = ['撤销分享', '删除来源', '移除源引用', '移出团队', '移动来源', '归档来源空间'] as const
type Change = typeof changes[number]
async function setup(change: Change) {
  const team = ['移出团队', '移动来源', '归档来源空间'].includes(change)
    ? await createTeamSpace(database, { name: `引用来源空间-${randomUUID()}`, createdBy: root.account.id, members: { [owner.account.id]: 'admin', [editor.account.id]: 'viewer' } })
    : undefined
  const source = await document(owner, team)
  const target = await document(editor)
  const { assetId } = await uploadTestAsset(app.baseUrl, owner.session)
  await saved(await save(owner, source, [assetId], 1))
  await expire([assetId])
  if (team === undefined)
    await share(source)
  const lease = await acquireLease(app.baseUrl, editor.session, target.id)
  async function mutate(): Promise<void> {
    if (change === '移除源引用') {
      await saved(await save(owner, source, [], 2))
      return
    }
    const response = change === '撤销分享'
      ? await asUser(app.baseUrl, owner.session, `/api/documents/${source.id}/grants/${editor.account.id}`, { method: 'DELETE' })
      : change === '删除来源'
        ? await asUser(app.baseUrl, owner.session, `/api/documents/${source.id}`, { method: 'DELETE' })
        : change === '移出团队'
          ? await asUser(app.baseUrl, owner.session, `/api/spaces/${team}/members/${editor.account.id}`, { method: 'DELETE' })
          : change === '移动来源'
            ? await asUser(app.baseUrl, owner.session, `/api/documents/${source.id}/move`, { method: 'POST', body: { spaceId: owner.account.personalSpaceId } })
            : await asUser(app.baseUrl, root.session, `/api/admin/spaces/${team}/archive`, { method: 'POST' })
    expect(response.status).toBe(change === '移动来源' || change === '归档来源空间' ? 200 : 204)
    await response.arrayBuffer()
  }
  return { source, target, assetId, lease, mutate }
}

describe('固定图片来源的真实并发边界', () => {
  for (const timing of ['取锁前', '持锁后'] as const) {
    it.each(changes)(`${timing}%s：按实际提交顺序授权，不拼接旧权限与新引用`, async (change) => {
      const state = await setup(change)
      const service = app.runtime.get(DocumentAssetReferences)
      const hold = service.hold.bind(service)
      const reached = signal()
      const release = signal()
      vi.spyOn(service, 'hold').mockImplementationOnce(async (...args) => {
        expect(args[0].sources.map(row => row.id)).toEqual([state.source.id])
        const held = timing === '持锁后' ? await hold(...args) : undefined
        reached.resolve()
        await release.promise
        return held ?? hold(...args)
      })
      const pending = save(editor, state.target, [state.assetId], 1, state.lease)
      let mutation: Promise<void> | undefined
      try {
        expect(await Promise.race([reached.promise.then(() => true), pending.then(() => false)])).toBe(true)
        mutation = state.mutate()
        if (timing === '持锁后')
          await oneWriterWaiting()
        else
          await mutation
        expect(await references(state.target)).toEqual([])
        release.resolve()
        await saved(await pending)
        await mutation
        // 归档按既有政策仍可读；其他先提交的失效来源不得变成新的独立引用。
        expect(await references(state.target)).toEqual(timing === '持锁后' || change === '归档来源空间' ? [state.assetId] : [])
      }
      finally {
        release.resolve()
        await Promise.allSettled([pending, mutation])
        await releaseLease(app.baseUrl, editor.session, state.target.id, state.lease)
      }
    }, 20_000)
  }

  it('两个文档互相取图片：先固定全部来源，再按相同顺序直接取排他锁，不升级锁或重试死锁', async () => {
    const docs = [await document(editor), await document(editor)]
    const ids = [(await uploadTestAsset(app.baseUrl, editor.session)).assetId, (await uploadTestAsset(app.baseUrl, editor.session)).assetId]
    for (const [index, doc] of docs.entries())
      await saved(await save(editor, doc, [ids[index]!], 1))
    await expire(ids)
    const leases: HeldLease[] = []
    for (const doc of docs)
      leases.push(await acquireLease(app.baseUrl, editor.session, doc.id))
    const service = app.runtime.get(DocumentAssetReferences)
    const hold = service.hold.bind(service)
    const bothPrepared = signal()
    const firstLocked = signal()
    const release = signal()
    let preparedCount = 0
    let lockedCount = 0
    const spy = vi.spyOn(service, 'hold').mockImplementation(async (...args) => {
      expect(args[0].sources).toHaveLength(1)
      preparedCount += 1
      if (preparedCount === 2)
        bothPrepared.resolve()
      await bothPrepared.promise
      const held = await hold(...args)
      lockedCount += 1
      if (lockedCount === 1) {
        firstLocked.resolve()
        await release.promise
      }
      return held
    })
    const pending = docs.map(async (doc, index) => save(editor, doc, ids, 2, leases[index]))
    try {
      expect(await Promise.race([firstLocked.promise.then(() => true), Promise.any(pending).then(() => false)])).toBe(true)
      await oneWriterWaiting()
      release.resolve()
      for (const response of await Promise.all(pending))
        await saved(response)
      expect(spy).toHaveBeenCalledTimes(2)
      for (const doc of docs)
        expect(await references(doc)).toEqual([...ids].sort())
    }
    finally {
      bothPrepared.resolve()
      release.resolve()
      await Promise.allSettled(pending)
      for (const [index, doc] of docs.entries())
        await releaseLease(app.baseUrl, editor.session, doc.id, leases[index]!)
    }
  }, 20_000)

  it.each(['保存先持锁', '复制先持锁'] as const)('%s：另一操作只在文档行等待，副本承接它读到的那一版当前集合', async (order) => {
    const source = await document(owner)
    const oldId = (await uploadTestAsset(app.baseUrl, owner.session)).assetId
    const newId = (await uploadTestAsset(app.baseUrl, owner.session)).assetId
    await saved(await save(owner, source, [oldId], 1))
    await share(source)
    const lease = await acquireLease(app.baseUrl, owner.session, source.id)
    const service = app.runtime.get(DocumentAssetReferences)
    const reached = signal()
    const release = signal()
    if (order === '保存先持锁') {
      const hold = service.hold.bind(service)
      vi.spyOn(service, 'hold').mockImplementationOnce(async (...args) => {
        const held = await hold(...args)
        reached.resolve()
        await release.promise
        return held
      })
    }
    else {
      const copy = service.copy.bind(service)
      vi.spyOn(service, 'copy').mockImplementationOnce(async (...args) => {
        reached.resolve()
        await release.promise
        return copy(...args)
      })
    }
    const saving = async () => save(owner, source, [newId], 2, lease)
    const copying = async () => asUser(app.baseUrl, editor.session, `/api/documents/${source.id}/copy`, { method: 'POST', body: { requestId: randomUUID(), spaceId: editor.account.personalSpaceId } })
    const first = order === '保存先持锁' ? saving() : copying()
    let second: Promise<Response> | undefined
    try {
      expect(await Promise.race([reached.promise.then(() => true), first.then(() => false)])).toBe(true)
      second = order === '保存先持锁' ? copying() : saving()
      await oneWriterWaiting()
      release.resolve()
      const results = await Promise.all([first, second])
      await saved(results[order === '保存先持锁' ? 0 : 1])
      const response = results[order === '保存先持锁' ? 1 : 0]
      expect(response.status).toBe(201)
      const copied = createdDocumentSchema.parse(await response.json())
      expect(await references({ ...source, id: copied.id })).toEqual([order === '保存先持锁' ? newId : oldId])
      expect(await references(source)).toEqual([newId])
    }
    finally {
      release.resolve()
      await Promise.allSettled([first, second])
      await releaseLease(app.baseUrl, owner.session, source.id, lease)
    }
  }, 20_000)
})
