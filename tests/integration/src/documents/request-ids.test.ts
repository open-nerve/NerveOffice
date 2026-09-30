// 幂等的 requestId（M2-P6 复核 S2）：别人拿同一个 requestId 重放（新建、复制、新建文件夹、保存），拿不到第一个人的东西，
// 也得不到它的任何信息——一律 409 REQUEST_ID_CONFLICT，错误体里只有码、说明与请求标识；
// 本人重放时已经看不到那份文档（被移出空间、文档进了回收站），同样 409，不返回它的元数据。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { errorResponseSchema, sheetSnapshotFor } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace, setMember } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let alice: TestAccount
let bob: TestAccount
let aliceSession: LoggedIn
let bobSession: LoggedIn
let team: string

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  const root = await createAccount(database, { username: 'root', systemRole: 'admin' })
  alice = await createAccount(database, { username: 'alice' })
  bob = await createAccount(database, { username: 'bob' })
  aliceSession = await login(app.baseUrl, alice.username, alice.password)
  bobSession = await login(app.baseUrl, bob.username, bob.password)
  team = await createTeamSpace(database, { name: '幂等：团队', createdBy: root.id, members: { [alice.id]: 'editor' } })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/** 409 REQUEST_ID_CONFLICT，错误体里除了码与说明只有请求标识：没有那份文档的任何信息 */
async function expectConflict(response: Response): Promise<void> {
  expect(response.status).toBe(409)
  const body = parseExact(errorResponseSchema, await response.json())
  expect(body.error.code).toBe('REQUEST_ID_CONFLICT')
  expect(Object.keys(body.error).toSorted()).toEqual(['code', 'message', 'requestId'])
}

function saveQuery(requestId: string): string {
  return new URLSearchParams({ baseRevision: '1', requestId, clientInstanceId: randomUUID(), localSeq: '1' }).toString()
}

function gzipOf(unitId: string): Uint8Array {
  return zlib.gzipSync(Buffer.from(sheetSnapshotFor(unitId), 'utf8'))
}

describe('别人的 requestId', () => {
  it('新建：别人用同一个 requestId（请求体完全相同，或者换成自己的空间）一律 409', async () => {
    const requestId = randomUUID()
    expect((await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body: { type: 'sheet', title: 'Alice 的机密', requestId, spaceId: team } })).status).toBe(201)
    await expectConflict(await asUser(app.baseUrl, bobSession, '/api/documents', { method: 'POST', body: { type: 'sheet', title: 'Alice 的机密', requestId, spaceId: team } }))
    await expectConflict(await asUser(app.baseUrl, bobSession, '/api/documents', { method: 'POST', body: { type: 'sheet', requestId } }))
  })

  it('复制、新建文件夹、保存：别人用同一个 requestId 一律 409；拿它复制他看不到的源文档也是 409 而不是 404（只说明这个 requestId 用过）', async () => {
    const source = await seedDocument(database, { spaceId: alice.personalSpaceId, createdBy: alice.id, title: 'Alice 的源' })
    const bobs = await seedDocument(database, { spaceId: bob.personalSpaceId, createdBy: bob.id, title: 'Bob 的' })

    const copyId = randomUUID()
    expect((await asUser(app.baseUrl, aliceSession, `/api/documents/${source.id}/copy`, { method: 'POST', body: { spaceId: alice.personalSpaceId, requestId: copyId } })).status).toBe(201)
    await expectConflict(await asUser(app.baseUrl, bobSession, `/api/documents/${bobs.id}/copy`, { method: 'POST', body: { spaceId: bob.personalSpaceId, requestId: copyId } }))
    await expectConflict(await asUser(app.baseUrl, bobSession, `/api/documents/${source.id}/copy`, { method: 'POST', body: { spaceId: alice.personalSpaceId, requestId: copyId } }))

    const folderId = randomUUID()
    expect((await asUser(app.baseUrl, aliceSession, '/api/folders', { method: 'POST', body: { spaceId: alice.personalSpaceId, name: 'Alice 的目录', requestId: folderId } })).status).toBe(201)
    await expectConflict(await asUser(app.baseUrl, bobSession, '/api/folders', { method: 'POST', body: { spaceId: bob.personalSpaceId, name: 'Alice 的目录', requestId: folderId } }))

    const saveId = randomUUID()
    expect((await asUser(app.baseUrl, aliceSession, `/api/documents/${source.id}/content?${saveQuery(saveId)}`, { method: 'PUT', binary: { contentType: 'application/gzip', bytes: gzipOf(source.unitId) } })).status).toBe(200)
    await expectConflict(await asUser(app.baseUrl, bobSession, `/api/documents/${bobs.id}/content?${saveQuery(saveId)}`, { method: 'PUT', binary: { contentType: 'application/gzip', bytes: gzipOf(bobs.unitId) } }))
  })

  it('本人重放：已经看不到那份文档（被移出空间、文档进了回收站）时 409，不返回它的元数据', async () => {
    const removedId = randomUUID()
    const body = { type: 'sheet', title: '移出之前建的', requestId: removedId, spaceId: team }
    expect((await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body })).status).toBe(201)
    await setMember(database, team, alice.id, undefined)
    await expectConflict(await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body }))
    await setMember(database, team, alice.id, 'editor')

    const trashedId = randomUUID()
    const created = await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body: { type: 'sheet', requestId: trashedId } })
    const document = (await created.json()) as { id: string }
    expect((await asUser(app.baseUrl, aliceSession, `/api/documents/${document.id}`, { method: 'DELETE' })).status).toBe(204)
    await expectConflict(await asUser(app.baseUrl, aliceSession, '/api/documents', { method: 'POST', body: { type: 'sheet', requestId: trashedId } }))
  })
})
