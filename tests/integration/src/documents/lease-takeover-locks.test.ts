// 本人接管、强制接管与进行中的保存、心跳、降级，以及两个管理员同时强制接管（M3-P5 设计 §3.12）：两个连接构造的确定交错。
// 接管走申请的路：先锁文档行、再锁租约行，强制接管的审计排在最后（锁的顺序：文档行 → 租约行 → 审计，ADR-014）。所以——
// 1. 与保存：保存在租约这一步之前锁住了文档行，两者必有先后。保存先：接管等它提交，保存写进去，接管的响应里是保存之后的修订号；
//    接管先：保存等文档行，锁下看到新的一代，409 taken_over（带方式），什么也没写；
// 2. 与心跳：心跳只锁租约行，与接管在租约行上排队。心跳先：续租照常，接管随后照常；接管先：心跳锁住的是新的一代，taken_over；
// 3. 两个管理员：在文档行上排队，后到的接管先到的（两条审计）；接管标记只记一层，最初的持有者之后得到 replaced；
// 4. 与降级：降级在接管不加锁的判断之后、锁下的判断之前提交，锁下的判断拒绝（403）；接管先取完锁时，降级的收回写入权找不到这一代
//    还没提交的租约，不等它，租约行有了，由有效条件第 7 条在每次使用时让它失效（同 lease-revocation-locks.test.ts 的申请与撤权）。
// 写法同 lease-revocation-locks.test.ts："先取完锁的操作"停在写审计之前——给 audit_events 装 BEFORE INSERT 的触发器，按"动作 + 操作者"
// 取 advisory 共享锁（闸门），测试的连接持有同一个键的排他锁；或者测试持住租约行、文档行，让几个请求依次停在上面。
// 持锁构造的前提由 held-lock.ts 自己核对。
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { HeldLease } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { acquiredEditLeaseSchema, editStatusSchema, errorResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { acquireBody } from '../support/client-format.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, outcomeOf, renewLease, saveContent } from '../support/edit-leases.ts'
import { completesWithoutWaiting, raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
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
  root = await createAccount(database, { username: 'takeover-locks-root', systemRole: 'admin' })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

interface Person {
  readonly account: TestAccount
  readonly session: LoggedIn
}

/** 一个团队空间里的一份文档：两个空间管理员（艾米、安）、一个编辑者（本，正在编辑），各个用例各用各的人（会被降级） */
interface Prepared {
  readonly space: string
  readonly document: SeededDocument
  readonly amy: Person
  readonly ann: Person
  readonly ben: Person
  /** 本申请到的租约（同一个页面：令牌、代次与标签页） */
  readonly lease: HeldLease
}

async function person(): Promise<Person> {
  people += 1
  const account = await createAccount(database, { username: `takeover-locks-${people}` })
  return { account, session: await login(app.baseUrl, account.username, account.password) }
}

async function prepare(): Promise<Prepared> {
  const [amy, ann, ben] = [await person(), await person(), await person()]
  spaces += 1
  const space = await createTeamSpace(database, { name: `接管与交错 ${spaces}`, createdBy: root.id, members: { [amy.account.id]: 'admin', [ann.account.id]: 'admin', [ben.account.id]: 'editor' } })
  const document = await seedDocument(database, { spaceId: space, createdBy: amy.account.id, title: '接管与交错' })
  return { space, document, amy, ann, ben, lease: await acquireLease(app.baseUrl, ben.session, document.id) }
}

/** 一种接管：本人接管（本在另一台设备上）或强制接管（空间管理员艾米）；被接管的那一代之后得到的 forced */
interface Takeover {
  readonly name: string
  readonly mode: 'self' | 'force'
  readonly taker: (prepared: Prepared) => Promise<Person>
  readonly forced: boolean
}

const TAKEOVERS: readonly Takeover[] = [
  { name: '本人接管（另一台设备）', mode: 'self', taker: async ({ ben }) => ({ account: ben.account, session: await login(app.baseUrl, ben.account.username, ben.account.password) }), forced: false },
  { name: '强制接管（空间管理员）', mode: 'force', taker: async ({ amy }) => amy, forced: true },
]

/** 以这个人申请，带上接管方式 */
async function takeOver(taker: Person, documentId: string, mode: 'self' | 'force'): Promise<Response> {
  return asUser(app.baseUrl, taker.session, `/api/documents/${documentId}/edit-lease`, { method: 'POST', body: { ...acquireBody(randomUUID()), takeover: mode } })
}

async function save(user: LoggedIn, document: SeededDocument, lease: HeldLease): Promise<Response> {
  const raw = Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: document.unitId }), 'utf8')
  return saveContent(app.baseUrl, user, document.id, zlib.gzipSync(raw), { baseRevision: 1, lease })
}

/** 申请成功的响应：令牌、代次与修订号 */
async function grantedBy(response: Response): Promise<{ readonly token: string, readonly writeEpoch: number, readonly revision: number }> {
  expect(response.status, await response.clone().text()).toBe(201)
  return parseExact(acquiredEditLeaseSchema, await response.json())
}

/** 这份文档的修订号、修订记录的条数与保存的审计条数 */
async function writesOf(documentId: string): Promise<{ readonly revision: number | undefined, readonly revisions: number, readonly saves: number }> {
  return database.query(async client => ({
    revision: (await client.query<{ revision: number }>('SELECT revision FROM documents WHERE id = $1', [documentId])).rows[0]?.revision,
    revisions: Number((await client.query<{ count: string }>('SELECT count(*) FROM document_revisions WHERE document_id = $1', [documentId])).rows[0]?.count),
    saves: Number((await client.query<{ count: string }>('SELECT count(*) FROM audit_events WHERE target_id = $1 AND action = \'documents.content_saved\'', [documentId])).rows[0]?.count),
  }))
}

/** 租约行：持有者、明确结束、接管方式与接管标记是不是这个令牌的摘要；文档现在的代次 */
async function leaseRowOf(documentId: string, takenToken?: string): Promise<{ readonly holderId: string, readonly endReason: string | null, readonly takeover: string | null, readonly marksToken: boolean, readonly leaseEpoch: number, readonly documentEpoch: number } | undefined> {
  const row = await database.query(async client => (await client.query<{ holder_id: string, end_reason: string | null, takeover: string | null, taken_over_token_digest: Buffer | null, lease_epoch: number, document_epoch: number }>(
    `SELECT l.holder_id, l.end_reason, l.takeover, l.taken_over_token_digest, l.write_epoch AS lease_epoch, d.write_epoch AS document_epoch
     FROM document_edit_leases l JOIN documents d ON d.id = l.document_id WHERE l.document_id = $1`,
    [documentId],
  )).rows[0])
  if (row === undefined)
    return undefined
  const marksToken = takenToken !== undefined && row.taken_over_token_digest !== null && row.taken_over_token_digest.equals(createHash('sha256').update(takenToken, 'utf8').digest())
  return { holderId: row.holder_id, endReason: row.end_reason, takeover: row.takeover, marksToken, leaseEpoch: row.lease_epoch, documentEpoch: row.document_epoch }
}

/** 这份文档上强制接管的审计：操作者与被接管的人，按写入的先后 */
async function takeoverAuditsOf(documentId: string): Promise<{ readonly actorId: string, readonly holderId: string }[]> {
  return database.query(async client => (await client.query<{ actorId: string, holderId: string }>(
    `SELECT actor_id AS "actorId", details->>'holderId' AS "holderId" FROM audit_events
     WHERE action = 'documents.edit_taken_over' AND target_id = $1 ORDER BY occurred_at, id`,
    [documentId],
  )).rows)
}

/** 在持锁的事务里关上这个操作的闸门 */
function holdGate(action: string, actorId: string) {
  return async (client: pg.Client) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`audit-gate:${action}:${actorId}`])
}

/** 在持锁的事务里锁住这份文档的租约行（申请、接管、心跳、释放都要锁它） */
function holdLeaseRow(documentId: string) {
  return async (client: pg.Client) => {
    const locked = await client.query('SELECT 1 FROM document_edit_leases WHERE document_id = $1 FOR UPDATE', [documentId])
    if (locked.rowCount !== 1)
      throw new Error(`持锁的前提不成立：${documentId} 没有租约行`)
  }
}

/** 在持锁的事务里锁住这份文档的文档行（申请、接管、保存都要锁它） */
function holdDocument(documentId: string) {
  return async (client: pg.Client) => {
    const locked = await client.query('SELECT 1 FROM documents WHERE id = $1 FOR UPDATE', [documentId])
    if (locked.rowCount !== 1)
      throw new Error(`持锁的前提不成立：没有文档 ${documentId}`)
  }
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

/** 测试持住 held 的那把锁，first、second 依次停在锁上（second 排在 first 后面），放开之后按先后进行 */
async function inOrder(hold: (client: pg.Client) => Promise<unknown>, first: () => Promise<Response>, second: () => Promise<Response>): Promise<[Response, Response]> {
  return raceAgainstHeldLock(database, {
    hold,
    request: async ({ step, waitForWaiting }) => {
      const a = step(first())
      await waitForWaiting(1)
      const b = step(second())
      await waitForWaiting(2)
      return Promise.all([a, b])
    },
    change: async () => undefined,
    waiting: 2,
  })
}

/** 把这个人在这个空间里的角色改掉（经接口，空间管理员艾米操作：收回写入权随之进行） */
async function setRole(prepared: Prepared, target: Person, role: 'editor' | 'viewer'): Promise<Response> {
  return asUser(app.baseUrl, prepared.amy.session, `/api/spaces/${prepared.space}/members/${target.account.id}`, { method: 'PUT', body: { role } })
}

describe('US-M3-08 接管与持有者进行中的保存必有先后（设计 §3.12）', () => {
  it.each(TAKEOVERS)('US-M3-08 $name：保存先取完锁（停在写审计之前），接管等文档行——保存写进去，接管随后照常取得新的一代，响应里是保存之后的修订号；之后旧令牌得到 taken_over', async (takeover) => {
    const prepared = await prepare()
    const { document, ben, lease } = prepared
    const taker = await takeover.taker(prepared)
    const result = await interleave(
      { action: 'documents.content_saved', actorId: ben.account.id, run: async () => save(ben.session, document, lease) },
      async () => takeOver(taker, document.id, takeover.mode),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([200, 201, true])
    const granted = await grantedBy(result.second)
    expect([granted.revision, granted.writeEpoch]).toEqual([2, lease.writeEpoch + 1])
    expect(await writesOf(document.id)).toEqual({ revision: 2, revisions: 2, saves: 1 })
    expect(await outcomeOf(await renewLease(app.baseUrl, ben.session, document.id, lease))).toBe('409 EDIT_LEASE_LOST:taken_over')
    expect(await leaseRowOf(document.id, lease.token)).toMatchObject({ holderId: taker.account.id, takeover: takeover.forced ? 'forced' : 'self', marksToken: true })
  })

  it.each(TAKEOVERS)('US-M3-08 $name：接管先锁住文档行（停在租约行上），保存等文档行——接管提交之后，保存在锁下看到新的一代：409 taken_over（forced 按方式），什么也没写', async (takeover) => {
    const prepared = await prepare()
    const { document, ben, lease } = prepared
    const taker = await takeover.taker(prepared)
    const [taken, saved] = await inOrder(holdLeaseRow(document.id), async () => takeOver(taker, document.id, takeover.mode), async () => save(ben.session, document, lease))
    expect(taken.status, await taken.clone().text()).toBe(201)
    const { error } = parseExact(errorResponseSchema, await saved.json())
    expect([saved.status, error.code, error.details]).toEqual([409, 'EDIT_LEASE_LOST', { reason: 'taken_over', forced: takeover.forced }])
    expect(await writesOf(document.id)).toEqual({ revision: 1, revisions: 1, saves: 0 })
  })
})

describe('US-M3-08 接管与持有者的心跳在租约行上排队（设计 §3.12）', () => {
  it.each(TAKEOVERS)('US-M3-08 $name：心跳先拿到租约行，接管（已经锁住了文档行）排在它后面——续租照常，接管随后照常取得新的一代；之后旧令牌的心跳得到 taken_over', async (takeover) => {
    const prepared = await prepare()
    const { document, ben, lease } = prepared
    const taker = await takeover.taker(prepared)
    const [renewed, taken] = await inOrder(holdLeaseRow(document.id), async () => renewLease(app.baseUrl, ben.session, document.id, lease), async () => takeOver(taker, document.id, takeover.mode))
    expect([await outcomeOf(renewed), taken.status]).toEqual(['200', 201])
    expect(await outcomeOf(await renewLease(app.baseUrl, ben.session, document.id, lease))).toBe('409 EDIT_LEASE_LOST:taken_over')
    expect(await leaseRowOf(document.id, lease.token)).toMatchObject({ holderId: taker.account.id, endReason: null, marksToken: true })
  })

  it.each(TAKEOVERS)('US-M3-08 $name：接管先拿到租约行，心跳排在它后面——接管提交之后，心跳锁住的是新的一代：409 taken_over（forced 按方式），没有续租', async (takeover) => {
    const prepared = await prepare()
    const { document, ben, lease } = prepared
    const taker = await takeover.taker(prepared)
    const [taken, renewed] = await inOrder(holdLeaseRow(document.id), async () => takeOver(taker, document.id, takeover.mode), async () => renewLease(app.baseUrl, ben.session, document.id, lease))
    const granted = await grantedBy(taken)
    const { error } = parseExact(errorResponseSchema, await renewed.json())
    expect([renewed.status, error.code, error.details]).toEqual([409, 'EDIT_LEASE_LOST', { reason: 'taken_over', forced: takeover.forced }])
    expect(await leaseRowOf(document.id, lease.token)).toMatchObject({ holderId: taker.account.id, leaseEpoch: granted.writeEpoch, documentEpoch: granted.writeEpoch, marksToken: true })
  })
})

describe('US-M3-09 两个空间管理员同时强制接管（设计 §3.12）', () => {
  it('US-M3-09 测试持住文档行，艾米、安依次停在锁上：先到的接管编辑者，后到的接管先到的——两条审计各记被接管的人；接管标记只记一层：编辑者的令牌得到 replaced，先到的管理员的令牌得到 taken_over（forced: true）', async () => {
    const prepared = await prepare()
    const { document, amy, ann, ben, lease } = prepared
    const [first, second] = await inOrder(holdDocument(document.id), async () => takeOver(amy, document.id, 'force'), async () => takeOver(ann, document.id, 'force'))
    const amys = await grantedBy(first)
    const anns = await grantedBy(second)
    expect([amys.writeEpoch, anns.writeEpoch]).toEqual([lease.writeEpoch + 1, lease.writeEpoch + 2])
    expect(await takeoverAuditsOf(document.id)).toEqual([{ actorId: amy.account.id, holderId: ben.account.id }, { actorId: ann.account.id, holderId: amy.account.id }])
    expect(await leaseRowOf(document.id, amys.token)).toMatchObject({ holderId: ann.account.id, takeover: 'forced', marksToken: true })
    expect(await outcomeOf(await renewLease(app.baseUrl, ben.session, document.id, lease))).toBe('409 EDIT_LEASE_LOST:replaced')
    const amyLease: HeldLease = { token: amys.token, writeEpoch: amys.writeEpoch, clientInstanceId: randomUUID() }
    const { error } = parseExact(errorResponseSchema, await (await renewLease(app.baseUrl, amy.session, document.id, amyLease)).json())
    expect([error.code, error.details]).toEqual(['EDIT_LEASE_LOST', { reason: 'taken_over', forced: true }])
  })
})

describe('US-M3-09 强制接管与管理员被降级交错（设计 §3.12）', () => {
  it('US-M3-09 降级先提交：安在不加锁的判断之后、锁下的判断之前（停在文档行上）被降为编辑者——锁下的判断 403（只有空间管理员能…），什么也不写；编辑者的租约照常', async () => {
    const prepared = await prepare()
    const { document, ann, ben, lease } = prepared
    const denied = await raceAgainstHeldLock(database, {
      hold: holdDocument(document.id),
      request: async () => takeOver(ann, document.id, 'force'),
      change: async () => {
        // 降为编辑者：收回写入权只看安的租约（他没有），不碰这份文档的行，不等测试持着的锁
        const demoted = await setRole(prepared, ann, 'editor')
        expect(demoted.status, await demoted.clone().text()).toBe(200)
      },
    })
    const { error } = parseExact(errorResponseSchema, await denied.json())
    expect([denied.status, error.code, error.message]).toEqual([403, 'PERMISSION_DENIED', '只有空间管理员能强制接管这份文档的编辑'])
    expect(await leaseRowOf(document.id)).toMatchObject({ holderId: ben.account.id, endReason: null, takeover: null, leaseEpoch: lease.writeEpoch, documentEpoch: lease.writeEpoch })
    expect(await takeoverAuditsOf(document.id)).toEqual([])
    expect(await outcomeOf(await renewLease(app.baseUrl, ben.session, document.id, lease))).toBe('200')
  })

  it('US-M3-09 接管先取完锁（停在写审计之前），这时安被降为查看者：收回写入权找不到这一代还没提交的租约，不等它就提交；接管照样完成、审计照写——租约行在安手里，但心跳与保存 403（没了编辑权先于租约），编辑状态里没人在编辑（有效条件第 7 条）；编辑者的令牌仍是 taken_over', async () => {
    const prepared = await prepare()
    const { document, amy, ann, ben, lease } = prepared
    const result = await interleave(
      { action: 'documents.edit_taken_over', actorId: ann.account.id, run: async () => takeOver(ann, document.id, 'force') },
      async () => setRole(prepared, ann, 'viewer'),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([201, 200, false])
    const granted = await grantedBy(result.first)
    expect(await leaseRowOf(document.id, lease.token)).toEqual({ holderId: ann.account.id, endReason: null, takeover: 'forced', marksToken: true, leaseEpoch: granted.writeEpoch, documentEpoch: granted.writeEpoch })
    expect(await takeoverAuditsOf(document.id)).toEqual([{ actorId: ann.account.id, holderId: ben.account.id }])
    const anns: HeldLease = { token: granted.token, writeEpoch: granted.writeEpoch, clientInstanceId: randomUUID() }
    expect(await outcomeOf(await renewLease(app.baseUrl, ann.session, document.id, anns))).toBe('403 PERMISSION_DENIED')
    expect(await outcomeOf(await save(ann.session, document, anns))).toBe('403 PERMISSION_DENIED')
    const status = parseExact(editStatusSchema, await (await asUser(app.baseUrl, amy.session, `/api/documents/${document.id}/edit-lease`)).json())
    expect([status.editor, status.interruption]).toEqual([null, null])
    expect(await outcomeOf(await renewLease(app.baseUrl, ben.session, document.id, lease))).toBe('409 EDIT_LEASE_LOST:taken_over')
  })
})
