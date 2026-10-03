// 分享写入的锁（M2-P5 设计 §3.4(3)；US-M2-10、14）：两个连接构造的确定交错，不靠固定时长的等待。
// 锁的顺序是"被授权人的账户行（FOR SHARE，只有 PUT）→ 空间行（FOR SHARE）→ 文档行（FOR UPDATE）"。只靠单元测试断言调用顺序挡不住
// 去掉一把锁（M2-P6 第 3 片：去掉 4 处空间行锁，集成测试照样全绿），所以每把锁都有用例：
// 1. 锁的顺序：测试持住其中一把，请求停在它上面时，前面的锁已经持住、后面的还没取（另开连接用 NOWAIT 探）；
// 2. 账户行 × 停用被授权人、空间行 × 归档、空间行 × 移出空间（操作者被移出）：两个方向各一条——
//    对方先取完锁时分享等它提交、锁下再判断；分享先取完锁时对方等分享提交；
// 3. 文档行 × 跨空间移动：等文档行期间文档被移到别的空间，锁下发现它已不在持住的那个空间，404，什么也不写
//    （操作者在两个空间里都是空间管理员：锁下重新判断权限一定通过，挡住请求的只能是"空间变了"这一条）；
// 4. 文档行 × 保存与复制：取消、降级先取完锁时，保存与复制等它提交、在锁下重新判断，一定看到变化（取消之后 404、降级之后 403）；
//    保存先取完锁时，取消等它提交。
// 做法同 structure-locks.test.ts："先取完锁的操作"停在写审计之前——给 audit_events 装 BEFORE INSERT 的触发器，按"动作 + 操作者"
// 取 advisory 共享锁（闸门），测试的连接持有同一个键的排他锁。持锁构造的前提由 held-lock.ts 自己核对。
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { HeldLease } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, saveContent } from '../support/edit-leases.ts'
import { grantsOn, setGrant } from '../support/grants.ts'
import { completesWithoutWaiting, raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let amy: TestAccount
let ben: TestAccount
let cat: TestAccount
let rootSession: LoggedIn
let amySession: LoggedIn
let benSession: LoggedIn
let catSession: LoggedIn
let spaces = 0

/** 闸门：每写一条审计之前，按"动作 + 操作者"取一把共享的 advisory lock；测试持有同一个键的排他锁时，那个操作停在这里 */
const GATE_DDL = `
CREATE FUNCTION audit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('audit-gate:' || NEW.action || ':' || coalesce(NEW.actor_id::text, 'system'), 0));
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_gate BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_gate();
`

const FROZEN = { code: 'PERMISSION_DENIED', message: '空间已归档，恢复之后才能调整分享' }

beforeAll(async () => {
  database = await createTestDatabase()
  await database.query(async client => client.query(GATE_DDL))
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'root', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy', displayName: '艾米' })
  ben = await createAccount(database, { username: 'ben', displayName: '本' })
  cat = await createAccount(database, { username: 'cat', displayName: '凯特' })
  rootSession = await login(app.baseUrl, 'root', root.password)
  amySession = await login(app.baseUrl, 'amy', amy.password)
  benSession = await login(app.baseUrl, 'ben', ben.password)
  catSession = await login(app.baseUrl, 'cat', cat.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/** 新的团队空间：默认艾米是空间管理员 */
async function teamSpace(members: Readonly<Record<string, 'admin' | 'editor' | 'viewer'>> = {}): Promise<string> {
  spaces += 1
  return createTeamSpace(database, { name: `分享锁 ${spaces}`, createdBy: root.id, members: { [amy.id]: 'admin', ...members } })
}

async function share(user: LoggedIn, documentId: string, userId: string, role: 'viewer' | 'editor'): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${documentId}/grants/${userId}`, { method: 'PUT', body: { role } })
}

async function unshare(user: LoggedIn, documentId: string, userId: string): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${documentId}/grants/${userId}`, { method: 'DELETE' })
}

/**
 * 保存（M3-P1 起要求编辑租约）：没给租约时先以这个人申请、保存之后释放（support/edit-leases.ts）。
 * 交错的用例在持锁之前先申请好、传进来：申请也要锁文档行，不先申请的话停在锁上的是申请而不是保存
 */
async function save(user: LoggedIn, document: SeededDocument, baseRevision: number, lease?: HeldLease): Promise<Response> {
  const raw = Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: document.unitId }), 'utf8')
  return saveContent(app.baseUrl, user, document.id, zlib.gzipSync(raw), { baseRevision, lease })
}

async function errorOf(response: Response): Promise<{ code: string, message: string }> {
  const { error } = (await response.json()) as { error: { code: string, message: string } }
  return { code: error.code, message: error.message }
}

/** 在持锁的事务里锁住一行（FOR UPDATE：与分享取的 FOR SHARE、FOR UPDATE 都冲突）。表名是测试里写定的 */
function holdRow(table: 'users' | 'spaces' | 'documents', id: string) {
  return async (client: pg.Client) => {
    const locked = await client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id])
    // 前提：确实锁住了一行（id 写错时什么也锁不住，请求不会停在这里）
    if (locked.rowCount !== 1)
      throw new Error(`持锁的前提不成立：${table} 里没有 ${id}`)
  }
}

/** 在持锁的事务里关上这个操作的闸门 */
function holdGate(action: string, actorId: string) {
  return async (client: pg.Client) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`audit-gate:${action}:${actorId}`])
}

/** 这一行现在有没有被别的事务锁着：另开一个连接试着 FOR UPDATE NOWAIT（拿得到就立即放开） */
async function rowLock(table: 'users' | 'spaces' | 'documents', id: string): Promise<'locked' | 'free'> {
  return database.query(async (client) => {
    await client.query('BEGIN')
    try {
      const probed = await client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id])
      // 前提：探的是存在的一行（不存在时 NOWAIT 什么也不等，"没锁着"就不说明任何事）
      if (probed.rowCount !== 1)
        throw new Error(`探锁的前提不成立：${table} 里没有 ${id}`)
      return 'free'
    }
    catch (error) {
      // 55P03 lock_not_available：别的事务锁着它
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03')
        return 'locked'
      throw error
    }
    finally {
      await client.query('ROLLBACK')
    }
  })
}

/** 先取完锁的那个操作：它的审计动作与操作者（闸门的键），以及怎么发出它 */
interface Gated {
  readonly action: string
  readonly actorId: string
  readonly run: () => Promise<Response>
}

/** first 取完全部的锁、停在写审计之前；这时发出 second，看它是否等待；放开 first，两边都结束 */
async function interleave(first: Gated, second: () => Promise<Response>): Promise<{ first: Response, second: Response, secondWaited: boolean }> {
  let pending: Promise<Response> | undefined
  let completed: boolean | undefined
  const firstResponse = await raceAgainstHeldLock(database, {
    hold: holdGate(first.action, first.actorId),
    request: async () => first.run(),
    change: async () => {
      pending = second()
      completed = await completesWithoutWaiting(database, pending, 2)
    },
  })
  if (pending === undefined)
    throw new Error('第二个请求没有发出')
  return { first: firstResponse, second: await pending, secondWaited: completed === false }
}

async function revisionOf(documentId: string): Promise<number | undefined> {
  return database.query(async client => (await client.query<{ revision: number }>('SELECT revision FROM documents WHERE id = $1', [documentId])).rows[0]?.revision)
}

async function sharingAudits(documentId: string): Promise<string[]> {
  return database.query(async client => (await client.query<{ action: string }>(
    `SELECT action FROM audit_events WHERE target_id = $1 AND action IN ('documents.shared', 'documents.share_changed', 'documents.share_revoked') ORDER BY occurred_at, id`,
    [documentId],
  )).rows.map(row => row.action))
}

describe('US-M2-10 锁的顺序：被授权人的账户行 → 空间行 → 文档行（停在每一把上时，前面的已经持住、后面的还没取）', () => {
  it('设置：停在被授权人的账户行上时，空间行与文档行都还没锁；放开之后照常 200', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '锁顺序 一' })
    let held: Record<string, string> = {}
    const response = await raceAgainstHeldLock(database, {
      hold: holdRow('users', cat.id),
      request: async () => share(amySession, document.id, cat.id, 'viewer'),
      change: async () => {
        held = { space: await rowLock('spaces', spaceId), document: await rowLock('documents', document.id) }
      },
    })
    expect(held).toEqual({ space: 'free', document: 'free' })
    expect(response.status).toBe(200)
  })

  it('设置：停在空间行上时，被授权人的账户行已经持住（FOR SHARE），文档行还没锁', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '锁顺序 二' })
    let held: Record<string, string> = {}
    const response = await raceAgainstHeldLock(database, {
      hold: holdRow('spaces', spaceId),
      request: async () => share(amySession, document.id, cat.id, 'viewer'),
      change: async () => {
        held = { account: await rowLock('users', cat.id), document: await rowLock('documents', document.id) }
      },
    })
    expect(held).toEqual({ account: 'locked', document: 'free' })
    expect(response.status).toBe(200)
  })

  it('设置：停在文档行上时，被授权人的账户行与空间行都已经持住', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '锁顺序 三' })
    let held: Record<string, string> = {}
    const response = await raceAgainstHeldLock(database, {
      hold: holdRow('documents', document.id),
      request: async () => share(amySession, document.id, cat.id, 'viewer'),
      change: async () => {
        held = { account: await rowLock('users', cat.id), space: await rowLock('spaces', spaceId) }
      },
    })
    expect(held).toEqual({ account: 'locked', space: 'locked' })
    expect(response.status).toBe(200)
  })

  it('取消：停在空间行上时文档行还没锁；停在文档行上时空间行已经持住，被授权人的账户行一直不锁（停用的人的授权也要能取消）', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '锁顺序 四' })
    await setGrant(database, { documentId: document.id, userId: cat.id, role: 'viewer', grantedBy: amy.id })
    let atSpace: Record<string, string> = {}
    const first = await raceAgainstHeldLock(database, {
      hold: holdRow('spaces', spaceId),
      request: async () => unshare(amySession, document.id, cat.id),
      change: async () => {
        atSpace = { account: await rowLock('users', cat.id), document: await rowLock('documents', document.id) }
      },
    })
    expect(atSpace).toEqual({ account: 'free', document: 'free' })
    expect(first.status).toBe(204)

    await setGrant(database, { documentId: document.id, userId: cat.id, role: 'viewer', grantedBy: amy.id })
    let atDocument: Record<string, string> = {}
    const second = await raceAgainstHeldLock(database, {
      hold: holdRow('documents', document.id),
      request: async () => unshare(amySession, document.id, cat.id),
      change: async () => {
        atDocument = { account: await rowLock('users', cat.id), space: await rowLock('spaces', spaceId) }
      },
    })
    expect(atDocument).toEqual({ account: 'free', space: 'locked' })
    expect(second.status).toBe(204)
  })
})

describe('US-M2-14 账户行：分享与停用被授权人互斥（M2-P5 设计 §3.4(3)）', () => {
  it('停用先取完锁：设置等它提交，锁下再看被授权人已停用，409，什么也不写', async () => {
    const grantee = await createAccount(database, { username: 'race-disabled-1' })
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '停用先' })
    const result = await interleave(
      { action: 'users.disabled', actorId: root.id, run: async () => asUser(app.baseUrl, rootSession, `/api/admin/users/${grantee.id}/disable`, { method: 'POST' }) },
      async () => share(amySession, document.id, grantee.id, 'editor'),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([200, 409, true])
    expect((await errorOf(result.second)).code).toBe('ACCOUNT_UNAVAILABLE')
    expect(await grantsOn(database, [document.id])).toEqual([])
    expect(await sharingAudits(document.id)).toEqual([])
  })

  it('设置先取完锁：停用等它提交，之后两边都成功，授权保留（停用的人的授权不删）', async () => {
    const grantee = await createAccount(database, { username: 'race-disabled-2' })
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '分享先' })
    const result = await interleave(
      { action: 'documents.shared', actorId: amy.id, run: async () => share(amySession, document.id, grantee.id, 'editor') },
      async () => asUser(app.baseUrl, rootSession, `/api/admin/users/${grantee.id}/disable`, { method: 'POST' }),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([200, 200, true])
    expect(await grantsOn(database, [document.id])).toEqual([{ documentId: document.id, userId: grantee.id, role: 'editor' }])
  })
})

describe('US-M2-14 空间行：分享与归档、移出空间互斥（M2-P5 设计 §3.4(3)）', () => {
  it('归档先取完锁：设置等它提交，锁下再判断，403（冻结的说明），什么也不写', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '归档先' })
    const result = await interleave(
      { action: 'spaces.archived', actorId: root.id, run: async () => asUser(app.baseUrl, rootSession, `/api/admin/spaces/${spaceId}/archive`, { method: 'POST' }) },
      async () => share(amySession, document.id, cat.id, 'editor'),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([200, 403, true])
    expect(await errorOf(result.second)).toEqual(FROZEN)
    expect(await grantsOn(database, [document.id])).toEqual([])
    expect(await sharingAudits(document.id)).toEqual([])
  })

  it('归档先取完锁：取消同样等它提交，403（冻结的说明），授权还在', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '归档先 取消' })
    await setGrant(database, { documentId: document.id, userId: cat.id, role: 'editor', grantedBy: amy.id })
    const result = await interleave(
      { action: 'spaces.archived', actorId: root.id, run: async () => asUser(app.baseUrl, rootSession, `/api/admin/spaces/${spaceId}/archive`, { method: 'POST' }) },
      async () => unshare(amySession, document.id, cat.id),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([200, 403, true])
    expect(await errorOf(result.second)).toEqual(FROZEN)
    expect(await grantsOn(database, [document.id])).toEqual([{ documentId: document.id, userId: cat.id, role: 'editor' }])
  })

  it('设置先取完锁：归档等它提交，之后两边都成功（进行中的分享先提交、归档再生效）', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '分享先 归档' })
    const result = await interleave(
      { action: 'documents.shared', actorId: amy.id, run: async () => share(amySession, document.id, cat.id, 'viewer') },
      async () => asUser(app.baseUrl, rootSession, `/api/admin/spaces/${spaceId}/archive`, { method: 'POST' }),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([200, 200, true])
    expect(await grantsOn(database, [document.id])).toEqual([{ documentId: document.id, userId: cat.id, role: 'viewer' }])
  })

  it('把操作者移出空间先取完锁：他的设置等它提交，锁下再判断已看不到这份文档，404，什么也不写', async () => {
    const spaceId = await teamSpace({ [ben.id]: 'admin' })
    const document = await seedDocument(database, { spaceId, createdBy: ben.id, title: '移出先' })
    const result = await interleave(
      { action: 'spaces.member_removed', actorId: amy.id, run: async () => asUser(app.baseUrl, amySession, `/api/spaces/${spaceId}/members/${ben.id}`, { method: 'DELETE' }) },
      async () => share(benSession, document.id, cat.id, 'editor'),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([204, 404, true])
    expect(await grantsOn(database, [document.id])).toEqual([])
  })

  it('设置先取完锁：把操作者移出空间的请求等它提交，之后两边都成功', async () => {
    const spaceId = await teamSpace({ [ben.id]: 'admin' })
    const document = await seedDocument(database, { spaceId, createdBy: ben.id, title: '分享先 移出' })
    const result = await interleave(
      { action: 'documents.shared', actorId: ben.id, run: async () => share(benSession, document.id, cat.id, 'editor') },
      async () => asUser(app.baseUrl, amySession, `/api/spaces/${spaceId}/members/${ben.id}`, { method: 'DELETE' }),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([200, 204, true])
    expect(await grantsOn(database, [document.id])).toEqual([{ documentId: document.id, userId: cat.id, role: 'editor' }])
  })
})

describe('US-M2-14 文档行：等文档行期间文档被跨空间移走，锁下发现它已不在持住的空间，404，什么也不写（M2-P5 设计 §3.4(3) 第 4 步）', () => {
  // 艾米在两个空间里都是空间管理员：锁下重新判断权限一定通过，挡住请求的只能是"空间变了"这一条
  it('设置', async () => {
    const [from, to] = [await teamSpace(), await teamSpace()]
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '被移走的 设置' })
    const response = await raceAgainstHeldLock(database, {
      hold: holdRow('documents', document.id),
      request: async () => share(amySession, document.id, cat.id, 'editor'),
      change: async client => client.query('UPDATE documents SET space_id = $2, write_epoch = write_epoch + 1 WHERE id = $1', [document.id, to]),
    })
    expect(response.status).toBe(404)
    expect(await grantsOn(database, [document.id])).toEqual([])
    expect(await sharingAudits(document.id)).toEqual([])
  })

  it('取消', async () => {
    const [from, to] = [await teamSpace(), await teamSpace()]
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '被移走的 取消' })
    await setGrant(database, { documentId: document.id, userId: cat.id, role: 'viewer', grantedBy: amy.id })
    const response = await raceAgainstHeldLock(database, {
      hold: holdRow('documents', document.id),
      request: async () => unshare(amySession, document.id, cat.id),
      change: async client => client.query('UPDATE documents SET space_id = $2, write_epoch = write_epoch + 1 WHERE id = $1', [document.id, to]),
    })
    expect(response.status).toBe(404)
    expect(await grantsOn(database, [document.id])).toEqual([{ documentId: document.id, userId: cat.id, role: 'viewer' }])
  })

  it('设置先取完锁：跨空间移动等它提交（文档行），之后两边都成功，授权跟着文档走', async () => {
    const [from, to] = [await teamSpace(), await teamSpace()]
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '分享先 移动' })
    const result = await interleave(
      { action: 'documents.shared', actorId: amy.id, run: async () => share(amySession, document.id, cat.id, 'editor') },
      async () => asUser(app.baseUrl, amySession, `/api/documents/${document.id}/move`, { method: 'POST', body: { spaceId: to } }),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([200, 200, true])
    expect(await grantsOn(database, [document.id])).toEqual([{ documentId: document.id, userId: cat.id, role: 'editor' }])
    expect((await asUser(app.baseUrl, catSession, `/api/documents/${document.id}`)).status).toBe(200)
  })
})

describe('US-M2-14 文档行：取消、降级与保存、复制互斥——它们提交之后的保存与复制一定看到变化（M2-P5 设计 §3.4(3)、§3.4(5)）', () => {
  it('取消先取完锁：保存等它提交，锁下重新判断，404，内容不变', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '取消 × 保存' })
    await setGrant(database, { documentId: document.id, userId: cat.id, role: 'editor', grantedBy: amy.id })
    // 卡特先申请好编辑权：停在文档行上的是保存（见 save 的说明）
    const lease = await acquireLease(app.baseUrl, catSession, document.id)
    const result = await interleave(
      { action: 'documents.share_revoked', actorId: amy.id, run: async () => unshare(amySession, document.id, cat.id) },
      async () => save(catSession, document, 1, lease),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([204, 404, true])
    expect(await revisionOf(document.id)).toBe(1)
  })

  it('保存先取完锁：取消等它提交，之后两边都成功（保存在取消之前生效）', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '保存 × 取消' })
    await setGrant(database, { documentId: document.id, userId: cat.id, role: 'editor', grantedBy: amy.id })
    const lease = await acquireLease(app.baseUrl, catSession, document.id)
    const result = await interleave(
      { action: 'documents.content_saved', actorId: cat.id, run: async () => save(catSession, document, 1, lease) },
      async () => unshare(amySession, document.id, cat.id),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([200, 204, true])
    expect(await revisionOf(document.id)).toBe(2)
    expect(await grantsOn(database, [document.id])).toEqual([])
  })

  it('取消先取完锁：复制等它提交（源文档行），锁下重新判断，404，没有副本', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '取消 × 复制' })
    await setGrant(database, { documentId: document.id, userId: cat.id, role: 'viewer', grantedBy: amy.id })
    const copies = async (): Promise<number> => database.query(async client => Number((await client.query<{ count: string }>('SELECT count(*) FROM documents WHERE space_id = $1', [cat.personalSpaceId])).rows[0]?.count))
    const before = await copies()
    const result = await interleave(
      { action: 'documents.share_revoked', actorId: amy.id, run: async () => unshare(amySession, document.id, cat.id) },
      async () => asUser(app.baseUrl, catSession, `/api/documents/${document.id}/copy`, { method: 'POST', body: { spaceId: cat.personalSpaceId, requestId: randomUUID() } }),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([204, 404, true])
    expect(await copies()).toBe(before)
  })

  it('降级先取完锁：保存等它提交，锁下重新判断，403（只能查看），内容不变', async () => {
    const spaceId = await teamSpace()
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '降级 × 保存' })
    await setGrant(database, { documentId: document.id, userId: cat.id, role: 'editor', grantedBy: amy.id })
    const lease = await acquireLease(app.baseUrl, catSession, document.id)
    const result = await interleave(
      { action: 'documents.share_changed', actorId: amy.id, run: async () => share(amySession, document.id, cat.id, 'viewer') },
      async () => save(catSession, document, 1, lease),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([200, 403, true])
    expect(await errorOf(result.second)).toEqual({ code: 'PERMISSION_DENIED', message: '只能查看这份文档，不能编辑' })
    expect(await revisionOf(document.id)).toBe(1)
  })
})
