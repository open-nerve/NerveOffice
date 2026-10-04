// 另存为副本与其他操作的确定交错（US-M3-12，M3-P2 复核 B3）：另存持有的锁（requestId 的 advisory lock → 原文档所在空间的树锁
// （只在要放进那个空间时取）→ 原文档所在的空间与本人个人空间的行（FOR SHARE，按 id）→ 原文档行（FOR SHARE））
// 与其他操作互斥的范围要对——该等的等、不该等的不等；两边都结束、不成环，结果与先后一致。
// 每一类操作至少有一个方向：原文档行上的改动（改名、移到根目录、跨空间移动、删除、分享与取消授权、申请编辑权）、原文档所在的文件夹、
// 原文档所在空间的成员与状态、原文档所在空间里的结构改动（在源文件夹里新建要等树锁；在根目录新建只取空间行的共享锁，不等）、
// 本人个人空间里的新建（个人空间的行只被共享地持有，不等）、不相干的操作（复制到别的空间）与另一个人的另存（等）。
// 另一个操作先提交时，另存在锁下读到的是它提交之后的样子：
// - 跨空间移动 → 404：空间行是按取锁之前读到的空间取的，保护不到这一次移走，锁下核对原文档还在那个空间（document-conflict-copy.service.ts
//   的 spaceId 复核），不在就按"没找到"回答，不放进移到的那个空间（那里的行锁、树锁都没有取）；
// - 删除、删除源文件夹、移出空间、取消授权（只凭授权的人）→ 404，什么也不写；
// - 归档、降为查看者 → 放进本人的个人空间；改名、移到根目录、在源文件夹里新建、另一个人的另存 → 照常放进原文档现在所在的地方。
// 锁下重新判断的另几条（取锁之前被降级、移出、取消授权，原文档在空间内换了文件夹，持锁时降级）另见 conflict-copies.test.ts。
//
// 做法同 copy-locks.test.ts：给 audit_events 装一个 BEFORE INSERT 的触发器，按"动作 + 操作者"取 advisory 共享锁（闸门）。测试的连接在事务里
// 持有同一个键的排他锁时，那个操作就停在写审计之前——这时它已经取完了自己要的全部锁；再发另一个操作，看它是否在锁上等待
// （completesWithoutWaiting），然后放开闸门。触发器只装在这个文件自己的库里。申请编辑权不写审计，只作为后发的一方。
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { createdDocumentSchema, errorResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { postConflictCopy } from '../support/conflict-copies.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { setGrants } from '../support/grants.ts'
import { completesWithoutWaiting, raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
/** 系统管理员（建团队空间、归档）；艾米是空间管理员，本是编辑者，吉尔只有原文档的查看授权 */
let root: TestAccount
let amy: TestAccount
let ben: TestAccount
let gil: TestAccount
let rootSession: LoggedIn
let amySession: LoggedIn
let benSession: LoggedIn
let gilSession: LoggedIn
let worlds = 0

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

/** 在持锁的事务里关上这个操作的闸门 */
function holdGate(action: string, actorId: string) {
  return async (client: pg.Client) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`audit-gate:${action}:${actorId}`])
}

beforeAll(async () => {
  database = await createTestDatabase()
  await database.query(async client => client.query(GATE_DDL))
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'root', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy', displayName: '艾米' })
  ben = await createAccount(database, { username: 'ben', displayName: '本' })
  gil = await createAccount(database, { username: 'gil', displayName: '吉尔' })
  rootSession = await login(app.baseUrl, 'root', root.password)
  amySession = await login(app.baseUrl, 'amy', amy.password)
  benSession = await login(app.baseUrl, 'ben', ben.password)
  gilSession = await login(app.baseUrl, 'gil', gil.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function call(session: LoggedIn, path: string, method: string, body?: unknown): Promise<Response> {
  return asUser(app.baseUrl, session, path, body === undefined ? { method } : { method, body })
}

/** 一次用例的世界：艾米是两个团队空间的空间管理员，本是编辑者；原文档在源空间的源文件夹里，吉尔有它的查看授权 */
interface World {
  /** 原文档所在的空间 */
  readonly source: string
  /** 另一个空间（跨空间移动与复制的去处） */
  readonly elsewhere: string
  /** 原文档所在的文件夹（源空间里） */
  readonly sourceFolder: string
  readonly document: SeededDocument
}

async function buildWorld(): Promise<World> {
  worlds += 1
  const members = { [amy.id]: 'admin', [ben.id]: 'editor' } as const
  const source = await createTeamSpace(database, { name: `源 ${worlds}`, createdBy: root.id, members })
  const elsewhere = await createTeamSpace(database, { name: `别处 ${worlds}`, createdBy: root.id, members })
  const created = await call(amySession, '/api/folders', 'POST', { spaceId: source, name: '源文件夹', requestId: randomUUID() })
  expect(created.status).toBe(201)
  const sourceFolder = ((await created.json()) as { id: string }).id
  const document = await seedDocument(database, { spaceId: source, createdBy: amy.id, title: '周报', folderId: sourceFolder })
  await setGrants(database, [{ documentId: document.id, userId: gil.id, role: 'viewer', grantedBy: amy.id }])
  return { source, elsewhere, sourceFolder, document }
}

/** 这个人对这份原文档另存出的副本（按审计找）：404 的用例核对什么也没写 */
async function copiesBy(account: TestAccount, sourceId: string): Promise<number> {
  return database.query(async client => (await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM audit_events WHERE action = 'documents.conflict_copied' AND details->>'sourceId' = $1 AND actor_id = $2`,
    [sourceId, account.id],
  )).rows[0]?.count ?? 0)
}

/** 与另存交错的另一个操作 */
interface Other {
  /** 这个操作的审计动作与操作者（闸门的键）；不写审计的操作没有，只能后发 */
  readonly action: string | undefined
  readonly actor: () => TestAccount
  readonly run: (world: World) => Promise<Response>
  /** 这个操作单独执行时的状态码 */
  readonly status: number
}

const OTHERS = {
  // 原文档行上的改动
  renameSource: { action: 'documents.renamed', actor: () => amy, status: 200, run: async w => call(amySession, `/api/documents/${w.document.id}`, 'PATCH', { title: '改过的标题' }) },
  moveSourceToRoot: { action: 'documents.moved', actor: () => amy, status: 200, run: async w => call(amySession, `/api/documents/${w.document.id}`, 'PATCH', { folderId: null }) },
  moveSourceAcross: { action: 'documents.moved', actor: () => amy, status: 200, run: async w => call(amySession, `/api/documents/${w.document.id}/move`, 'POST', { spaceId: w.elsewhere }) },
  deleteSource: { action: 'documents.deleted', actor: () => amy, status: 204, run: async w => call(amySession, `/api/documents/${w.document.id}`, 'DELETE') },
  revokeGil: { action: 'documents.share_revoked', actor: () => amy, status: 204, run: async w => call(amySession, `/api/documents/${w.document.id}/grants/${gil.id}`, 'DELETE') },
  shareWithRoot: { action: 'documents.shared', actor: () => amy, status: 200, run: async w => call(amySession, `/api/documents/${w.document.id}/grants/${root.id}`, 'PUT', { role: 'viewer' }) },
  acquireLeaseSource: { action: undefined, actor: () => amy, status: 201, run: async w => call(amySession, `/api/documents/${w.document.id}/edit-lease`, 'POST', { clientInstanceId: randomUUID() }) },
  // 原文档所在的文件夹
  deleteSourceFolder: { action: 'folders.deleted', actor: () => amy, status: 204, run: async w => call(amySession, `/api/folders/${w.sourceFolder}`, 'DELETE') },
  // 原文档所在空间的成员与状态
  archiveSource: { action: 'spaces.archived', actor: () => root, status: 200, run: async w => call(rootSession, `/api/admin/spaces/${w.source}/archive`, 'POST') },
  benViewerInSource: { action: 'spaces.member_role_changed', actor: () => amy, status: 200, run: async w => call(amySession, `/api/spaces/${w.source}/members/${ben.id}`, 'PUT', { role: 'viewer' }) },
  removeBenFromSource: { action: 'spaces.member_removed', actor: () => amy, status: 204, run: async w => call(amySession, `/api/spaces/${w.source}/members/${ben.id}`, 'DELETE') },
  // 原文档所在空间里的结构改动
  createInSourceRoot: { action: 'documents.created', actor: () => amy, status: 201, run: async w => call(amySession, '/api/documents', 'POST', { type: 'sheet', spaceId: w.source, requestId: randomUUID() }) },
  createInSourceFolder: { action: 'documents.created', actor: () => amy, status: 201, run: async w => call(amySession, '/api/documents', 'POST', { type: 'sheet', spaceId: w.source, folderId: w.sourceFolder, requestId: randomUUID() }) },
  // 本人个人空间里的新建、不相干的复制、另一个人的另存
  benCreatePersonal: { action: 'documents.created', actor: () => ben, status: 201, run: async () => call(benSession, '/api/documents', 'POST', { type: 'sheet', requestId: randomUUID() }) },
  amyCopyElsewhere: { action: 'documents.copied', actor: () => amy, status: 201, run: async w => call(amySession, `/api/documents/${w.document.id}/copy`, 'POST', { spaceId: w.elsewhere, requestId: randomUUID() }) },
  amyConflictCopy: { action: 'documents.conflict_copied', actor: () => amy, status: 201, run: async w => postConflictCopy(app.baseUrl, amySession, w.document.id, w.document.unitId) },
} satisfies Record<string, Other>

type OtherName = keyof typeof OTHERS

/** 本另存原文档（本在源空间是编辑者：放进原文档所在的文件夹） */
async function benConflictCopy(world: World): Promise<Response> {
  return postConflictCopy(app.baseUrl, benSession, world.document.id, world.document.unitId)
}

interface CopyFirstCase {
  readonly other: OtherName
  /** 另一个操作是否在另存持有的锁上等待 */
  readonly waits: boolean
}

/** 方向一：另存已取完全部的锁（停在写审计之前），这时发出另一个操作 */
const COPY_FIRST: readonly CopyFirstCase[] = [
  { other: 'renameSource', waits: true },
  { other: 'moveSourceToRoot', waits: true },
  { other: 'moveSourceAcross', waits: true },
  { other: 'deleteSource', waits: true },
  { other: 'revokeGil', waits: true },
  { other: 'shareWithRoot', waits: true },
  { other: 'acquireLeaseSource', waits: true },
  { other: 'deleteSourceFolder', waits: true },
  { other: 'archiveSource', waits: true },
  { other: 'benViewerInSource', waits: true },
  { other: 'removeBenFromSource', waits: true },
  { other: 'createInSourceRoot', waits: false },
  { other: 'createInSourceFolder', waits: true },
  { other: 'benCreatePersonal', waits: false },
  { other: 'amyCopyElsewhere', waits: false },
  { other: 'amyConflictCopy', waits: true },
]

describe('US-M3-12 另存为副本与其他操作的交错：另存先取完锁，另一个操作随后发出', () => {
  it.each(COPY_FIRST)('$other（等待：$waits）：两边都结束，副本放在另存判断的地方（原文档所在的文件夹）', async ({ other: name, waits }) => {
    const other: Other = OTHERS[name]
    const world = await buildWorld()
    let pending: Promise<Response> | undefined
    let completed: boolean | undefined
    const copied = await raceAgainstHeldLock(database, {
      hold: holdGate('documents.conflict_copied', ben.id),
      request: async () => benConflictCopy(world),
      change: async () => {
        pending = other.run(world)
        completed = await completesWithoutWaiting(database, pending, 2)
      },
    })
    const response = await pending!
    expect(copied.status, await copied.clone().text()).toBe(201)
    expect(response.status, await response.clone().text()).toBe(other.status)
    expect(completed).toBe(!waits)
    const copy = parseExact(createdDocumentSchema, await copied.json())
    expect([copy.spaceId, copy.folderId]).toEqual([world.source, world.sourceFolder])
  })
})

interface OtherFirstCase {
  readonly other: OtherName
  readonly waits: boolean
  /** 谁另存：默认是本（源空间的编辑者）；gil 只凭查看授权 */
  readonly who?: 'gil'
  /** 另存的结果：状态码、错误码，或者副本放在哪里 */
  readonly expected: { readonly status: 201, readonly placement: 'sourceFolder' | 'sourceRoot' | 'personal' } | { readonly status: 404, readonly code: 'NOT_FOUND' }
}

/** 方向二：另一个操作先取完它的锁（停在写审计之前），这时发出另存 */
const OTHER_FIRST: readonly OtherFirstCase[] = [
  { other: 'renameSource', waits: true, expected: { status: 201, placement: 'sourceFolder' } },
  { other: 'moveSourceToRoot', waits: true, expected: { status: 201, placement: 'sourceRoot' } },
  // 锁下的 spaceId 复核：原文档已经在别处，按"没找到"回答，不放进移到的那个空间
  { other: 'moveSourceAcross', waits: true, expected: { status: 404, code: 'NOT_FOUND' } },
  { other: 'deleteSource', waits: true, expected: { status: 404, code: 'NOT_FOUND' } },
  { other: 'revokeGil', waits: true, who: 'gil', expected: { status: 404, code: 'NOT_FOUND' } },
  { other: 'deleteSourceFolder', waits: true, expected: { status: 404, code: 'NOT_FOUND' } },
  // 归档空间里的人仍读得到原文档，只是不能在那里新建：放进个人空间
  { other: 'archiveSource', waits: true, expected: { status: 201, placement: 'personal' } },
  { other: 'benViewerInSource', waits: true, expected: { status: 201, placement: 'personal' } },
  { other: 'removeBenFromSource', waits: true, expected: { status: 404, code: 'NOT_FOUND' } },
  { other: 'createInSourceFolder', waits: true, expected: { status: 201, placement: 'sourceFolder' } },
  { other: 'amyConflictCopy', waits: true, expected: { status: 201, placement: 'sourceFolder' } },
]

describe('US-M3-12 另存为副本与其他操作的交错：另一个操作先取完锁，另存随后发出', () => {
  it.each(OTHER_FIRST)('$other（等待：$waits）→ 另存 $expected.status', async ({ other: name, waits, who, expected }) => {
    const other: Other = OTHERS[name]
    if (other.action === undefined)
      throw new Error('不写审计的操作不能先停在闸门上')
    const world = await buildWorld()
    const [account, session] = who === 'gil' ? [gil, gilSession] : [ben, benSession]
    let pending: Promise<Response> | undefined
    let completed: boolean | undefined
    const response = await raceAgainstHeldLock(database, {
      hold: holdGate(other.action, other.actor().id),
      request: async () => other.run(world),
      change: async () => {
        pending = postConflictCopy(app.baseUrl, session, world.document.id, world.document.unitId)
        completed = await completesWithoutWaiting(database, pending, 2)
      },
    })
    const copied = await pending!
    expect(response.status, await response.clone().text()).toBe(other.status)
    expect(copied.status, await copied.clone().text()).toBe(expected.status)
    expect(completed).toBe(!waits)
    if (expected.status === 404) {
      expect(parseExact(errorResponseSchema, await copied.json()).error.code).toBe(expected.code)
      expect(await copiesBy(account, world.document.id)).toBe(0)
      return
    }
    const copy = parseExact(createdDocumentSchema, await copied.json())
    const placements = { sourceFolder: [world.source, world.sourceFolder], sourceRoot: [world.source, null], personal: [account.personalSpaceId, null] }
    expect([copy.spaceId, copy.folderId]).toEqual(placements[expected.placement])
  })
})
