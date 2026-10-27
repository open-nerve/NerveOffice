import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { DocumentCheckpointClock, DocumentHistoryRepository, DocumentHistoryValidation } from '@nerve-office/api/testing'
import { createdDocumentSchema } from '@nerve-office/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { captureHistory } from '../support/document-history.ts'
import { seedDocument } from '../support/documents.ts'
import { removeGrant, setGrant } from '../support/grants.ts'
import { completesWithoutWaiting, raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace, setMember, setSpaceState } from '../support/spaces.ts'

interface Person {
  readonly account: TestAccount
  readonly session: LoggedIn
}
let database: TestDatabase
let app: TestApp
let owner: Person
let alice: Person
let bob: Person
let carol: Person
let at: Date
let worldCount = 0

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  const person = async (username: string, systemRole: 'admin' | 'member' = 'member'): Promise<Person> => {
    const account = await createAccount(database, { username, systemRole })
    return { account, session: await login(app.baseUrl, username, account.password) }
  }
  owner = await person('history-lock-owner', 'admin')
  alice = await person('history-lock-alice')
  bob = await person('history-lock-bob')
  carol = await person('history-lock-carol')
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

function signal() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function world() {
  worldCount += 1
  const members = { [owner.account.id]: 'admin', [alice.account.id]: 'editor', [bob.account.id]: 'editor', [carol.account.id]: 'editor' } as const
  const sourceSpace = await createTeamSpace(database, { name: `历史源 ${worldCount}`, createdBy: owner.account.id, members })
  const targetSpace = await createTeamSpace(database, { name: `恢复目标 ${worldCount}`, createdBy: owner.account.id, members })
  const folder = await asUser(app.baseUrl, owner.session, '/api/folders', { method: 'POST', body: { spaceId: targetSpace, name: '恢复位置', requestId: randomUUID() } })
  expect(folder.status).toBe(201)
  const targetFolder = (await folder.json() as { id: string }).id
  const doc = await seedDocument(database, { spaceId: sourceSpace, createdBy: owner.account.id, title: '历史原题' })
  const history = await captureHistory(app, doc.id)
  return { sourceSpace, targetSpace, targetFolder, doc, history }
}
type World = Awaited<ReturnType<typeof world>>

async function restore(w: World, who = alice, requestId = randomUUID()) {
  return asUser(app.baseUrl, who.session, `/api/documents/${w.doc.id}/history/${w.history}/restore`, {
    method: 'POST',
    body: { requestId, spaceId: w.targetSpace, folderId: w.targetFolder },
  })
}
async function created(response: Response) {
  expect(response.status, await response.clone().text()).toBe(201)
  return parseExact(createdDocumentSchema, await response.json())
}
async function copies(w: World) {
  return database.query(async client => (await client.query<{ id: string }>('SELECT id FROM documents WHERE space_id=$1', [w.targetSpace])).rows.map(row => row.id))
}

/** 正文已通过真实检查器，但还没开写事务；此时改变权限不应被旧材料绕过。 */
function pauseValidated() {
  const validation = app.runtime.get(DocumentHistoryValidation)
  const validate = validation.validate.bind(validation)
  const reached = signal()
  const release = signal()
  vi.spyOn(validation, 'validate').mockImplementationOnce(async (...args) => {
    const result = await validate(...args)
    reached.resolve()
    await release.promise
    return result
  })
  return { reached, release }
}
async function arrived(reached: ReturnType<typeof signal>, pending: Promise<Response>) {
  expect(await Promise.race([reached.promise.then(() => true), pending.then(() => false)])).toBe(true)
}

describe('US-M5-10 恢复在验证后、写入前重新核对当前事实', () => {
  it('验证后的历史被删除并以同 id 重建不同信封时，拒绝复用旧验证结果', async () => {
    const w = await world()
    const { reached, release } = pauseValidated()
    const pending = restore(w)
    try {
      await arrived(reached, pending)
      await database.query(async client => client.query(`WITH removed AS (
        DELETE FROM document_checkpoints WHERE id=$1 RETURNING *
      ) INSERT INTO document_checkpoints
        SELECT (jsonb_populate_record(NULL::document_checkpoints,
          to_jsonb(removed) || jsonb_build_object('title', '同 id 的不同历史'))).* FROM removed`, [w.history]))
      release.resolve()
      expect((await pending).status).toBe(422)
      expect(await copies(w)).toEqual([])
    }
    finally {
      release.resolve()
      await Promise.allSettled([pending])
    }
  })

  it.each([
    ['撤成员', 404],
    ['降查看者', 403],
    ['撤单独授权', 404],
    ['归档', 403],
    ['移动', 404],
    ['删除', 404],
    ['清除历史', 404],
    ['历史到期', 404],
  ] as const)('源%s：拒绝且不创建副本', async (change, status) => {
    const w = await world()
    if (change === '撤单独授权') {
      await setMember(database, w.sourceSpace, alice.account.id, undefined)
      await setGrant(database, { documentId: w.doc.id, userId: alice.account.id, role: 'editor', grantedBy: owner.account.id })
    }
    const { reached, release } = pauseValidated()
    const pending = restore(w)
    try {
      await arrived(reached, pending)
      if (change === '撤成员' || change === '降查看者')
        await setMember(database, w.sourceSpace, alice.account.id, change === '撤成员' ? undefined : 'viewer')
      else if (change === '撤单独授权')
        await removeGrant(database, w.doc.id, alice.account.id)
      else if (change === '归档')
        await setSpaceState(database, w.sourceSpace, { status: 'archived' })
      else if (change === '移动')
        expect((await asUser(app.baseUrl, owner.session, `/api/documents/${w.doc.id}/move`, { method: 'POST', body: { spaceId: owner.account.personalSpaceId } })).status).toBe(200)
      else if (change === '删除')
        expect((await asUser(app.baseUrl, owner.session, `/api/documents/${w.doc.id}`, { method: 'DELETE' })).status).toBe(204)
      else if (change === '清除历史')
        await database.query(async client => client.query('DELETE FROM document_checkpoints WHERE id=$1', [w.history]))
      else
        at = new Date(at.getTime() + 7 * 24 * 3600_000)
      release.resolve()
      expect((await pending).status).toBe(status)
      expect(await copies(w)).toEqual([])
    }
    finally {
      release.resolve()
      await Promise.allSettled([pending])
    }
  })

  it.each([['撤成员', 404], ['降查看者', 403], ['归档', 409], ['删文件夹', 404], ['移动文件夹', 404]] as const)('目标%s：拒绝且不创建副本', async (change, status) => {
    const w = await world()
    const { reached, release } = pauseValidated()
    const pending = restore(w)
    try {
      await arrived(reached, pending)
      if (change === '撤成员' || change === '降查看者')
        await setMember(database, w.targetSpace, alice.account.id, change === '撤成员' ? undefined : 'viewer')
      else if (change === '归档')
        await setSpaceState(database, w.targetSpace, { status: 'archived' })
      else if (change === '删文件夹')
        expect((await asUser(app.baseUrl, owner.session, `/api/folders/${w.targetFolder}`, { method: 'DELETE' })).status).toBe(204)
      else
        expect((await asUser(app.baseUrl, owner.session, `/api/folders/${w.targetFolder}/move`, { method: 'POST', body: { spaceId: owner.account.personalSpaceId } })).status).toBe(200)
      release.resolve()
      expect((await pending).status).toBe(status)
      expect(await copies(w)).toEqual([])
    }
    finally {
      release.resolve()
      await Promise.allSettled([pending])
    }
  })

  it.each(['删除', '到期'] as const)('在检查点锁上等待后%s：不能在等锁前取时刻或信任预检', async (change) => {
    const w = await world()
    const response = await raceAgainstHeldLock(database, {
      hold: async client => client.query('SELECT id FROM document_checkpoints WHERE id=$1 FOR UPDATE', [w.history]),
      request: async () => restore(w),
      change: async (client) => {
        if (change === '删除')
          await client.query('DELETE FROM document_checkpoints WHERE id=$1', [w.history])
        else
          at = new Date(at.getTime() + 7 * 24 * 3600_000)
      },
    })
    expect(response.status).toBe(404)
    expect(await copies(w)).toEqual([])
  })
})

describe('US-M5-10 恢复持锁直到整份副本提交', () => {
  it.each(['删历史', '撤源成员', '归档源', '降目标角色', '移动目标文件夹'] as const)('%s等恢复事务完成后才生效', async (change) => {
    const w = await world()
    const history = app.runtime.get(DocumentHistoryRepository)
    const hold = history.hold.bind(history)
    const reached = signal()
    const release = signal()
    vi.spyOn(history, 'hold').mockImplementationOnce(async (...args) => {
      const held = await hold(...args)
      reached.resolve()
      await release.promise
      return held
    })
    const pending = restore(w)
    let mutation: Promise<unknown> | undefined
    try {
      await arrived(reached, pending)
      if (change === '删历史')
        mutation = database.query(async client => client.query('DELETE FROM document_checkpoints WHERE id=$1', [w.history]))
      else if (change === '撤源成员')
        mutation = asUser(app.baseUrl, owner.session, `/api/spaces/${w.sourceSpace}/members/${alice.account.id}`, { method: 'DELETE' })
      else if (change === '归档源')
        mutation = asUser(app.baseUrl, owner.session, `/api/admin/spaces/${w.sourceSpace}/archive`, { method: 'POST' })
      else if (change === '降目标角色')
        mutation = asUser(app.baseUrl, owner.session, `/api/spaces/${w.targetSpace}/members/${alice.account.id}`, { method: 'PUT', body: { role: 'viewer' } })
      else
        mutation = asUser(app.baseUrl, owner.session, `/api/folders/${w.targetFolder}/move`, { method: 'POST', body: { spaceId: owner.account.personalSpaceId } })
      expect(await completesWithoutWaiting(database, mutation, 1)).toBe(false)
      release.resolve()
      const copy = await created(await pending)
      const changed = await mutation
      if (changed instanceof Response)
        expect(changed.status, await changed.clone().text()).toBe(change === '撤源成员' ? 204 : 200)
      // 移动文件夹会把刚恢复的文档一同移动，仍只有那一个已经完整提交的副本。
      const stored = await database.query(async client => (await client.query<{ id: string, revision: number }>('SELECT id,revision FROM documents WHERE id=$1', [copy.id])).rows)
      expect(stored).toEqual([{ id: copy.id, revision: 1 }])
    }
    finally {
      release.resolve()
      await Promise.allSettled([pending, mutation])
    }
  })
})

describe('US-M5-10 正文加载之前限流，未知结果重放不占名额', () => {
  it('全局两份、同账户一份，拒绝请求不读取 gzip；已完成请求在名额占满且旧历史消失后仍能重放', async () => {
    const w = await world()
    const completedRequest = randomUUID()
    const completed = await created(await restore(w, carol, completedRequest))
    const validation = app.runtime.get(DocumentHistoryValidation)
    const validate = validation.validate.bind(validation)
    const reached = signal()
    const release = signal()
    let inspections = 0
    vi.spyOn(validation, 'validate').mockImplementation(async (...args) => {
      const result = await validate(...args)
      if (++inspections === 2)
        reached.resolve()
      await release.promise
      return result
    })
    const material = vi.spyOn(app.runtime.get(DocumentHistoryRepository), 'material')
    const first = restore(w, alice)
    const second = restore(w, bob)
    try {
      expect(await Promise.race([reached.promise.then(() => true), first.then(() => false), second.then(() => false)])).toBe(true)
      for (const who of [alice, carol]) {
        const busy = await restore(w, who)
        expect(busy.status).toBe(503)
        expect(busy.headers.get('retry-after')).toBe('5')
      }
      expect(material).toHaveBeenCalledTimes(2)
      await database.query(async client => client.query('DELETE FROM document_checkpoints WHERE id=$1', [w.history]))
      expect(await created(await restore(w, carol, completedRequest))).toMatchObject({ id: completed.id, replayed: true })
      expect(material).toHaveBeenCalledTimes(2)
      release.resolve()
      expect((await first).status).toBe(404)
      expect((await second).status).toBe(404)
      const fresh = await world()
      expect((await restore(fresh, alice)).status).toBe(201)
      expect((await restore(fresh, carol)).status).toBe(201)
    }
    finally {
      release.resolve()
      await Promise.allSettled([first, second])
    }
  })

  it('相同请求同时到达时繁忙重试，恢复完成后沿同一个请求返回唯一副本', async () => {
    const w = await world()
    const requestId = randomUUID()
    const { reached, release } = pauseValidated()
    const first = restore(w, alice, requestId)
    try {
      await arrived(reached, first)
      expect((await restore(w, alice, requestId)).status).toBe(503)
      release.resolve()
      const copy = await created(await first)
      expect(await created(await restore(w, alice, requestId))).toMatchObject({ id: copy.id, replayed: true })
      expect(await copies(w)).toEqual([copy.id])
    }
    finally {
      release.resolve()
      await Promise.allSettled([first])
    }
  })
})
