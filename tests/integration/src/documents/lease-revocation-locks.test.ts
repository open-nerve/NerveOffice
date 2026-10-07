// 收回写入权与进行中的保存、申请（M3-P1 设计 §3.4.6；收口 M2-P2 设计 §7 的"进行中的保存与撤权不互斥"，ADR-014）：两个连接构造的确定交错。
// 保存在租约这一步之前锁住了文档行，撤权要结束持有者的租约、给文档加代次，必须先拿到同一把锁，所以两者必有先后——
// 1. 保存先取完锁（停在写审计之前）：撤权等它提交，保存写进去，撤权随后生效（租约 revoked、代次加一），之后的保存被拒绝；
// 2. 撤权先取完锁（租约已结束、代次已加一，停在写审计之前）：保存等它提交，锁下看到变化，被拒绝，什么也不写；
// 3. 申请在撤权提交之前判断了权限、在它之后才提交：撤权找不到这个还没提交的租约，租约行有了，由有效条件的第 7 条在每次使用时让它失效；
//    分享的写入本身锁文档行，与申请互斥，没有这个窗口；停用撤销了全部登录，申请在锁下核对登录时就被拒绝（lease-session.test.ts）。
// 撤权先取完锁时在途的心跳先回答失去访问或编辑权（M3-P1 审查 A2）；跨空间移动、转移之后仍能编辑的持有者，在途的保存与心跳按锁下读到的
// 新代次判断（stale，M3-P1 审查 A3）。
// 4. 保存按它的事务开始时的 now() 判断租约：在途的保存跨过了租约的到期（或空闲满 12 分钟）时，撤权照样等它提交（M3-P5 审查 A1，
//    由审查者的探针改成）——撤权连按时间刚死不久（一个有效期之内）的租约的文档行也锁，只是不收回它（不记 revoked、不加代次，DEF-044）。
//    死了约 60 秒（保存的事务的时限，复验 C1）的照样等：按行为钉住窗口的大小（复验 C5）。
// 另有锁的顺序（文档行 → 租约行）、锁下再核对一次范围、范围只锁涉及的文档，以及死了超过一个有效期的租约的文档行不锁（M3-P5 设计 §3.5，
// DEF-044）、刚死不久的锁住而不收回。
// 做法同 sharing-locks.test.ts："先取完锁的操作"停在写审计之前——给 audit_events 装 BEFORE INSERT 的触发器，按"动作 + 操作者"
// 取 advisory 共享锁（闸门），测试的连接持有同一个键的排他锁。持锁构造的前提由 held-lock.ts 自己核对。
import type { SpaceRole } from '@nerve-office/contracts'
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { HeldLease, LeaseState } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { acquiredEditLeaseSchema, EDIT_LEASE_IDLE_RECLAIM_SECONDS, EDIT_LEASE_TTL_SECONDS, editStatusSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { acquireBody } from '../support/client-format.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, idleLeaseFor, leaseStateOf, outcomeOf, passLeaseTime, releaseLease, renewLease, saveContent } from '../support/edit-leases.ts'
import { setGrant } from '../support/grants.ts'
import { completesWithoutWaiting, raceAgainstHeldLock, whileHolding } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
/** 系统管理员（停用、归档）；每个团队空间的空间管理员（移出、降级、分享）；每个团队空间里的另一位编辑者 */
let root: TestAccount
let amy: TestAccount
let cat: TestAccount
let rootSession: LoggedIn
let amySession: LoggedIn
let catSession: LoggedIn
let people = 0
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

beforeAll(async () => {
  database = await createTestDatabase()
  await database.query(async client => client.query(GATE_DDL))
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'revocation-locks-root', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'revocation-locks-amy' })
  cat = await createAccount(database, { username: 'revocation-locks-cat' })
  rootSession = await login(app.baseUrl, root.username, root.password)
  amySession = await login(app.baseUrl, amy.username, amy.password)
  catSession = await login(app.baseUrl, cat.username, cat.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

interface Person {
  readonly account: TestAccount
  readonly session: LoggedIn
}

/** 一个持有者、他编辑的那份文档与文档所在的团队空间（艾米是空间管理员，卡特是编辑者） */
interface Prepared {
  readonly holder: Person
  readonly space: string
  readonly document: SeededDocument
}

/**
 * 新的持有者与文档：via 是他凭什么能编辑——空间的编辑者（member），或者不是成员、只凭单独授权（grant）。
 * 各个用例各用各的人：会被停用、移出、降级
 */
async function prepare(via: 'member' | 'grant'): Promise<Prepared> {
  people += 1
  spaces += 1
  const account = await createAccount(database, { username: `revocation-locks-${people}` })
  const holder = { account, session: await login(app.baseUrl, account.username, account.password) }
  const members: Record<string, SpaceRole> = { [amy.id]: 'admin', [cat.id]: 'editor' }
  if (via === 'member')
    members[account.id] = 'editor'
  const space = await createTeamSpace(database, { name: `收回与交错 ${spaces}`, createdBy: root.id, members })
  const document = await seedDocument(database, { spaceId: space, createdBy: amy.id, title: '收回与交错' })
  if (via === 'grant')
    await setGrant(database, { documentId: document.id, userId: account.id, role: 'editor', grantedBy: amy.id })
  return { holder, space, document }
}

async function save(user: LoggedIn, document: SeededDocument, lease: HeldLease, baseRevision = 1): Promise<Response> {
  const raw = Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: document.unitId }), 'utf8')
  return saveContent(app.baseUrl, user, document.id, zlib.gzipSync(raw), { baseRevision, lease })
}

async function acquire(user: LoggedIn, documentId: string, clientInstanceId: string = randomUUID()): Promise<Response> {
  return asUser(app.baseUrl, user, `/api/documents/${documentId}/edit-lease`, { method: 'POST', body: acquireBody(clientInstanceId) })
}

/** 持有者之后的心跳与保存各自的结局（同一个页面：同一份租约） */
async function holderOutcomes(prepared: Prepared, lease: HeldLease): Promise<[string, string]> {
  const { holder, document } = prepared
  return [await outcomeOf(await renewLease(app.baseUrl, holder.session, document.id, lease)), await outcomeOf(await save(holder.session, document, lease))]
}

/** 这份文档的修订号、修订记录的条数与保存的审计条数 */
async function writesOf(documentId: string): Promise<{ readonly revision: number | undefined, readonly revisions: number, readonly saves: number }> {
  return database.query(async client => ({
    revision: (await client.query<{ revision: number }>('SELECT revision FROM documents WHERE id = $1', [documentId])).rows[0]?.revision,
    revisions: Number((await client.query<{ count: string }>('SELECT count(*) FROM document_revisions WHERE document_id = $1', [documentId])).rows[0]?.count),
    saves: Number((await client.query<{ count: string }>('SELECT count(*) FROM audit_events WHERE target_id = $1 AND action = \'documents.content_saved\'', [documentId])).rows[0]?.count),
  }))
}

/** 收回之后的租约行：这一代记 revoked，文档的代次在它之上加了一 */
function revoked(holder: Person, lease: HeldLease): LeaseState {
  return { holderId: holder.account.id, endReason: 'revoked', leaseEpoch: lease.writeEpoch, documentEpoch: lease.writeEpoch + 1 }
}

/** 在持锁的事务里关上这个操作的闸门 */
function holdGate(action: string, actorId: string) {
  return async (client: pg.Client) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`audit-gate:${action}:${actorId}`])
}

/** 在持锁的事务里锁住这份文档的租约行（申请、心跳、释放都要锁它） */
function holdLeaseRow(documentId: string) {
  return async (client: pg.Client) => {
    const locked = await client.query('SELECT 1 FROM document_edit_leases WHERE document_id = $1 FOR UPDATE', [documentId])
    // 前提：确实锁住了一行（没有这一行时什么也锁不住，申请不会停在这里）
    if (locked.rowCount !== 1)
      throw new Error(`持锁的前提不成立：${documentId} 没有租约行`)
  }
}

/** 在持锁的事务里锁住这些文档行（FOR UPDATE） */
function holdDocuments(...documentIds: string[]) {
  return async (client: pg.Client) => {
    const locked = await client.query('SELECT id FROM documents WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [documentIds])
    if (locked.rowCount !== documentIds.length)
      throw new Error(`持锁的前提不成立：没有锁住全部 ${documentIds.length} 份文档`)
  }
}

/** 这份文档的租约行现在有没有被别的事务锁着：另开一个连接试着 FOR UPDATE NOWAIT（拿得到就立即放开） */
async function leaseRowLock(documentId: string): Promise<'locked' | 'free'> {
  return database.query(async (client) => {
    await client.query('BEGIN')
    try {
      const probed = await client.query('SELECT document_id FROM document_edit_leases WHERE document_id = $1 FOR UPDATE NOWAIT', [documentId])
      // 前提：探的是存在的一行
      if (probed.rowCount !== 1)
        throw new Error(`探锁的前提不成立：${documentId} 没有租约行`)
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

/** 一种撤权：持有者凭什么能编辑、审计的动作与操作者（闸门的键）、怎么发出、成功的状态码，以及撤权之后保存的结局 */
interface Revocation {
  readonly name: string
  readonly via: 'member' | 'grant'
  readonly action: string
  readonly actor: () => TestAccount
  readonly run: (prepared: Prepared) => Promise<Response>
  readonly status: number
  /** 撤权提交之后，持有者新发出的心跳与保存 */
  readonly afterwards: string
  /** 撤权先取完锁时，已经在等文档行的那次保存、在等租约行的那次心跳（会话守卫在撤权提交之前就放行了它们）：两者的回答相同 */
  readonly inFlight: string
}

const REVOCATIONS: readonly Revocation[] = [
  {
    name: '归档',
    via: 'member',
    action: 'spaces.archived',
    actor: () => root,
    run: async ({ space }) => asUser(app.baseUrl, rootSession, `/api/admin/spaces/${space}/archive`, { method: 'POST' }),
    status: 200,
    afterwards: '403 PERMISSION_DENIED',
    inFlight: '403 PERMISSION_DENIED',
  },
  {
    name: '移出空间',
    via: 'member',
    action: 'spaces.member_removed',
    actor: () => amy,
    run: async ({ space, holder }) => asUser(app.baseUrl, amySession, `/api/spaces/${space}/members/${holder.account.id}`, { method: 'DELETE' }),
    status: 204,
    afterwards: '404 NOT_FOUND',
    inFlight: '404 NOT_FOUND',
  },
  {
    name: '降为查看者',
    via: 'member',
    action: 'spaces.member_role_changed',
    actor: () => amy,
    run: async ({ space, holder }) => asUser(app.baseUrl, amySession, `/api/spaces/${space}/members/${holder.account.id}`, { method: 'PUT', body: { role: 'viewer' } }),
    status: 200,
    afterwards: '403 PERMISSION_DENIED',
    inFlight: '403 PERMISSION_DENIED',
  },
  {
    name: '取消授权',
    via: 'grant',
    action: 'documents.share_revoked',
    actor: () => amy,
    run: async ({ document, holder }) => asUser(app.baseUrl, amySession, `/api/documents/${document.id}/grants/${holder.account.id}`, { method: 'DELETE' }),
    status: 204,
    afterwards: '404 NOT_FOUND',
    inFlight: '404 NOT_FOUND',
  },
  {
    name: '降低授权',
    via: 'grant',
    action: 'documents.share_changed',
    actor: () => amy,
    run: async ({ document, holder }) => asUser(app.baseUrl, amySession, `/api/documents/${document.id}/grants/${holder.account.id}`, { method: 'PUT', body: { role: 'viewer' } }),
    status: 200,
    afterwards: '403 PERMISSION_DENIED',
    inFlight: '403 PERMISSION_DENIED',
  },
  {
    name: '停用',
    via: 'member',
    action: 'users.disabled',
    actor: () => root,
    run: async ({ holder }) => asUser(app.baseUrl, rootSession, `/api/admin/users/${holder.account.id}/disable`, { method: 'POST' }),
    status: 200,
    // 新的请求过不了会话守卫（停用撤销了全部登录）；已经在等锁的那次请求在守卫那里放行过了，访问策略又不看账户的状态——
    // 挡住它的是锁下对登录的再核对（M3-P1 审查 A1，lease-session.test.ts），同样 401；停用另外结束了他的租约
    afterwards: '401 SESSION_EXPIRED',
    inFlight: '401 SESSION_EXPIRED',
  },
]

describe('US-M3-12 进行中的保存与撤权必有先后：保存先取完锁，撤权等它提交才生效（收口 M2-P2 设计 §7，ADR-014）', () => {
  it.each(REVOCATIONS)('US-M3-12 保存先取完锁（停在写审计之前），$name等它提交：保存写进去，撤权随后结束租约、代次加一；之后的保存被拒绝（$afterwards）', async (revocation) => {
    const prepared = await prepare(revocation.via)
    const { holder, document } = prepared
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    const result = await interleave(
      { action: 'documents.content_saved', actorId: holder.account.id, run: async () => save(holder.session, document, lease) },
      async () => revocation.run(prepared),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([200, revocation.status, true])
    expect(await writesOf(document.id)).toEqual({ revision: 2, revisions: 2, saves: 1 })
    expect(await leaseStateOf(database, document.id)).toEqual(revoked(holder, lease))
    expect(await outcomeOf(await save(holder.session, document, lease, 2))).toBe(revocation.afterwards)
    expect(await writesOf(document.id)).toEqual({ revision: 2, revisions: 2, saves: 1 })
  })
})

/** 撤权没有收回的租约：还是这位持有者的这一代，没有明确结束，文档的代次没再加（按时间死了的租约，DEF-044） */
function untouched(holder: Person, lease: HeldLease): LeaseState {
  return { holderId: holder.account.id, endReason: null, leaseEpoch: lease.writeEpoch, documentEpoch: lease.writeEpoch }
}

/** 在途的保存期间租约怎样按时间死去：到期（挪过一个有效期），或者空闲满 12 分钟（心跳照常、没有操作） */
const DEATHS = [
  ['到期', async (documentId: string) => passLeaseTime(database, documentId, EDIT_LEASE_TTL_SECONDS)],
  ['空闲满 12 分钟', async (documentId: string) => idleLeaseFor(database, documentId, EDIT_LEASE_IDLE_RECLAIM_SECONDS)],
] as const

/**
 * 死了约 60 秒（M3-P5 复验 C5）：仍在撤权等在途保存的窗口（一个有效期）里，而且正是保存的事务的时限（60 秒，复验 C1）——窗口至少要盖住它。
 * 按行为钉住窗口的大小：窗口缩到 60 秒以下（例如 30 秒）时撤权不再等在途的保存。另一端（死了一个有效期又 1 秒的不锁）见"收回写入权的锁"
 */
const DEAD_FOR_SECONDS = 60
const DEATHS_WITHIN_WINDOW = [
  [`到期约 ${DEAD_FOR_SECONDS} 秒`, async (documentId: string) => passLeaseTime(database, documentId, EDIT_LEASE_TTL_SECONDS + DEAD_FOR_SECONDS)],
  [`空闲满 12 分钟之后又约 ${DEAD_FOR_SECONDS} 秒`, async (documentId: string) => idleLeaseFor(database, documentId, EDIT_LEASE_IDLE_RECLAIM_SECONDS + DEAD_FOR_SECONDS)],
] as const

describe('US-M3-12 在途的保存跨过了租约按时间的死亡（M3-P5 审查 A1）：撤权照样等它提交——先保存、后撤权', () => {
  it.each(REVOCATIONS)('US-M3-12 保存取完锁（停在写审计之前）之后租约到期，这时$name：等保存提交（不先于它返回）；保存写进去，租约按时间已死、不记 revoked、代次不加；之后的保存被拒绝（$afterwards）', async (revocation) => {
    const prepared = await prepare(revocation.via)
    const { holder, document } = prepared
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    const result = await interleave(
      { action: 'documents.content_saved', actorId: holder.account.id, run: async () => save(holder.session, document, lease) },
      async () => {
        // 保存已经过了租约检查、持着文档行：这时租约到期（保存的事务跨过了到期的时刻），再发撤权
        await passLeaseTime(database, document.id, EDIT_LEASE_TTL_SECONDS)
        return revocation.run(prepared)
      },
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([200, revocation.status, true])
    expect(await writesOf(document.id)).toEqual({ revision: 2, revisions: 2, saves: 1 })
    expect(await leaseStateOf(database, document.id)).toEqual(untouched(holder, lease))
    expect(await outcomeOf(await save(holder.session, document, lease, 2))).toBe(revocation.afterwards)
    expect(await writesOf(document.id)).toEqual({ revision: 2, revisions: 2, saves: 1 })
  })

  it.each(DEATHS)('US-M3-12 移出空间，在途的保存期间租约%s：同样等保存提交，不收回', async (_death, die) => {
    const prepared = await prepare('member')
    const { holder, document, space } = prepared
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    const result = await interleave(
      { action: 'documents.content_saved', actorId: holder.account.id, run: async () => save(holder.session, document, lease) },
      async () => {
        await die(document.id)
        return asUser(app.baseUrl, amySession, `/api/spaces/${space}/members/${holder.account.id}`, { method: 'DELETE' })
      },
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([200, 204, true])
    expect(await writesOf(document.id)).toEqual({ revision: 2, revisions: 2, saves: 1 })
    expect(await leaseStateOf(database, document.id)).toEqual(untouched(holder, lease))
  })

  it.each(DEATHS_WITHIN_WINDOW)('US-M3-12 移出空间，在途的保存期间租约已%s（仍在一个有效期的窗口里，M3-P5 复验 C5：按行为钉住窗口的大小）：照样等保存提交（不先于它返回）；保存写进去，不收回；之后的保存被拒绝', async (_death, die) => {
    const prepared = await prepare('member')
    const { holder, document, space } = prepared
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    const result = await interleave(
      { action: 'documents.content_saved', actorId: holder.account.id, run: async () => save(holder.session, document, lease) },
      async () => {
        // 保存已经过了租约检查、持着文档行：这时租约已经死了约 60 秒，再发撤权
        await die(document.id)
        return asUser(app.baseUrl, amySession, `/api/spaces/${space}/members/${holder.account.id}`, { method: 'DELETE' })
      },
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([200, 204, true])
    expect(await writesOf(document.id)).toEqual({ revision: 2, revisions: 2, saves: 1 })
    expect(await leaseStateOf(database, document.id)).toEqual(untouched(holder, lease))
    expect(await outcomeOf(await save(holder.session, document, lease, 2))).toBe('404 NOT_FOUND')
    expect(await writesOf(document.id)).toEqual({ revision: 2, revisions: 2, saves: 1 })
  })
})

describe('US-M3-12 进行中的保存与撤权必有先后：撤权先取完锁，保存等它提交，锁下看到变化', () => {
  it.each(REVOCATIONS)('US-M3-12 $name先取完锁（租约已结束、代次已加一，还没提交）：保存等它提交，被拒绝（$inFlight），什么也没写', async (revocation) => {
    const prepared = await prepare(revocation.via)
    const { holder, document } = prepared
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    const result = await interleave(
      { action: revocation.action, actorId: revocation.actor().id, run: async () => revocation.run(prepared) },
      async () => save(holder.session, document, lease),
    )
    expect([result.first.status, await outcomeOf(result.second), result.secondWaited]).toEqual([revocation.status, revocation.inFlight, true])
    expect(await writesOf(document.id)).toEqual({ revision: 1, revisions: 1, saves: 0 })
    expect(await leaseStateOf(database, document.id)).toEqual(revoked(holder, lease))
  })

  it.each(REVOCATIONS)('US-M3-12 $name先取完锁（租约行在它手里）：心跳等它提交，回答的是失去访问或编辑权（$inFlight），而不是租约的 revoked（M3-P1 审查 A2）', async (revocation) => {
    const prepared = await prepare(revocation.via)
    const { holder, document } = prepared
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    const result = await interleave(
      { action: revocation.action, actorId: revocation.actor().id, run: async () => revocation.run(prepared) },
      async () => renewLease(app.baseUrl, holder.session, document.id, lease),
    )
    expect([result.first.status, await outcomeOf(result.second), result.secondWaited]).toEqual([revocation.status, revocation.inFlight, true])
    // 紧接着的下一次心跳也是同样的回答：页面据此区分"还读得到就给副本"与"读不到就丢弃"，不受交错的影响
    expect(await outcomeOf(await renewLease(app.baseUrl, holder.session, document.id, lease))).toBe(revocation.afterwards)
    expect(await leaseStateOf(database, document.id)).toEqual(revoked(holder, lease))
  })
})

/** 申请与撤权交错的一种：撤权提交之后持有者的心跳与保存，以及别人（卡特，空间的编辑者）这时申请的结果 */
interface AcquireRace {
  readonly name: string
  readonly run: (prepared: Prepared) => Promise<Response>
  readonly status: number
  readonly afterwards: string
  /** 卡特的申请：状态码；成功时异常中断的提醒里有没有这位持有者 */
  readonly others: { readonly status: number, readonly notice?: boolean }
}

/** 卡特申请的结果：状态码，成功时异常中断的提醒里是谁（没有提醒为 null） */
async function takenBy(user: LoggedIn, documentId: string): Promise<{ readonly status: number, readonly interruption?: string | null }> {
  const response = await acquire(user, documentId)
  if (response.status !== 201) {
    await response.arrayBuffer()
    return { status: response.status }
  }
  return { status: 201, interruption: parseExact(acquiredEditLeaseSchema, await response.json()).interruption?.holder.id ?? null }
}

const ACQUIRE_RACES: readonly AcquireRace[] = [
  { name: '移出空间', run: async ({ space, holder }) => asUser(app.baseUrl, amySession, `/api/spaces/${space}/members/${holder.account.id}`, { method: 'DELETE' }), status: 204, afterwards: '404 NOT_FOUND', others: { status: 201, notice: false } },
  { name: '降为查看者', run: async ({ space, holder }) => asUser(app.baseUrl, amySession, `/api/spaces/${space}/members/${holder.account.id}`, { method: 'PUT', body: { role: 'viewer' } }), status: 200, afterwards: '403 PERMISSION_DENIED', others: { status: 201, notice: false } },
  // 归档之后谁也不能编辑
  { name: '归档', run: async ({ space }) => asUser(app.baseUrl, rootSession, `/api/admin/spaces/${space}/archive`, { method: 'POST' }), status: 200, afterwards: '403 PERMISSION_DENIED', others: { status: 403 } },
  // 停用不在这里：它撤销了全部登录，申请在锁下核对登录时就被拒绝（401），不写下租约（lease-session.test.ts，M3-P1 审查 A1）
]

describe('US-M3-12 申请与撤权交错：申请在撤权提交之前判断了权限、在它之后才提交（P1 设计 §3.4.6）', () => {
  it.each(ACQUIRE_RACES)('US-M3-12 申请与$name：撤权找不到这个还没提交的租约，不等申请就提交；租约行有了，但心跳与保存都被拒绝（$afterwards），编辑状态里没人在编辑', async (race) => {
    const prepared = await prepare('member')
    const { holder, document } = prepared
    // 同一个页面先前编辑过一次（申请、释放）：留下的租约行由测试持住，申请在锁下判断完权限之后（已经锁住了文档行）停在这一行上
    const earlier = await acquireLease(app.baseUrl, holder.session, document.id)
    await releaseLease(app.baseUrl, holder.session, document.id, earlier)
    let revoking: Promise<Response> | undefined
    let revokedWithoutWaiting: boolean | undefined
    const acquired = await raceAgainstHeldLock(database, {
      hold: holdLeaseRow(document.id),
      request: async () => acquire(holder.session, document.id, earlier.clientInstanceId),
      change: async () => {
        // 范围里没有这个人没结束的租约（先前那一代已经释放，这一代还没提交）：撤权不碰这份文档的行，不等申请
        revoking = race.run(prepared)
        revokedWithoutWaiting = await completesWithoutWaiting(database, revoking, 2)
      },
    })
    if (revoking === undefined)
      throw new Error('撤权没有发出')
    expect([acquired.status, (await revoking).status, revokedWithoutWaiting]).toEqual([201, race.status, true])
    const granted = parseExact(acquiredEditLeaseSchema, await acquired.json())
    const lease: HeldLease = { token: granted.token, writeEpoch: granted.writeEpoch, clientInstanceId: earlier.clientInstanceId }
    // 申请在撤权之后提交：这一代的租约行没被结束，代次也没再加
    expect(await leaseStateOf(database, document.id)).toEqual({ holderId: holder.account.id, endReason: null, leaseEpoch: lease.writeEpoch, documentEpoch: lease.writeEpoch })
    expect(await holderOutcomes(prepared, lease)).toEqual([race.afterwards, race.afterwards])
    // 别人看来没人在编辑（第 7 条）
    const status = parseExact(editStatusSchema, await (await asUser(app.baseUrl, catSession, `/api/documents/${document.id}/edit-lease`)).json())
    expect(status.editor).toBeNull()
    const { notice } = race.others
    expect(await takenBy(catSession, document.id)).toEqual(notice === undefined ? { status: race.others.status } : { status: race.others.status, interruption: notice ? holder.account.id : null })
  })

  it('US-M3-12 取消授权与申请互斥：分享的写入本身锁文档行——申请先取完锁时，取消等它提交，随后结束这个新的租约（不留第 7 条的窗口）', async () => {
    const prepared = await prepare('grant')
    const { holder, document } = prepared
    const earlier = await acquireLease(app.baseUrl, holder.session, document.id)
    await releaseLease(app.baseUrl, holder.session, document.id, earlier)
    let revoking: Promise<Response> | undefined
    let revokeWaited: boolean | undefined
    const acquired = await raceAgainstHeldLock(database, {
      hold: holdLeaseRow(document.id),
      request: async () => acquire(holder.session, document.id, earlier.clientInstanceId),
      change: async () => {
        revoking = asUser(app.baseUrl, amySession, `/api/documents/${document.id}/grants/${holder.account.id}`, { method: 'DELETE' })
        revokeWaited = !await completesWithoutWaiting(database, revoking, 2)
      },
    })
    if (revoking === undefined)
      throw new Error('取消授权没有发出')
    expect([acquired.status, (await revoking).status, revokeWaited]).toEqual([201, 204, true])
    const granted = parseExact(acquiredEditLeaseSchema, await acquired.json())
    const lease: HeldLease = { token: granted.token, writeEpoch: granted.writeEpoch, clientInstanceId: earlier.clientInstanceId }
    expect(await leaseStateOf(database, document.id)).toEqual(revoked(holder, lease))
    expect(await holderOutcomes(prepared, lease)).toEqual(['404 NOT_FOUND', '404 NOT_FOUND'])
  })
})

/**
 * 让持有者"仍能编辑、但旧的一代过时"的改动：跨空间移到他也是编辑者的空间；转移停用者的文档（授权跟着文档走，他凭单独授权仍能编辑）。
 * 收回写入权不结束他的租约（还能编辑的不动），旧的一代只靠代次失效——保存在文档行的锁下读代次、心跳在锁住租约行之后读代次，
 * 等锁之前读到的是旧的代次（M3-P1 审查 A3）。prepare 摆好持有者与文档，返回发出这个改动的办法
 */
interface Restaling {
  readonly name: string
  /** 改动的审计动作与操作者（闸门的键） */
  readonly action: string
  readonly actor: () => TestAccount
  readonly prepare: () => Promise<Prepared & { readonly change: () => Promise<Response> }>
}

const RESTALINGS: readonly Restaling[] = [
  {
    name: '跨空间移动（移到他也是编辑者的空间）',
    action: 'documents.moved',
    actor: () => amy,
    prepare: async () => {
      const prepared = await prepare('member')
      spaces += 1
      const target = await createTeamSpace(database, { name: `收回与交错 ${spaces}`, createdBy: root.id, members: { [amy.id]: 'admin', [prepared.holder.account.id]: 'editor' } })
      return { ...prepared, change: async () => asUser(app.baseUrl, amySession, `/api/documents/${prepared.document.id}/move`, { method: 'POST', body: { spaceId: target } }) }
    },
  },
  {
    name: '转移停用者的文档（他凭单独授权仍能编辑）',
    action: 'documents.transferred',
    actor: () => root,
    prepare: async () => {
      people += 2
      const owner = await createAccount(database, { username: `revocation-locks-${people - 1}` })
      const account = await createAccount(database, { username: `revocation-locks-${people}` })
      const holder = { account, session: await login(app.baseUrl, account.username, account.password) }
      const document = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '停用者的文档' })
      await setGrant(database, { documentId: document.id, userId: account.id, role: 'editor', grantedBy: owner.id })
      expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${owner.id}/disable`, { method: 'POST' })).status).toBe(200)
      spaces += 1
      const target = await createTeamSpace(database, { name: `收回与交错 ${spaces}`, createdBy: root.id, members: { [amy.id]: 'admin' } })
      const change = async (): Promise<Response> => asUser(app.baseUrl, rootSession, `/api/admin/users/${owner.id}/documents/transfer`, { method: 'POST', body: { documentIds: [document.id], target: { type: 'team', spaceId: target } } })
      return { holder, space: owner.personalSpaceId, document, change }
    },
  },
]

describe('US-M3-12 仍能编辑的持有者：改动先取完锁（代次已加一、租约没被结束），在途的保存与心跳按锁下读到的新代次判断（M3-P1 审查 A3）', () => {
  it.each(RESTALINGS)('US-M3-12 $name先取完锁，这时发出的保存等它提交：锁下读到新的代次，stale，什么也没写', async (restaling) => {
    const prepared = await restaling.prepare()
    const { holder, document } = prepared
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    const result = await interleave(
      { action: restaling.action, actorId: restaling.actor().id, run: prepared.change },
      async () => save(holder.session, document, lease),
    )
    expect([result.first.status, await outcomeOf(result.second), result.secondWaited]).toEqual([200, '409 EDIT_LEASE_LOST:stale', true])
    expect(await writesOf(document.id)).toEqual({ revision: 1, revisions: 1, saves: 0 })
    expect(await leaseStateOf(database, document.id)).toEqual({ holderId: holder.account.id, endReason: null, leaseEpoch: lease.writeEpoch, documentEpoch: lease.writeEpoch + 1 })
  })

  it.each(RESTALINGS)('US-M3-12 $name先取完锁（租约行在它手里），这时发出的心跳等它提交：锁住租约行之后读到新的代次，stale；同一个页面重新申请之后接着保存（续上）', async (restaling) => {
    const prepared = await restaling.prepare()
    const { holder, document } = prepared
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    const result = await interleave(
      { action: restaling.action, actorId: restaling.actor().id, run: prepared.change },
      async () => renewLease(app.baseUrl, holder.session, document.id, lease),
    )
    expect([result.first.status, await outcomeOf(result.second), result.secondWaited]).toEqual([200, '409 EDIT_LEASE_LOST:stale', true])
    const again = await acquireLease(app.baseUrl, holder.session, document.id, lease.clientInstanceId)
    expect(await outcomeOf(await save(holder.session, document, again))).toBe('200')
  })
})

describe('US-M3-12 收回写入权的锁（P1 设计 §3.4.6、ADR-014 的锁顺序：文档行之后是租约行）', () => {
  it('US-M3-12 锁的顺序：撤权先锁文档行、再锁租约行——停在文档行上时租约行还没被锁；放开之后照常结束租约', async () => {
    const prepared = await prepare('member')
    const { holder, document, space } = prepared
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    const archived = await raceAgainstHeldLock(database, {
      hold: holdDocuments(document.id),
      request: async () => asUser(app.baseUrl, rootSession, `/api/admin/spaces/${space}/archive`, { method: 'POST' }),
      change: async () => {
        expect(await leaseRowLock(document.id)).toBe('free')
      },
    })
    expect(archived.status).toBe(200)
    expect(await leaseStateOf(database, document.id)).toEqual(revoked(holder, lease))
  })

  it('US-M3-12 锁下再核对一次范围：停用等文档行的锁期间，别人申请到了新的一代（上一位退出了登录，租约按登录失效、还没到期）——这一行已经不是他的，新持有者的租约不动', async () => {
    const prepared = await prepare('member')
    const { holder, document } = prepared
    await acquireLease(app.baseUrl, holder.session, document.id)
    // 登录失效、还没到期（M3-P5 设计 §3.5）：按时间还活着，两条语句都找它；已到期的租约第二条本来就不交出，看不出它按改写之后的行再核对范围
    expect((await asUser(app.baseUrl, holder.session, '/api/auth/logout', { method: 'POST' })).status).toBe(204)
    const [taken, disabled] = await raceAgainstHeldLock(database, {
      // 持住租约行：卡特的申请锁住文档行之后停在这里；停用随后找到"他没结束的租约"，在文档行上等卡特的申请
      hold: holdLeaseRow(document.id),
      waiting: 2,
      request: async ({ step, waitForWaiting }) => {
        const taking = step(acquire(catSession, document.id))
        await waitForWaiting(1)
        return Promise.all([taking, step(asUser(app.baseUrl, rootSession, `/api/admin/users/${holder.account.id}/disable`, { method: 'POST' }))])
      },
      change: async client => client.query('SELECT 1'),
    })
    expect([taken?.status, disabled?.status]).toEqual([201, 200])
    const granted = parseExact(acquiredEditLeaseSchema, await taken?.json())
    expect(await leaseStateOf(database, document.id)).toEqual({ holderId: cat.id, endReason: null, leaseEpoch: granted.writeEpoch, documentEpoch: granted.writeEpoch })
    const catLease: HeldLease = { token: granted.token, writeEpoch: granted.writeEpoch, clientInstanceId: randomUUID() }
    expect(await outcomeOf(await renewLease(app.baseUrl, catSession, document.id, catLease))).toBe('200')
  })

  it('US-M3-12 范围只锁涉及的文档：移出空间时，他在别的空间里编辑的、别人在这个空间里编辑的文档行都不锁（测试持住它们，移出照常完成、不等）', async () => {
    const prepared = await prepare('member')
    const { holder, document, space } = prepared
    spaces += 1
    const elsewhere = await createTeamSpace(database, { name: `收回与交错 ${spaces}`, createdBy: root.id, members: { [amy.id]: 'admin', [holder.account.id]: 'editor' } })
    const other = await seedDocument(database, { spaceId: elsewhere, createdBy: amy.id, title: '别的空间' })
    const cats = await seedDocument(database, { spaceId: space, createdBy: amy.id, title: '别人在编辑' })
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    const otherLease = await acquireLease(app.baseUrl, holder.session, other.id)
    const catLease = await acquireLease(app.baseUrl, catSession, cats.id)
    const removed = await whileHolding(database, holdDocuments(other.id, cats.id), async () => {
      const removing = asUser(app.baseUrl, amySession, `/api/spaces/${space}/members/${holder.account.id}`, { method: 'DELETE' })
      expect(await completesWithoutWaiting(database, removing, 1)).toBe(true)
      return removing
    })
    expect(removed.status).toBe(204)
    expect(await leaseStateOf(database, document.id)).toEqual(revoked(holder, lease))
    expect(await leaseStateOf(database, other.id)).toMatchObject({ endReason: null, documentEpoch: otherLease.writeEpoch })
    expect(await leaseStateOf(database, cats.id)).toMatchObject({ endReason: null, documentEpoch: catLease.writeEpoch })
  })

  it('US-M3-10 死了超过一个有效期的租约（到期、空闲满 12 分钟都在一个有效期之前）不在撤权的范围里（M3-P5 设计 §3.5，DEF-044）：测试持住它们的文档行，归档与移出照常完成、不等；租约不记 revoked、代次不加', async () => {
    const prepared = await prepare('member')
    const { holder, document, space } = prepared
    const idle = await seedDocument(database, { spaceId: space, createdBy: amy.id, title: '空闲满 12 分钟' })
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    const idleLease = await acquireLease(app.baseUrl, catSession, idle.id)
    // 到期、空闲回收都发生在一个有效期（再多一秒）之前：在途的保存不可能还用着它们（M3-P5 审查 A1 的上界）
    await passLeaseTime(database, document.id, EDIT_LEASE_TTL_SECONDS + EDIT_LEASE_TTL_SECONDS + 1)
    await idleLeaseFor(database, idle.id, EDIT_LEASE_IDLE_RECLAIM_SECONDS + EDIT_LEASE_TTL_SECONDS + 1)
    const removed = await whileHolding(database, holdDocuments(document.id, idle.id), async () => {
      const removing = asUser(app.baseUrl, amySession, `/api/spaces/${space}/members/${holder.account.id}`, { method: 'DELETE' })
      expect(await completesWithoutWaiting(database, removing, 1)).toBe(true)
      return removing
    })
    expect(removed.status).toBe(204)
    const archived = await whileHolding(database, holdDocuments(document.id, idle.id), async () => {
      const archiving = asUser(app.baseUrl, rootSession, `/api/admin/spaces/${space}/archive`, { method: 'POST' })
      expect(await completesWithoutWaiting(database, archiving, 1)).toBe(true)
      return archiving
    })
    expect(archived.status).toBe(200)
    expect(await leaseStateOf(database, document.id)).toEqual({ holderId: holder.account.id, endReason: null, leaseEpoch: lease.writeEpoch, documentEpoch: lease.writeEpoch })
    expect(await leaseStateOf(database, idle.id)).toEqual({ holderId: cat.id, endReason: null, leaseEpoch: idleLease.writeEpoch, documentEpoch: idleLease.writeEpoch })
  })

  it('US-M3-12 对照：还活着的租约的文档行被持住时，归档等它（不是因为"不等"才通过上一条）', async () => {
    const prepared = await prepare('member')
    const { holder, document, space } = prepared
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    const archived = await raceAgainstHeldLock(database, {
      hold: holdDocuments(document.id),
      request: async () => asUser(app.baseUrl, rootSession, `/api/admin/spaces/${space}/archive`, { method: 'POST' }),
      change: async () => undefined,
    })
    expect(archived.status).toBe(200)
    expect(await leaseStateOf(database, document.id)).toEqual(revoked(holder, lease))
  })

  it.each(DEATHS)('US-M3-12 刚死不久的租约（一个有效期之内%s）：撤权锁它的文档行等在途的保存（测试持住时，移出等它）——放开之后照常完成，只是不收回（不记 revoked、代次不加，DEF-044；M3-P5 审查 A1）', async (_death, die) => {
    const prepared = await prepare('member')
    const { holder, document, space } = prepared
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    await die(document.id)
    const removed = await raceAgainstHeldLock(database, {
      hold: holdDocuments(document.id),
      request: async () => asUser(app.baseUrl, amySession, `/api/spaces/${space}/members/${holder.account.id}`, { method: 'DELETE' }),
      change: async () => undefined,
    })
    expect(removed.status).toBe(204)
    expect(await leaseStateOf(database, document.id)).toEqual(untouched(holder, lease))
  })

  it('US-M3-12 范围只锁涉及的租约：取消一个人的授权、还没提交时，同一份文档上正在编辑的别人照常心跳，不等它（他的租约行不在范围里）', async () => {
    const prepared = await prepare('grant')
    const { holder, document } = prepared
    // 被取消授权的人没在编辑；正在编辑这份文档的是卡特
    const catLease = await acquireLease(app.baseUrl, catSession, document.id)
    let heartbeat: Promise<Response> | undefined
    let heartbeatWaited: boolean | undefined
    const unshared = await raceAgainstHeldLock(database, {
      hold: holdGate('documents.share_revoked', amy.id),
      request: async () => asUser(app.baseUrl, amySession, `/api/documents/${document.id}/grants/${holder.account.id}`, { method: 'DELETE' }),
      change: async () => {
        heartbeat = renewLease(app.baseUrl, catSession, document.id, catLease)
        heartbeatWaited = !await completesWithoutWaiting(database, heartbeat, 2)
      },
    })
    if (heartbeat === undefined)
      throw new Error('心跳没有发出')
    expect([unshared.status, await outcomeOf(await heartbeat), heartbeatWaited]).toEqual([204, '200', false])
    expect(await leaseStateOf(database, document.id)).toEqual({ holderId: cat.id, endReason: null, leaseEpoch: catLease.writeEpoch, documentEpoch: catLease.writeEpoch })
  })
})
