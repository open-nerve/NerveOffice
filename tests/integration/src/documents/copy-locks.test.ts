// 复制与其他操作的确定交错（US-M2-14，M2-P6 复验）：复制持有的锁（目标空间的树锁 → 源空间与目标空间的空间行 → 源文档行）
// 与其他操作互斥的范围要对——该等的等、不该等的不等；两边都结束、不成环，结果与先后一致。
// 每一类操作至少有一个方向：源文档行上的改动、源文档所在的文件夹、源空间的成员与状态、目标空间的成员与状态、
// 目标空间里的结构改动、不相干的操作（另一个空间的复制、回收站里别的删除单元）。复制进行中对源文档的删除、跨空间移动、
// 保存与移出成员另见 organizing.test.ts；锁下重新判断源文档与目标空间也在那里。
//
// 做法：给 audit_events 装一个 BEFORE INSERT 的触发器，按"动作 + 操作者"取 advisory 共享锁（闸门）。测试的连接在事务里
// 持有同一个键的排他锁时，那个操作就停在写审计之前——这时它已经取完了自己要的全部锁；再发另一个操作，看它是否在锁上等待
// （completesWithoutWaiting），然后放开闸门。触发器只装在这个文件自己的库里。
import type pg from 'pg'
import type { PassiveAccount, TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { createdDocumentSchema, errorResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount, createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { completesWithoutWaiting, raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let amy: TestAccount
let ben: TestAccount
let rootSession: LoggedIn
let amySession: LoggedIn
let benSession: LoggedIn
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
  rootSession = await login(app.baseUrl, 'root', root.password)
  amySession = await login(app.baseUrl, 'amy', amy.password)
  benSession = await login(app.baseUrl, 'ben', ben.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

function snapshotOf(unitId: string, value: string): Buffer {
  const sheet = SHEET_TEMPLATE.sheets['sheet-1']
  return Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: unitId, sheets: { 'sheet-1': { ...sheet, cellData: { 0: { 0: { v: value } } } } } }), 'utf8')
}

async function save(user: LoggedIn, document: SeededDocument, value: string, baseRevision: number): Promise<Response> {
  const query = new URLSearchParams({ baseRevision: String(baseRevision), requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: '1' })
  return asUser(app.baseUrl, user, `/api/documents/${document.id}/content?${query.toString()}`, {
    method: 'PUT',
    binary: { contentType: 'application/gzip', bytes: zlib.gzipSync(snapshotOf(document.unitId, value)) },
  })
}

async function call(session: LoggedIn, path: string, method: string, body?: unknown): Promise<Response> {
  return asUser(app.baseUrl, session, path, body === undefined ? { method } : { method, body })
}

async function folderIn(spaceId: string, name: string): Promise<string> {
  const response = await call(amySession, '/api/folders', 'POST', { spaceId, name, requestId: randomUUID() })
  expect(response.status).toBe(201)
  return ((await response.json()) as { id: string }).id
}

/** 一次用例的世界：艾米是三个团队空间的空间管理员，本是编辑者 */
interface World {
  /** 源空间 */
  readonly source: string
  /** 另一个空间（跨空间移动与另一次复制的去处） */
  readonly elsewhere: string
  /** 复制的目标空间 */
  readonly target: string
  /** 源文档所在的文件夹（源空间里） */
  readonly sourceFolder: string
  /** 复制的目标文件夹（目标空间里） */
  readonly targetFolder: string
  readonly document: SeededDocument
  /** 源空间的回收站里一个与源文档无关的删除单元 */
  readonly unrelatedEntry: string
  /** 停用的账户与他的一份文档（转移用） */
  readonly leaver: PassiveAccount
  readonly leaverDocument: string
}

async function buildWorld(): Promise<World> {
  worlds += 1
  const members = { [amy.id]: 'admin', [ben.id]: 'editor' } as const
  const source = await createTeamSpace(database, { name: `源 ${worlds}`, createdBy: root.id, members })
  const elsewhere = await createTeamSpace(database, { name: `别处 ${worlds}`, createdBy: root.id, members })
  const target = await createTeamSpace(database, { name: `目标 ${worlds}`, createdBy: root.id, members })
  const sourceFolder = await folderIn(source, '源文件夹')
  const targetFolder = await folderIn(target, '目标文件夹')
  const document = await seedDocument(database, { spaceId: source, createdBy: amy.id, title: '源文档', folderId: sourceFolder })
  const trashed = await seedDocument(database, { spaceId: source, createdBy: amy.id, title: '删掉的' })
  expect((await call(amySession, `/api/documents/${trashed.id}`, 'DELETE')).status).toBe(204)
  const unrelatedEntry = await database.query(async client => (await client.query<{ trash_entry_id: string }>('SELECT trash_entry_id FROM documents WHERE id = $1', [trashed.id])).rows[0]?.trash_entry_id)
  if (unrelatedEntry === undefined)
    throw new Error('没有删除单元')
  const leaver = await createPassiveAccount(database, { username: `leaver${worlds}`, status: 'disabled' })
  const leaverDocument = (await seedDocument(database, { spaceId: leaver.personalSpaceId, createdBy: leaver.id, title: '停用者的' })).id
  return { source, elsewhere, target, sourceFolder, targetFolder, document, unrelatedEntry, leaver, leaverDocument }
}

/** 本把源文档复制到目标空间的目标文件夹 */
async function benCopy(world: World): Promise<Response> {
  return call(benSession, `/api/documents/${world.document.id}/copy`, 'POST', { spaceId: world.target, folderId: world.targetFolder, requestId: randomUUID() })
}

/** 与复制交错的另一个操作 */
interface Other {
  /** 这个操作的审计动作与操作者（闸门的键） */
  readonly action: string
  readonly actor: () => TestAccount
  readonly run: (world: World) => Promise<Response>
  /** 这个操作单独执行时的状态码 */
  readonly status: number
}

/** 每一类挑有代表性的几个（M2-P6 复验跑过全部 23 种操作的两个方向） */
const OTHERS = {
  // 源文档行上的改动
  renameSource: { action: 'documents.renamed', actor: () => amy, status: 200, run: async w => call(amySession, `/api/documents/${w.document.id}`, 'PATCH', { title: '改过的标题' }) },
  moveSourceAcross: { action: 'documents.moved', actor: () => amy, status: 200, run: async w => call(amySession, `/api/documents/${w.document.id}/move`, 'POST', { spaceId: w.elsewhere }) },
  saveSource: { action: 'documents.content_saved', actor: () => amy, status: 200, run: async w => save(amySession, w.document, '后来写的内容', 1) },
  // 源文档所在的文件夹
  moveSourceFolderAcross: { action: 'folders.moved', actor: () => amy, status: 200, run: async w => call(amySession, `/api/folders/${w.sourceFolder}/move`, 'POST', { spaceId: w.elsewhere }) },
  deleteSourceFolder: { action: 'folders.deleted', actor: () => amy, status: 204, run: async w => call(amySession, `/api/folders/${w.sourceFolder}`, 'DELETE') },
  // 源空间的成员与状态
  removeBenFromSource: { action: 'spaces.member_removed', actor: () => amy, status: 204, run: async w => call(amySession, `/api/spaces/${w.source}/members/${ben.id}`, 'DELETE') },
  archiveSource: { action: 'spaces.archived', actor: () => root, status: 200, run: async w => call(rootSession, `/api/admin/spaces/${w.source}/archive`, 'POST') },
  // 目标空间的成员与状态
  removeBenFromTarget: { action: 'spaces.member_removed', actor: () => amy, status: 204, run: async w => call(amySession, `/api/spaces/${w.target}/members/${ben.id}`, 'DELETE') },
  benViewerInTarget: { action: 'spaces.member_role_changed', actor: () => amy, status: 200, run: async w => call(amySession, `/api/spaces/${w.target}/members/${ben.id}`, 'PUT', { role: 'viewer' }) },
  archiveTarget: { action: 'spaces.archived', actor: () => root, status: 200, run: async w => call(rootSession, `/api/admin/spaces/${w.target}/archive`, 'POST') },
  // 目标空间里的结构改动
  createFolderInTarget: { action: 'folders.created', actor: () => amy, status: 201, run: async w => call(amySession, '/api/folders', 'POST', { spaceId: w.target, name: '新的', requestId: randomUUID() }) },
  deleteTargetFolder: { action: 'folders.deleted', actor: () => amy, status: 204, run: async w => call(amySession, `/api/folders/${w.targetFolder}`, 'DELETE') },
  amyCopyToTarget: { action: 'documents.copied', actor: () => amy, status: 201, run: async w => call(amySession, `/api/documents/${w.document.id}/copy`, 'POST', { spaceId: w.target, requestId: randomUUID() }) },
  transferIntoTarget: { action: 'documents.transferred', actor: () => root, status: 200, run: async w => call(rootSession, `/api/admin/users/${w.leaver.id}/documents/transfer`, 'POST', { documentIds: [w.leaverDocument], target: { type: 'team', spaceId: w.target } }) },
  // 不相干的操作
  amyCopyElsewhere: { action: 'documents.copied', actor: () => amy, status: 201, run: async w => call(amySession, `/api/documents/${w.document.id}/copy`, 'POST', { spaceId: w.elsewhere, requestId: randomUUID() }) },
  purgeUnrelated: { action: 'documents.purged', actor: () => amy, status: 204, run: async w => call(amySession, `/api/trash/${w.unrelatedEntry}`, 'DELETE') },
  restoreUnrelated: { action: 'documents.restored', actor: () => amy, status: 200, run: async w => call(amySession, `/api/trash/${w.unrelatedEntry}/restore`, 'POST') },
} satisfies Record<string, Other>

type OtherName = keyof typeof OTHERS

interface CopyFirstCase {
  readonly other: OtherName
  /** 另一个操作是否在复制持有的锁上等待 */
  readonly waits: boolean
}

/** 方向一：复制已取完全部的锁（停在写审计之前），这时发出另一个操作 */
const COPY_FIRST: readonly CopyFirstCase[] = [
  { other: 'renameSource', waits: true },
  { other: 'deleteSourceFolder', waits: true },
  { other: 'archiveSource', waits: true },
  { other: 'benViewerInTarget', waits: true },
  { other: 'createFolderInTarget', waits: true },
  { other: 'transferIntoTarget', waits: false },
  { other: 'amyCopyElsewhere', waits: false },
  { other: 'purgeUnrelated', waits: false },
]

describe('US-M2-14 复制与其他操作的交错：复制先取完锁，另一个操作随后发出', () => {
  it.each(COPY_FIRST)('$other（等待：$waits）：两边都结束，副本是复制那一刻的源文档', async ({ other: name, waits }) => {
    const other: Other = OTHERS[name]
    const world = await buildWorld()
    let pending: Promise<Response> | undefined
    let completed: boolean | undefined
    const copied = await raceAgainstHeldLock(database, {
      hold: holdGate('documents.copied', ben.id),
      request: async () => benCopy(world),
      change: async () => {
        pending = other.run(world)
        completed = await completesWithoutWaiting(database, pending, 2)
      },
    })
    const response = await pending!
    expect(copied.status, await copied.clone().text()).toBe(201)
    expect(response.status, await response.clone().text()).toBe(other.status)
    expect(completed).toBe(!waits)
    // 副本是复制那一刻的源：之后的改名没有进副本
    expect(parseExact(createdDocumentSchema, await copied.json()).title).toBe('源文档 的副本')
  })
})

interface OtherFirstCase {
  readonly other: OtherName
  readonly waits: boolean
  /** 复制的结果：状态码与错误码 */
  readonly copyStatus: number
  readonly copyCode?: string
}

/** 方向二：另一个操作先取完它的锁（停在写审计之前），这时发出复制 */
const OTHER_FIRST: readonly OtherFirstCase[] = [
  { other: 'renameSource', waits: true, copyStatus: 201 },
  { other: 'saveSource', waits: true, copyStatus: 201 },
  { other: 'moveSourceAcross', waits: true, copyStatus: 404, copyCode: 'NOT_FOUND' },
  { other: 'moveSourceFolderAcross', waits: true, copyStatus: 404, copyCode: 'NOT_FOUND' },
  { other: 'removeBenFromSource', waits: true, copyStatus: 404, copyCode: 'NOT_FOUND' },
  // 归档空间里的文档照样能复制出去（归档只是只读）
  { other: 'archiveSource', waits: true, copyStatus: 201 },
  { other: 'removeBenFromTarget', waits: true, copyStatus: 404, copyCode: 'NOT_FOUND' },
  { other: 'benViewerInTarget', waits: true, copyStatus: 403, copyCode: 'PERMISSION_DENIED' },
  { other: 'archiveTarget', waits: true, copyStatus: 409, copyCode: 'SPACE_ARCHIVED' },
  { other: 'deleteTargetFolder', waits: true, copyStatus: 404, copyCode: 'NOT_FOUND' },
  { other: 'amyCopyToTarget', waits: true, copyStatus: 201 },
  { other: 'restoreUnrelated', waits: false, copyStatus: 201 },
]

describe('US-M2-14 复制与其他操作的交错：另一个操作先取完锁，复制随后发出', () => {
  it.each(OTHER_FIRST)('$other（等待：$waits）→ 复制 $copyStatus', async ({ other: name, waits, copyStatus, copyCode }) => {
    const other: Other = OTHERS[name]
    const world = await buildWorld()
    let pending: Promise<Response> | undefined
    let completed: boolean | undefined
    const response = await raceAgainstHeldLock(database, {
      hold: holdGate(other.action, other.actor().id),
      request: async () => other.run(world),
      change: async () => {
        pending = benCopy(world)
        completed = await completesWithoutWaiting(database, pending, 2)
      },
    })
    const copied = await pending!
    expect(response.status, await response.clone().text()).toBe(other.status)
    expect(copied.status, await copied.clone().text()).toBe(copyStatus)
    expect(completed).toBe(!waits)
    if (copyCode !== undefined) {
      expect(parseExact(errorResponseSchema, await copied.json()).error.code).toBe(copyCode)
      return
    }
    // 复制看到的是另一个操作提交之后的源文档
    const copy = parseExact(createdDocumentSchema, await copied.json())
    if (name === 'renameSource')
      expect(copy.title).toBe('改过的标题 的副本')
    if (name === 'saveSource') {
      const snapshot = await database.query(async client => (await client.query<{ snapshot: Buffer }>('SELECT snapshot FROM document_contents WHERE document_id = $1', [copy.id])).rows[0]?.snapshot)
      expect(zlib.gunzipSync(snapshot!).toString('utf8')).toContain('后来写的内容')
    }
  })
})

describe('US-M2-14 复制与其他操作的交错：源与目标是同一个空间', () => {
  /** 本把源文档复制到源空间的根目录 */
  async function benCopyWithinSource(world: World): Promise<Response> {
    return call(benSession, `/api/documents/${world.document.id}/copy`, 'POST', { spaceId: world.source, requestId: randomUUID() })
  }

  it('移出本先取完锁：复制（源空间 → 源空间）等它提交，之后 404', async () => {
    const world = await buildWorld()
    let pending: Promise<Response> | undefined
    let completed: boolean | undefined
    const removed = await raceAgainstHeldLock(database, {
      hold: holdGate('spaces.member_removed', amy.id),
      request: async () => OTHERS.removeBenFromSource.run(world),
      change: async () => {
        pending = benCopyWithinSource(world)
        completed = await completesWithoutWaiting(database, pending, 2)
      },
    })
    expect(removed.status).toBe(204)
    expect((await pending!).status).toBe(404)
    expect(completed).toBe(false)
  })

  it('复制先取完锁：本在这个空间被降为查看者，降级等复制提交之后才生效', async () => {
    const world = await buildWorld()
    let pending: Promise<Response> | undefined
    let completed: boolean | undefined
    const copied = await raceAgainstHeldLock(database, {
      hold: holdGate('documents.copied', ben.id),
      request: async () => benCopyWithinSource(world),
      change: async () => {
        pending = call(amySession, `/api/spaces/${world.source}/members/${ben.id}`, 'PUT', { role: 'viewer' })
        completed = await completesWithoutWaiting(database, pending, 2)
      },
    })
    expect(copied.status).toBe(201)
    expect((await pending!).status).toBe(200)
    expect(completed).toBe(false)
  })
})
