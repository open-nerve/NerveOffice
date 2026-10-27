import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { TransactionRunner } from '@nerve-office/api'
import { DocumentCheckpointClock, DocumentCheckpointService, DocumentsRepository } from '@nerve-office/api/testing'
import { documentHistoryDetailSchema, documentHistoryListResponseSchema, sheetSnapshotFor } from '@nerve-office/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { captureHistory } from '../support/document-history.ts'
import { seedDocument } from '../support/documents.ts'
import { removeGrant, setGrant } from '../support/grants.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace, setSpaceState } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let owner: TestAccount
let other: TestAccount
let session: LoggedIn
let otherSession: LoggedIn
let at: Date

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  owner = await createAccount(database, { username: 'history-reader-owner', displayName: '保存者' })
  other = await createAccount(database, { username: 'history-reader-other', systemRole: 'admin' })
  session = await login(app.baseUrl, owner.username, owner.password)
  otherSession = await login(app.baseUrl, other.username, other.password)
})
beforeEach(() => {
  at = new Date('2026-10-22T08:00:00.123Z')
  vi.spyOn(app.runtime.get(DocumentCheckpointClock), 'now').mockImplementation(async () => at)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

const path = (id: string, suffix = '') => `/api/documents/${id}/history${suffix}`
const read = async (id: string, suffix = '', who = session) => asUser(app.baseUrl, who, path(id, suffix))
const document = async (spaceId = owner.personalSpaceId) => seedDocument(database, { spaceId, createdBy: owner.id, title: '采样时标题' })

async function list(id: string, suffix = '') {
  const response = await read(id, suffix)
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(documentHistoryListResponseSchema, await response.json())
}

describe('US-M5-10 用户历史读取', () => {
  it('旧文档没有采样时返回真实空列表，不拿当前内容冒充历史', async () => {
    expect(await list((await document()).id)).toEqual({ items: [], nextCursor: null, canClearHistory: true })
  })

  it('30 条 keyset 分页不重复、不串源；历史标题与保存时间固定，保存人使用当前显示名', async () => {
    const doc = await document()
    const ids: string[] = []
    for (let hour = 0; hour < 32; hour++) {
      at = new Date(Date.parse('2026-10-20T08:00:00.123Z') + hour * 3600_000)
      ids.push(await captureHistory(app, doc.id))
    }
    await captureHistory(app, (await document()).id)
    await database.query(async client => client.query('UPDATE documents SET title=$2 WHERE id=$1', [doc.id, '现在的标题']))
    await database.query(async client => client.query('UPDATE users SET display_name=$2 WHERE id=$1', [owner.id, '更新后的保存者']))
    const first = await list(doc.id)
    expect(first.items.map(row => row.id)).toEqual(ids.toReversed().slice(0, 30))
    expect(first.nextCursor).toEqual(expect.any(String))
    const second = await list(doc.id, `?cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(second.items.map(row => row.id)).toEqual(ids.toReversed().slice(30))
    expect(second.nextCursor).toBeNull()
    const row = first.items[0]!
    expect(row).toMatchObject({ title: '采样时标题', revision: 1, savedBy: { id: owner.id, displayName: '更新后的保存者' }, clientBuild: null, compatibility: 'supported' })
    const saved = await database.query(async client => (await client.query<{ saved_at: Date }>('SELECT created_at AS saved_at FROM document_revisions WHERE document_id=$1', [doc.id])).rows[0]!.saved_at)
    expect(row.savedAt).toBe(saved.toISOString())
    const detail = await read(doc.id, `/${row.id}`)
    expect(parseExact(documentHistoryDetailSchema, await detail.json())).toEqual(row)
    expect((await read(doc.id, '?cursor=invalid')).status).toBe(400)
    expect((await read(doc.id, '?limit=1')).status).toBe(400)
  })

  it('严格七天到期，运维检查点和别的文档的历史始终 404', async () => {
    const doc = await document()
    const history = await captureHistory(app, doc.id)
    const ops = await app.runtime.get(TransactionRunner).run(async (tx) => {
      await app.runtime.get(DocumentsRepository).lockById(doc.id, tx)
      return app.runtime.get(DocumentCheckpointService).captureOperation(doc.id, 'before_upgrade', randomUUID(), tx)
    })
    const foreign = await captureHistory(app, (await document()).id)
    for (const id of [ops!, foreign, randomUUID()]) {
      expect((await read(doc.id, `/${id}`)).status).toBe(404)
      expect((await read(doc.id, `/${id}/content`)).status).toBe(404)
    }
    at = new Date(at.getTime() + 7 * 24 * 3600_000 - 1)
    expect((await list(doc.id)).items.map(row => row.id)).toEqual([history])
    at = new Date(at.getTime() + 1)
    expect((await list(doc.id)).items).toEqual([])
    expect((await read(doc.id, `/${history}`)).status).toBe(404)
    expect((await read(doc.id, `/${history}/content`)).status).toBe(404)
  })

  it('正文使用历史原 gzip；当前正文损坏不影响历史；不接收当前修订的条件缓存', async () => {
    const doc = await document()
    const history = await captureHistory(app, doc.id)
    const stored = await database.query(async client => (await client.query<{ snapshot: Buffer }>('SELECT snapshot FROM document_checkpoints WHERE id=$1', [history])).rows[0]!.snapshot)
    await database.query(async client => client.query('UPDATE document_contents SET snapshot=decode(\'00\',\'hex\'),stored_bytes=1 WHERE document_id=$1', [doc.id]))
    const response = await asUser(app.baseUrl, session, path(doc.id, `/${history}/content`), { headers: { 'if-none-match': '"1"' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('etag')).toBeNull()
    expect(await response.text()).toBe(sheetSnapshotFor(doc.unitId))
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const outgoing = request(`${app.baseUrl}${path(doc.id, `/${history}/content`)}`, { headers: { cookie: session.cookie } }, (incoming) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
        incoming.on('end', () => resolve(Buffer.concat(chunks)))
        incoming.on('error', reject)
      })
      outgoing.on('error', reject)
      outgoing.end()
    })
    expect(bytes).toEqual(stored)
  })

  it('未知格式只标记不支持，不藏起元数据或改写原正文', async () => {
    const doc = await document()
    await database.query(async client => client.query('UPDATE documents SET sdk_version=\'999.0.0\' WHERE id=$1', [doc.id]))
    const history = await captureHistory(app, doc.id)
    expect((await list(doc.id)).items[0]).toMatchObject({ compatibility: 'unsupported', sdkVersion: '999.0.0' })
    expect((await read(doc.id, `/${history}/content`)).status).toBe(200)
  })

  it('权限判断后撤权并产生新历史：在途请求只看到同一个旧快照，下次请求拒绝', async () => {
    const doc = await document()
    const first = await captureHistory(app, doc.id)
    await setGrant(database, { documentId: doc.id, userId: other.id, role: 'editor', grantedBy: owner.id })
    const entered = signal()
    const release = signal()
    vi.spyOn(app.runtime.get(DocumentCheckpointClock), 'now').mockImplementationOnce(async () => {
      const instant = at
      entered.resolve()
      await release.promise
      return instant
    })
    const pending = read(doc.id, '', otherSession)
    await entered.promise
    try {
      await removeGrant(database, doc.id, other.id)
      at = new Date(at.getTime() + 3600_000)
      await captureHistory(app, doc.id)
    }
    finally {
      release.resolve()
    }
    const response = await pending
    expect(response.status).toBe(200)
    expect(parseExact(documentHistoryListResponseSchema, await response.json()).items.map(row => row.id)).toEqual([first])
    expect((await read(doc.id, '', otherSession)).status).toBe(404)
  })

  it('跨空间移动后，原空间的编辑资格不能用于读取历史', async () => {
    const source = await createTeamSpace(database, { name: '历史移出空间', createdBy: other.id, members: { [owner.id]: 'admin', [other.id]: 'editor' } })
    const doc = await document(source)
    const history = await captureHistory(app, doc.id)
    expect((await read(doc.id, '', otherSession)).status).toBe(200)
    const target = await createTeamSpace(database, { name: '历史移入空间', createdBy: other.id, members: { [owner.id]: 'admin' } })
    const moved = await asUser(app.baseUrl, session, `/api/documents/${doc.id}/move`, { method: 'POST', body: { spaceId: target } })
    expect(moved.status, await moved.clone().text()).toBe(200)
    for (const suffix of ['', `/${history}`, `/${history}/content`]) {
      expect((await read(doc.id, suffix, otherSession)).status).toBe(404)
      expect((await read(doc.id, suffix)).status).toBe(200)
    }
  })

  it('每个读取入口重新判断历史资格：系统管理员无内容权限、查看者、撤权和归档', async () => {
    const space = await createTeamSpace(database, { name: '历史权限', createdBy: other.id, members: { [owner.id]: 'admin' } })
    const doc = await document(space)
    const history = await captureHistory(app, doc.id)
    const suffixes = ['', `/${history}`, `/${history}/content`]
    const expectAll = async (status: number) => {
      for (const suffix of suffixes)
        expect((await read(doc.id, suffix, otherSession)).status, suffix).toBe(status)
    }
    await expectAll(404)
    await setGrant(database, { documentId: doc.id, userId: other.id, role: 'viewer', grantedBy: owner.id })
    await expectAll(403)
    await setGrant(database, { documentId: doc.id, userId: other.id, role: 'editor', grantedBy: owner.id })
    await expectAll(200)
    await setSpaceState(database, space, { status: 'archived' })
    await expectAll(403)
    await setSpaceState(database, space, { status: 'active' })
    await removeGrant(database, doc.id, other.id)
    await expectAll(404)
    for (const suffix of suffixes)
      expect((await fetch(`${app.baseUrl}${path(doc.id, suffix)}`)).status).toBe(401)
  })
})

function signal() {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
