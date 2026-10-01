// 结构性改动的锁（US-M2-14，M2-P6 复核 A 的 M-1、B 的 B1）：两个连接构造的确定交错，不靠固定时长的等待。
// 1. 树锁是按取锁之前读到的空间取的：等锁期间对象被跨空间移走，写操作都要在锁下发现"它已经不在我锁着的空间里"，
//    按 NOT_FOUND 回答、什么也不改。八处写操作每处一条；恢复与到期的清理两处另见 trash.test.ts、jobs/trash-purge.test.ts。
//    再用两条用例说明这条核对是承重的：去掉它，改动就在错的树锁下进行，另一个空间里并发的改动把正常的东西放进回收站的文件夹。
// 2. 锁下才展开子树：删除文件夹、跨空间移动文件夹等树锁期间，子树里新建了子文件夹、放进了文档，它们也要一起被带上。
// 3. 与归档、移出成员互斥（空间行的共享锁）：操作先取完锁时，归档与移出等它提交；归档与移出先取完锁时，操作等它们提交、锁下再判断。
// 每条用例之后核对库里只由服务保证的不变量（回收站的文件夹下没有正常的东西；行与父文件夹、删除单元在同一个空间……）。
//
// 做法：空间树的锁由测试的连接直接持有（与服务同一个键）；"先取完锁的操作"停在写审计之前——给 audit_events 装一个
// BEFORE INSERT 的触发器，按"动作 + 操作者"取 advisory 共享锁（闸门，同 copy-locks.test.ts），测试的连接持有同一个键的排他锁。
import type pg from 'pg'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { InvariantViolation } from '../support/invariants.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { completesWithoutWaiting, raceAgainstHeldLock } from '../support/held-lock.ts'
import { invariantViolations, violationsSince } from '../support/invariants.ts'
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
  root = await createAccount(database, { username: 'root', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy', displayName: '艾米' })
  ben = await createAccount(database, { username: 'ben', displayName: '本' })
  rootSession = await login(app.baseUrl, 'root', root.password)
  amySession = await login(app.baseUrl, 'amy', amy.password)
  benSession = await login(app.baseUrl, 'ben', ben.password)
})

/** 每条用例开始时库里已有的违反：只在前面的用例失败时才会有，之后只报这条用例新造出来的 */
let violationsBefore: InvariantViolation[] = []

beforeEach(async () => {
  violationsBefore = await database.query(invariantViolations)
})

// 每条用例之后：库里只由服务保证的不变量都成立（错的锁下改动留下的痕迹会在这里露出来）
afterEach(async () => {
  expect(violationsSince(violationsBefore, await database.query(invariantViolations))).toEqual([])
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function call(session: LoggedIn, path: string, method = 'GET', body?: unknown): Promise<Response> {
  return asUser(app.baseUrl, session, path, body === undefined ? { method } : { method, body })
}

/** 新的团队空间：默认艾米是空间管理员、本是编辑者（锁下重新判断权限一定通过，挡住请求的只能是这里要核对的那一条） */
async function teamSpace(members: Record<string, 'admin' | 'editor' | 'viewer'> = { [amy.id]: 'admin', [ben.id]: 'editor' }): Promise<string> {
  spaces += 1
  return createTeamSpace(database, { name: `结构锁 ${spaces}`, createdBy: root.id, members })
}

async function newFolder(spaceId: string, name: string, parentId?: string, session: LoggedIn = amySession): Promise<string> {
  const response = await call(session, '/api/folders', 'POST', { spaceId, name, parentId, requestId: randomUUID() })
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { id: string }).id
}

/** 在持锁的事务里取这个空间的空间树 advisory lock（与结构性改动的第一步同一个键） */
function holdSpaceTree(spaceId: string) {
  return async (client: pg.Client) => client.query('SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:space-tree:\' || $1::uuid::text, 0))', [spaceId])
}

/** 在持锁的事务里关上这个操作的闸门 */
function holdGate(action: string, actorId: string) {
  return async (client: pg.Client) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`audit-gate:${action}:${actorId}`])
}

/** 一个文件夹连同子树与里面的文档搬到另一个空间：跨空间移动提交之后的效果 */
async function moveFolderTree(client: pg.Client, folderId: string, spaceId: string): Promise<void> {
  const subtree = 'WITH RECURSIVE t(id) AS (SELECT id FROM folders WHERE id = $1 UNION ALL SELECT f.id FROM folders f JOIN t ON f.parent_id = t.id)'
  await client.query(`${subtree} UPDATE folders SET space_id = $2 WHERE id IN (SELECT id FROM t)`, [folderId, spaceId])
  await client.query(`${subtree} UPDATE documents SET space_id = $2 WHERE folder_id IN (SELECT id FROM t)`, [folderId, spaceId])
}

async function entryOf(table: 'documents' | 'folders', id: string): Promise<string> {
  const entry = await database.query(async client => (await client.query<{ trash_entry_id: string | null }>(`SELECT trash_entry_id FROM ${table} WHERE id = $1`, [id])).rows[0]?.trash_entry_id)
  if (entry === undefined || entry === null)
    throw new Error(`${table} ${id} 不在回收站里`)
  return entry
}

interface DocumentState { readonly status: string, readonly space: string, readonly folder: string | null, readonly entry: string | null, readonly epoch: number, readonly title: string }
async function documentState(id: string): Promise<DocumentState | undefined> {
  return database.query(async client => (await client.query<DocumentState>(
    'SELECT status, space_id AS space, folder_id AS folder, trash_entry_id AS entry, write_epoch AS epoch, title FROM documents WHERE id = $1',
    [id],
  )).rows[0])
}

interface FolderState { readonly status: string, readonly space: string, readonly parent: string | null, readonly entry: string | null, readonly depth: number, readonly name: string }
async function folderState(id: string): Promise<FolderState | undefined> {
  return database.query(async client => (await client.query<FolderState>(
    'SELECT status, space_id AS space, parent_id AS parent, trash_entry_id AS entry, depth, name FROM folders WHERE id = $1',
    [id],
  )).rows[0])
}

async function entryState(id: string): Promise<{ space: string } | undefined> {
  return database.query(async client => (await client.query<{ space: string }>(
    'SELECT space_id AS space FROM trash_entries WHERE id = $1',
    [id],
  )).rows[0])
}

async function trashEntriesIn(spaceId: string): Promise<number> {
  return database.query(async client => Number((await client.query<{ count: string }>('SELECT count(*) FROM trash_entries WHERE space_id = $1', [spaceId])).rows[0]?.count))
}

describe('US-M2-14 等树锁期间对象被跨空间移走：写操作在锁下发现它已经不在锁着的空间里，404，什么也不改（M2-P6 复核 A 的 M-1、B 的 B1）', () => {
  // 艾米在两个空间里都是空间管理员：锁下重新判断权限一定通过，挡住请求的只能是"空间变了"这一条
  it('文件夹改名', async () => {
    const [from, to] = [await teamSpace(), await teamSpace()]
    const folder = await newFolder(from, '原名')
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(from),
      request: async () => call(amySession, `/api/folders/${folder}`, 'PATCH', { name: '新名' }),
      change: async client => moveFolderTree(client, folder, to),
    })
    expect(response.status).toBe(404)
    expect(await folderState(folder)).toMatchObject({ name: '原名', space: to, status: 'active' })
  })

  it('文件夹移动（目标是原来那个空间里的另一个文件夹）', async () => {
    const [from, to] = [await teamSpace(), await teamSpace()]
    const folder = await newFolder(from, '要移的')
    const parent = await newFolder(from, '新的父')
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(from),
      request: async () => call(amySession, `/api/folders/${folder}/move`, 'POST', { spaceId: from, folderId: parent }),
      change: async client => moveFolderTree(client, folder, to),
    })
    expect(response.status).toBe(404)
    expect(await folderState(folder)).toMatchObject({ space: to, parent: null, depth: 1 })
  })

  it('文档改名', async () => {
    const [from, to] = [await teamSpace(), await teamSpace()]
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '原名' })
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(from),
      request: async () => call(amySession, `/api/documents/${document.id}`, 'PATCH', { title: '新名' }),
      change: async client => client.query('UPDATE documents SET space_id = $2, write_epoch = write_epoch + 1 WHERE id = $1', [document.id, to]),
    })
    expect(response.status).toBe(404)
    expect(await documentState(document.id)).toMatchObject({ title: '原名', space: to, status: 'active' })
  })

  it('文档移动（目标是原来那个空间里的文件夹）', async () => {
    const [from, to] = [await teamSpace(), await teamSpace()]
    const folder = await newFolder(from, '目标')
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '要移的' })
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(from),
      request: async () => call(amySession, `/api/documents/${document.id}/move`, 'POST', { spaceId: from, folderId: folder }),
      change: async client => client.query('UPDATE documents SET space_id = $2, write_epoch = write_epoch + 1 WHERE id = $1', [document.id, to]),
    })
    expect(response.status).toBe(404)
    // 没有被挪进原来那个空间的文件夹：它在新空间的根目录，代次只是跨空间移动时加的那一次
    expect(await documentState(document.id)).toMatchObject({ space: to, folder: null, epoch: 1 })
  })

  it('删除文档', async () => {
    const [from, to] = [await teamSpace(), await teamSpace()]
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '要删的' })
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(from),
      request: async () => call(amySession, `/api/documents/${document.id}`, 'DELETE'),
      change: async client => client.query('UPDATE documents SET space_id = $2, write_epoch = write_epoch + 1 WHERE id = $1', [document.id, to]),
    })
    expect(response.status).toBe(404)
    expect(await documentState(document.id)).toMatchObject({ status: 'active', space: to, entry: null })
    expect([await trashEntriesIn(from), await trashEntriesIn(to)]).toEqual([0, 0])
  })

  it('删除文件夹', async () => {
    const [from, to] = [await teamSpace(), await teamSpace()]
    const folder = await newFolder(from, '要删的')
    const child = await newFolder(from, '子', folder)
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(from),
      request: async () => call(amySession, `/api/folders/${folder}`, 'DELETE'),
      change: async client => moveFolderTree(client, folder, to),
    })
    expect(response.status).toBe(404)
    expect([await folderState(folder), await folderState(child)]).toMatchObject([{ status: 'active', space: to }, { status: 'active', space: to }])
    expect([await trashEntriesIn(from), await trashEntriesIn(to)]).toEqual([0, 0])
  })

  it('永久删除（与恢复同一处核对；恢复见 trash.test.ts）', async () => {
    const [from, to] = [await teamSpace(), await teamSpace()]
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '删掉的' })
    expect((await call(amySession, `/api/documents/${document.id}`, 'DELETE')).status).toBe(204)
    const entry = await entryOf('documents', document.id)
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(from),
      request: async () => call(amySession, `/api/trash/${entry}`, 'DELETE'),
      // 这一单连同那份文档被搬到另一个空间（跨空间移动带走子树里的删除单元的效果）
      change: async (client) => {
        await client.query('UPDATE documents SET space_id = $2 WHERE id = $1', [document.id, to])
        await client.query('UPDATE trash_entries SET space_id = $2 WHERE id = $1', [entry, to])
      },
    })
    expect(response.status).toBe(404)
    expect(await documentState(document.id)).toMatchObject({ status: 'trashed', space: to, entry })
    expect(await entryState(entry)).toEqual({ space: to })
  })
})

describe('US-M2-14 锁下这条核对是承重的：没有它，改动在错的树锁下进行，正常的东西会挂到回收站的文件夹下（M2-P6 复核 A 的 M-1、B 的 B1）', () => {
  it('删除文件夹：等树锁期间整棵子树被搬走——有核对，删除 404；否则它只拿着原空间的树锁删新空间里的子树，同时另一个空间里的移动把一份正常的文档放进子文件夹', async () => {
    const [from, to] = [await teamSpace(), await teamSpace()]
    const folder = await newFolder(from, '要删的')
    const child = await newFolder(from, '子', folder)
    const outsider = await seedDocument(database, { spaceId: to, createdBy: amy.id, title: '另一个空间里的' })

    const outcome = await database.query(async treeHolder => database.query(async (gate) => {
      // 闸门：删除走到写审计之前（这时它已经把子树放进了回收站、还没提交）停下来
      await gate.query('BEGIN')
      await holdGate('folders.deleted', amy.id)(gate)
      await treeHolder.query('BEGIN')
      await holdSpaceTree(from)(treeHolder)
      const deletion = call(amySession, `/api/folders/${folder}`, 'DELETE')
      let treeHeld = true
      try {
        // 删除正等在原空间的树锁上：整棵子树被搬到另一个空间（跨空间移动提交之后的效果），放开树锁
        expect(await completesWithoutWaiting(database, deletion, 1)).toBe(false)
        await moveFolderTree(treeHolder, folder, to)
        await treeHolder.query('COMMIT')
        treeHeld = false
        // 有核对：删除立即 404 结束。没有核对：它展开了子树、停在闸门上——这时它只拿着原空间的树锁，新空间的树锁是空的，
        // 把一份正常的文档移进它正在删的子文件夹，照样成功（文件夹在别人提交之前仍是正常状态）
        const ended = await completesWithoutWaiting(database, deletion, 1)
        const moved = ended ? undefined : (await call(amySession, `/api/documents/${outsider.id}`, 'PATCH', { folderId: child })).status
        await gate.query('COMMIT')
        return { deletion: (await deletion).status, ended, moved }
      }
      catch (error) {
        if (treeHeld)
          await treeHolder.query('ROLLBACK')
        await gate.query('ROLLBACK')
        await deletion.catch(() => undefined)
        throw error
      }
    }))

    expect(outcome).toEqual({ deletion: 404, ended: true, moved: undefined })
    expect([await folderState(folder), await folderState(child)]).toMatchObject([{ status: 'active', space: to }, { status: 'active', space: to }])
    expect(await documentState(outsider.id)).toMatchObject({ status: 'active', folder: null })
  })

  it('文件夹换父：等树锁期间它被搬到另一个空间、那里正在删一个文件夹——有核对，换父 404；否则它会挂到正在进回收站的那个文件夹下', async () => {
    const [from, to] = [await teamSpace(), await teamSpace()]
    const moving = await newFolder(from, '要换父的')
    const inside = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '里面的文档', folderId: moving })
    const doomed = await newFolder(to, '正在删的')

    // remover：另一个事务，持着另一个空间的树锁，正在删除 doomed（与删除文件夹写的一样），换父的请求放开之前还没提交
    const outcome = await database.query(async (remover) => {
      let entryId = ''
      let removing = false
      try {
        const response = await raceAgainstHeldLock(database, {
          hold: holdSpaceTree(from),
          request: async () => call(amySession, `/api/folders/${moving}`, 'PATCH', { parentId: doomed }),
          change: async (client) => {
            await moveFolderTree(client, moving, to)
            await remover.query('BEGIN')
            removing = true
            await holdSpaceTree(to)(remover)
            entryId = (await remover.query<{ id: string }>(
              `INSERT INTO trash_entries (space_id, kind, deleted_by, expires_at, origin_parent_id, title)
               VALUES ($1, 'folder', $2, now() + interval '30 days', NULL, '正在删的') RETURNING id`,
              [to, amy.id],
            )).rows[0]?.id ?? ''
            await remover.query('UPDATE folders SET status = \'trashed\', trash_entry_id = $2 WHERE id = $1', [doomed, entryId])
          },
        })
        await remover.query('COMMIT')
        removing = false
        return { status: response.status, entryId }
      }
      catch (error) {
        if (removing)
          await remover.query('ROLLBACK')
        throw error
      }
    })

    expect(outcome.status).toBe(404)
    expect(await folderState(moving)).toMatchObject({ status: 'active', space: to, parent: null, depth: 1 })
    // 那一单永久删除之后，它与里面的文档都还在
    expect((await call(amySession, `/api/trash/${outcome.entryId}`, 'DELETE')).status).toBe(204)
    expect(await folderState(moving)).toMatchObject({ status: 'active' })
    expect(await documentState(inside.id)).toMatchObject({ status: 'active', folder: moving })
  })
})

describe('US-M2-14 锁下才展开子树：等树锁期间子树里新建了子文件夹、放进了文档，它们一起被带上（M2-P6 复核 A 的 Sh、Xf）', () => {
  /** 在 parent 下面直接新建一个子文件夹、把一份文档放进去（别的请求在这期间提交的效果） */
  async function growUnder(client: pg.Client, spaceId: string, parentId: string, documentId: string): Promise<string> {
    const id = (await client.query<{ id: string }>(
      'INSERT INTO folders (space_id, parent_id, name, created_by, depth, request_id) VALUES ($1, $2, \'后来建的\', $3, 2, gen_random_uuid()) RETURNING id',
      [spaceId, parentId, amy.id],
    )).rows[0]?.id
    if (id === undefined)
      throw new Error('没有建出子文件夹')
    await client.query('UPDATE documents SET folder_id = $2 WHERE id = $1', [documentId, id])
    return id
  }

  it('删除文件夹：后来建的子文件夹与放进去的文档一起进回收站、进同一个删除单元，代次加一', async () => {
    const spaceId = await teamSpace()
    const folder = await newFolder(spaceId, '资料')
    const document = await seedDocument(database, { spaceId, createdBy: amy.id, title: '后来放进去的' })
    let grown = ''
    const response = await raceAgainstHeldLock(database, {
      hold: holdSpaceTree(spaceId),
      request: async () => call(amySession, `/api/folders/${folder}`, 'DELETE'),
      change: async (client) => {
        grown = await growUnder(client, spaceId, folder, document.id)
      },
    })
    expect(response.status).toBe(204)
    const entry = await entryOf('folders', folder)
    expect(await folderState(grown)).toMatchObject({ status: 'trashed', entry })
    expect(await documentState(document.id)).toMatchObject({ status: 'trashed', entry, epoch: 1 })
  })

  it('跨空间移动文件夹：后来建的子文件夹与放进去的文档一起搬走，文档的代次加一', async () => {
    const [from, to] = [await teamSpace(), await teamSpace()]
    const folder = await newFolder(from, '资料')
    const document = await seedDocument(database, { spaceId: from, createdBy: amy.id, title: '后来放进去的' })
    let grown = ''
    const response = await raceAgainstHeldLock(database, {
      // 两把树锁按空间 id 的顺序取：持住原空间的那一把，移动无论先取哪一把，都要在这里等
      hold: holdSpaceTree(from),
      request: async () => call(amySession, `/api/folders/${folder}/move`, 'POST', { spaceId: to }),
      change: async (client) => {
        grown = await growUnder(client, from, folder, document.id)
      },
    })
    expect(response.status).toBe(200)
    expect(await folderState(grown)).toMatchObject({ space: to, parent: folder, depth: 2 })
    expect(await documentState(document.id)).toMatchObject({ space: to, folder: grown, epoch: 1 })
  })
})

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
  return { first: firstResponse, second: await pending!, secondWaited: completed === false }
}

/** 本在一个空间里要做的结构性改动：它的审计动作与请求 */
interface BensOperation {
  readonly action: string
  readonly run: () => Promise<Response>
}

type OperationName = 'renameFolder' | 'deleteFolder' | 'restore' | 'purge' | 'deleteDocument' | 'moveDocumentWithin'

/** 本（空间管理员）在这个空间里准备好的一个操作：文件夹、文档与删除单元都已经摆好 */
async function bensOperation(spaceId: string, name: OperationName): Promise<BensOperation> {
  const folder = await newFolder(spaceId, '本的文件夹', undefined, benSession)
  const document = await seedDocument(database, { spaceId, createdBy: ben.id, title: '本的文档' })
  switch (name) {
    case 'renameFolder':
      return { action: 'folders.renamed', run: async () => call(benSession, `/api/folders/${folder}`, 'PATCH', { name: '改过' }) }
    case 'deleteFolder':
      return { action: 'folders.deleted', run: async () => call(benSession, `/api/folders/${folder}`, 'DELETE') }
    case 'deleteDocument':
      return { action: 'documents.deleted', run: async () => call(benSession, `/api/documents/${document.id}`, 'DELETE') }
    case 'moveDocumentWithin':
      return { action: 'documents.moved', run: async () => call(benSession, `/api/documents/${document.id}`, 'PATCH', { folderId: folder }) }
    case 'restore':
    case 'purge': {
      expect((await call(benSession, `/api/documents/${document.id}`, 'DELETE')).status).toBe(204)
      const entry = await entryOf('documents', document.id)
      return name === 'restore'
        ? { action: 'documents.restored', run: async () => call(benSession, `/api/trash/${entry}/restore`, 'POST') }
        : { action: 'documents.purged', run: async () => call(benSession, `/api/trash/${entry}`, 'DELETE') }
    }
  }
}

/** 这个空间里全部的文件夹、文档与删除单元（比较前后是否"什么也没改"） */
async function contentsOf(spaceId: string): Promise<unknown> {
  return database.query(async client => ({
    folders: (await client.query('SELECT id, name, status, parent_id, trash_entry_id FROM folders WHERE space_id = $1 ORDER BY id', [spaceId])).rows,
    documents: (await client.query('SELECT id, title, status, folder_id, trash_entry_id, write_epoch FROM documents WHERE space_id = $1 ORDER BY id', [spaceId])).rows,
    entries: (await client.query('SELECT id FROM trash_entries WHERE space_id = $1 ORDER BY id', [spaceId])).rows,
  }))
}

const OPERATIONS: readonly OperationName[] = ['renameFolder', 'deleteFolder', 'restore', 'purge', 'deleteDocument', 'moveDocumentWithin']

describe('US-M2-14 结构性改动与归档、移出成员互斥：空间行的共享锁（M2-P6 复核 A 的 Aa、Ab）', () => {
  it('删除文件夹先取完锁：归档等它提交（空间行），之后两边都成功', async () => {
    const spaceId = await teamSpace()
    const folder = await newFolder(spaceId, '资料')
    const result = await interleave(
      { action: 'folders.deleted', actorId: amy.id, run: async () => call(amySession, `/api/folders/${folder}`, 'DELETE') },
      async () => call(rootSession, `/api/admin/spaces/${spaceId}/archive`, 'POST'),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([204, 200, true])
    expect(await folderState(folder)).toMatchObject({ status: 'trashed' })
  })

  it('归档先取完锁：删除文件夹等它提交，锁下再判断，403（空间已归档），什么也不改', async () => {
    const spaceId = await teamSpace()
    const folder = await newFolder(spaceId, '资料')
    const result = await interleave(
      { action: 'spaces.archived', actorId: root.id, run: async () => call(rootSession, `/api/admin/spaces/${spaceId}/archive`, 'POST') },
      async () => call(amySession, `/api/folders/${folder}`, 'DELETE'),
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([200, 403, true])
    expect(await folderState(folder)).toMatchObject({ status: 'active', entry: null })
  })

  it.each(OPERATIONS)('%s 先取完锁：把本移出空间的请求等它提交，之后两边都成功', async (name) => {
    const spaceId = await teamSpace({ [amy.id]: 'admin', [ben.id]: 'admin' })
    const operation = await bensOperation(spaceId, name)
    const result = await interleave(
      { action: operation.action, actorId: ben.id, run: operation.run },
      async () => call(amySession, `/api/spaces/${spaceId}/members/${ben.id}`, 'DELETE'),
    )
    expect(result.first.status, await result.first.clone().text()).toBeLessThan(300)
    expect([result.second.status, result.secondWaited]).toEqual([204, true])
  })

  it.each(OPERATIONS)('把本移出空间先取完锁：%s 等它提交（空间行），锁下再判断，404，什么也不改', async (name) => {
    const spaceId = await teamSpace({ [amy.id]: 'admin', [ben.id]: 'admin' })
    const operation = await bensOperation(spaceId, name)
    const before = await contentsOf(spaceId)
    const result = await interleave(
      { action: 'spaces.member_removed', actorId: amy.id, run: async () => call(amySession, `/api/spaces/${spaceId}/members/${ben.id}`, 'DELETE') },
      operation.run,
    )
    expect([result.first.status, result.second.status, result.secondWaited]).toEqual([204, 404, true])
    expect(await contentsOf(spaceId)).toEqual(before)
  })
})
