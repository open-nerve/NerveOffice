import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { HeldLease } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { TransactionRunner } from '@nerve-office/api'
import { DocumentAssetReferences, DocumentCheckpointClock, DocumentCheckpointService, DocumentsRepository } from '@nerve-office/api/testing'
import { createdDocumentSchema } from '@nerve-office/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { uploadTestAsset } from '../support/assets.ts'
import { pageSnapshot } from '../support/conflict-copies.ts'
import { createTestDatabase } from '../support/database.ts'
import { captureHistory } from '../support/document-history.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, releaseLease, saveContent } from '../support/edit-leases.ts'
import { removeGrant, setGrant } from '../support/grants.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace, setSpaceState } from '../support/spaces.ts'
import { captureStatements } from '../support/statement-capture.ts'

interface Client { readonly account: TestAccount, readonly session: LoggedIn }
let database: TestDatabase
let app: TestApp
let owner: Client
let reader: Client
let at: Date

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  const person = async (username: string): Promise<Client> => {
    const account = await createAccount(database, { username })
    return { account, session: await login(app.baseUrl, account.username, account.password) }
  }
  owner = await person('historical-image-owner')
  reader = await person('historical-image-editor')
})
beforeEach(() => {
  at = new Date('2026-10-22T08:00:00Z')
  vi.spyOn(app.runtime.get(DocumentCheckpointClock), 'now').mockImplementation(async () => at)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

const document = async (client = owner, spaceId = client.account.personalSpaceId) => seedDocument(database, { spaceId, createdBy: client.account.id, title: '历史图片' })
async function upload() {
  const asset = await uploadTestAsset(app.baseUrl, owner.session)
  await database.query(async client => client.query('UPDATE assets SET created_at=now()-interval \'25 hours\' WHERE id=$1', [asset.assetId]))
  return asset.assetId
}
async function link(doc: SeededDocument, asset: string) {
  await database.query(async client => client.query('INSERT INTO document_asset_links (document_id,asset_id) VALUES ($1,$2)', [doc.id, asset]))
}
async function historical(asset: string, doc = document()) {
  const source = await doc
  await link(source, asset)
  const history = await captureHistory(app, source.id)
  await database.query(async client => client.query('DELETE FROM document_asset_links WHERE document_id=$1', [source.id]))
  return { source, history }
}
async function share(doc: SeededDocument, role: 'viewer' | 'editor' = 'editor') {
  await setGrant(database, { documentId: doc.id, userId: reader.account.id, role, grantedBy: owner.account.id })
}
async function expectRead(asset: string, status: number, who = reader) {
  const response = await asUser(app.baseUrl, who.session, `/api/assets/${asset}`)
  expect(response.status).toBe(200)
  expect(response.headers.get('x-asset-status')).toBe(String(status))
  await response.arrayBuffer()
}
async function references(id: string) {
  return database.query(async client => (await client.query<{ id: string }>('SELECT asset_id AS id FROM document_asset_links WHERE document_id=$1 ORDER BY asset_id', [id])).rows.map(row => row.id))
}
async function save(doc: SeededDocument, asset: string, lease?: HeldLease) {
  const raw = Buffer.from(JSON.stringify({ ...JSON.parse(pageSnapshot(doc.unitId).toString('utf8')) as Record<string, unknown>, images: [`/api/assets/${asset}`] }))
  return saveContent(app.baseUrl, reader.session, doc.id, gzipSync(raw), { baseRevision: 1, ...(lease === undefined ? {} : { lease }) })
}
function signal() {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('US-M5-10 历史图片与当前权限', () => {
  it('隐藏历史从一份增加到多份，不改变图片缺失/隐藏的查询序列', async () => {
    const asset = await upload()
    await historical(asset)
    const capture = captureStatements(database.name)
    try {
      const first = await capture.during(async () => expectRead(asset, 404))
      const missing = await capture.during(async () => expectRead(randomUUID(), 404))
      expect(first.statements).toEqual(missing.statements)
      for (let index = 0; index < 12; index++)
        await historical(asset)
      const many = await capture.during(async () => expectRead(asset, 404))
      expect(many.statements).toEqual(first.statements)
    }
    finally {
      capture.restore()
    }
  })
  it('只有历史保留的图片：编辑者与所有者可读，查看者/撤权不可读；当前引用仍按可读授权', async () => {
    const asset = await upload()
    const { source } = await historical(asset)
    await expectRead(asset, 200, owner)
    await share(source, 'viewer')
    await expectRead(asset, 404)
    await share(source)
    await expectRead(asset, 200)
    await removeGrant(database, source.id, reader.account.id)
    await expectRead(asset, 404)
    await link(source, asset)
    await share(source, 'viewer')
    await expectRead(asset, 200)
  })

  it('运维检查点保留不授权，用户历史严格到期，归档使 editor 分享降级', async () => {
    const asset = await upload()
    const space = await createTeamSpace(database, { name: '历史图片归档', createdBy: owner.account.id, members: { [owner.account.id]: 'admin' } })
    const { source, history } = await historical(asset, document(owner, space))
    await share(source)
    await expectRead(asset, 200)
    await setSpaceState(database, space, { status: 'archived' })
    await expectRead(asset, 404)
    await setSpaceState(database, space, { status: 'active' })
    at = new Date(at.getTime() + 7 * 24 * 3600_000)
    await expectRead(asset, 404)
    await link(source, asset)
    await app.runtime.get(TransactionRunner).run(async (tx) => {
      await app.runtime.get(DocumentsRepository).lockById(source.id, tx)
      await app.runtime.get(DocumentCheckpointService).captureOperation(source.id, 'before_delete', randomUUID(), tx)
    })
    await database.query(async (client) => {
      await client.query('DELETE FROM document_asset_links WHERE document_id=$1', [source.id])
      await client.query('DELETE FROM document_checkpoints WHERE id=$1', [history])
    })
    await expectRead(asset, 404)
  })

  it('同一图片有查看来源、归档 editor 来源和合法 editor 来源，不被前两个候选遮住', async () => {
    const asset = await upload()
    const viewer = await historical(asset)
    await share(viewer.source, 'viewer')
    const archived = await createTeamSpace(database, { name: '先出现的归档来源', createdBy: owner.account.id })
    const frozen = await historical(asset, document(owner, archived))
    await share(frozen.source)
    await setSpaceState(database, archived, { status: 'archived' })
    const allowed = await historical(asset)
    await share(allowed.source)
    await expectRead(asset, 200)
    await removeGrant(database, allowed.source.id, reader.account.id)
    await expectRead(asset, 404)
  })

  it('相同物理 hash 的陌生 assetId 不继承历史读权', async () => {
    const first = await upload()
    const other = await upload()
    const { source } = await historical(first)
    await share(source)
    const hashes = await database.query(async client => (await client.query<{ object_hash: string }>('SELECT object_hash FROM assets WHERE id=ANY($1::uuid[])', [[first, other]])).rows)
    expect(hashes).toHaveLength(2)
    expect(hashes[0]!.object_hash).toBe(hashes[1]!.object_hash)
    await expectRead(first, 200)
    await expectRead(other, 404)
  })

  it('合法历史图片可存入新的当前关系，查看者不能提升历史引用；普通复制只带当前关系', async () => {
    const asset = await upload()
    const { source } = await historical(asset)
    await share(source)
    const target = await document(reader)
    expect((await save(target, asset)).status).toBe(200)
    expect(await references(target.id)).toEqual([asset])
    await share(source, 'viewer')
    // 删除刚建立的独立合法来源，避免它替查看者提供当前读权。
    expect((await asUser(app.baseUrl, reader.session, `/api/documents/${target.id}`, { method: 'DELETE' })).status).toBe(204)
    const denied = await document(reader)
    expect((await save(denied, asset)).status).toBe(200)
    expect(await references(denied.id)).toEqual([])
    const copied = await asUser(app.baseUrl, reader.session, `/api/documents/${source.id}/copy`, { method: 'POST', body: { requestId: randomUUID(), spaceId: reader.account.personalSpaceId } })
    expect(copied.status).toBe(201)
    expect(await references(createdDocumentSchema.parse(await copied.json()).id)).toEqual([])
  })

  it('从历史复制合法引用后故障，当前正文、关系与新的历史全部回滚', async () => {
    const asset = await upload()
    const { source } = await historical(asset)
    await share(source)
    const target = await document(reader)
    const checkpoints = app.runtime.get(DocumentCheckpointService)
    const capture = checkpoints.captureHourly.bind(checkpoints)
    vi.spyOn(checkpoints, 'captureHourly').mockImplementationOnce(async (...args) => {
      await capture(...args)
      throw new Error('历史来源写入后故障')
    })
    expect((await save(target, asset)).status).toBe(500)
    expect(await references(target.id)).toEqual([])
    const state = await database.query(async client => (await client.query<{ revision: number, histories: number }>('SELECT revision,(SELECT count(*)::int FROM document_checkpoints WHERE source_document_id=d.id) AS histories FROM documents d WHERE id=$1', [target.id])).rows[0])
    expect(state).toEqual({ revision: 1, histories: 0 })
    expect((await save(target, asset)).status).toBe(200)
    expect(await references(target.id)).toEqual([asset])
  })

  it.each(['撤权', '清除', '到期', '移动', '归档'] as const)('固定历史候选之后%s，不得用预选结果形成当前引用', async (change) => {
    const space = await createTeamSpace(database, { name: `历史来源-${change}`, createdBy: owner.account.id, members: { [owner.account.id]: 'admin', [reader.account.id]: 'editor' } })
    const asset = await upload()
    const { source, history } = await historical(asset, document(owner, space))
    const target = await document(reader)
    const lease = await acquireLease(app.baseUrl, reader.session, target.id)
    const service = app.runtime.get(DocumentAssetReferences)
    const hold = service.hold.bind(service)
    const reached = signal()
    const release = signal()
    vi.spyOn(service, 'hold').mockImplementationOnce(async (...args) => {
      expect(args[0].sources.map(row => row.id)).toContain(source.id)
      reached.resolve()
      await release.promise
      return hold(...args)
    })
    const pending = save(target, asset, lease)
    try {
      expect(await Promise.race([reached.promise.then(() => true), pending.then(() => false)])).toBe(true)
      if (change === '清除')
        await database.query(async client => client.query('DELETE FROM document_checkpoints WHERE id=$1', [history]))
      else if (change === '到期')
        at = new Date(at.getTime() + 7 * 24 * 3600_000)
      else if (change === '撤权')
        await database.query(async client => client.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [space, reader.account.id]))
      else if (change === '归档')
        await setSpaceState(database, space, { status: 'archived' })
      else
        expect((await asUser(app.baseUrl, owner.session, `/api/documents/${source.id}/move`, { method: 'POST', body: { spaceId: owner.account.personalSpaceId } })).status).toBe(200)
      release.resolve()
      expect((await pending).status).toBe(200)
      expect(await references(target.id)).toEqual([])
    }
    finally {
      release.resolve()
      await Promise.allSettled([pending])
      await releaseLease(app.baseUrl, reader.session, target.id, lease)
    }
  })
})
