// 回收站里到期的删除单元的自动清理（M2-P4 设计 §3.4 第 6 条，S4）：真实的数据库与真实的应用，
// 时刻由假时钟给出（把"现在"推到 30 天之后，不必真的等）。覆盖：到期的才清、内容与修订记录一起没了、
// 未到期的不动、审计的操作者是系统、一轮的批量上限与"最早到期的先清"、
// 两个实例同时跑只有一个干活（另一个连接持有同一把 advisory lock）、归档的空间照样清、
// 等树锁期间这一单被跨空间搬走时这一轮跳过（留给下一轮）、定时器真的会跑。
import type { TrashListResponse } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { TRASH_PURGE_LOCK, TrashPurgeJob } from '@nerve-office/api'
import { folderSchema, trashListResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { createDocument } from '../support/documents.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace, setSpaceState } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let amy: TestAccount
let amySession: LoggedIn
let spaces = 0

beforeAll(async () => {
  database = await createTestDatabase()
  // 定时器关掉：这个文件自己按给定的时刻跑一轮（最后一个用例另起一个开着定时器的应用）。
  // 一轮最多两个：用来核对批量上限与"最早到期的先清"
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_TRASH_PURGE_BATCH: '2' } })
  root = await createAccount(database, { username: 'root', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'amy', displayName: '艾米' })
  amySession = await login(app.baseUrl, 'amy', amy.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/** 一个新的团队空间，艾米是空间管理员 */
async function teamSpace(): Promise<string> {
  spaces += 1
  return createTeamSpace(database, { name: `清理 ${spaces}`, createdBy: root.id, members: { [amy.id]: 'admin' } })
}

/** 跑一轮：时刻由这里给出（假时钟），不是数据库的 now() */
async function runPurge(now: Date) {
  return app.runtime.get(TrashPurgeJob).runOnce(now)
}

/**
 * "到期了"的那个时刻：库里的到期时间带微秒，JSON 里只有毫秒（截断），所以加 1 毫秒才一定不早于它；
 * 减 1 毫秒则一定早于它（下面的"还差一点"用它）。
 */
function expired(entry: { expiresAt: Date }): Date {
  return new Date(entry.expiresAt.getTime() + 1)
}

async function trashOf(spaceId: string): Promise<TrashListResponse['items']> {
  const response = await asUser(app.baseUrl, amySession, `/api/trash?spaceId=${spaceId}`)
  expect(response.status).toBe(200)
  return parseExact(trashListResponseSchema, await response.json()).items
}

/** 删掉一份文档或一个文件夹，返回它在回收站里的删除单元（id 与到期时间） */
async function trashed(spaceId: string, path: string): Promise<{ id: string, expiresAt: Date }> {
  const response = await asUser(app.baseUrl, amySession, path, { method: 'DELETE' })
  expect(response.status).toBe(204)
  const entry = (await trashOf(spaceId)).at(0)
  if (entry === undefined)
    throw new Error('删除之后回收站里没有东西')
  return { id: entry.id, expiresAt: new Date(entry.expiresAt) }
}

async function newFolder(spaceId: string, name: string, parentId?: string): Promise<string> {
  const response = await asUser(app.baseUrl, amySession, '/api/folders', { method: 'POST', body: { spaceId, name, parentId, requestId: randomUUID() } })
  expect(response.status).toBe(201)
  return parseExact(folderSchema, await response.json()).id
}

async function count(query: string, values: unknown[]): Promise<number> {
  return database.query(async client => Number((await client.query<{ count: string }>(query, values)).rows[0]?.count))
}

/** 直接改删除单元的时间：用它摆出"更早到期"与"已经过期"的局面 */
async function setExpiry(entryId: string, deletedAgo: string, expiresIn: string): Promise<void> {
  await database.query(async client => client.query(
    `UPDATE trash_entries SET deleted_at = now() - $2::interval, expires_at = now() + $3::interval WHERE id = $1`,
    [entryId, deletedAgo, expiresIn],
  ))
}

async function auditOf(action: string, targetId: string) {
  return database.query(async client => (await client.query<{ actor_type: string, actor_id: string | null, source: string, request_id: string | null, details: Record<string, unknown> }>(
    'SELECT actor_type, actor_id, source, request_id, details FROM audit_events WHERE action = $1 AND target_id = $2',
    [action, targetId],
  )).rows)
}

describe('US-M2-09 到期的自动清理', () => {
  it('30 天之后才清：没到期时一个都不动，到期之后连内容与修订记录一起没了，审计的操作者是系统', async () => {
    const spaceId = await teamSpace()
    const document = await createDocument(database, { spaceId, createdBy: amy.id, title: '旧周报' })
    const other = await createDocument(database, { spaceId, createdBy: amy.id, title: '另一份' })
    const entry = await trashed(spaceId, `/api/documents/${document}`)
    const kept = await trashed(spaceId, `/api/documents/${other}`)
    // 另一份的到期时间挪到 90 天后：这一轮只该清掉到期的那一个
    await setExpiry(kept.id, '0 days', '90 days')

    // 还差一毫秒：一个都不清（SQL 里是 expires_at <= $now）
    await expect(runPurge(new Date(entry.expiresAt.getTime() - 1))).resolves.toEqual({ ran: true, purged: 0, skipped: 0, failed: 0 })
    expect(await count('SELECT count(*) FROM documents WHERE id = $1', [document])).toBe(1)

    // 到期了：这一单没了，文档、内容与修订记录一起没了；没到期的那一单还在
    await expect(runPurge(expired(entry))).resolves.toEqual({ ran: true, purged: 1, skipped: 0, failed: 0 })
    expect(await count('SELECT count(*) FROM documents WHERE id = $1', [document])).toBe(0)
    expect(await count('SELECT count(*) FROM document_contents WHERE document_id = $1', [document])).toBe(0)
    expect(await count('SELECT count(*) FROM document_revisions WHERE document_id = $1', [document])).toBe(0)
    expect(await count('SELECT count(*) FROM trash_entries WHERE id = $1', [entry.id])).toBe(0)
    expect((await trashOf(spaceId)).map(item => item.id)).toEqual([kept.id])
    expect(await count('SELECT count(*) FROM documents WHERE id = $1', [other])).toBe(1)

    // 审计：操作者是系统，来源是定时任务（不是谁发来的请求，也不是命令行）
    expect(await auditOf('documents.purged', document)).toEqual([{
      actor_type: 'system',
      actor_id: null,
      source: 'job',
      request_id: null,
      details: { spaceId, title: '旧周报', trashEntryId: entry.id, folders: 0, documents: 1, cascadedEntries: 0 },
    }])
  })

  it('一个文件夹的删除单元：整棵子树连同里面的文档一起清掉', async () => {
    const spaceId = await teamSpace()
    const folder = await newFolder(spaceId, '归档')
    const child = await newFolder(spaceId, '去年', folder)
    const document = await createDocument(database, { spaceId, createdBy: amy.id, title: '年报', folderId: child })
    const entry = await trashed(spaceId, `/api/folders/${folder}`)

    await expect(runPurge(expired(entry))).resolves.toMatchObject({ ran: true, purged: 1, failed: 0 })
    expect(await count('SELECT count(*) FROM folders WHERE id = ANY($1)', [[folder, child]])).toBe(0)
    expect(await count('SELECT count(*) FROM documents WHERE id = $1', [document])).toBe(0)
    expect(await count('SELECT count(*) FROM document_contents WHERE document_id = $1', [document])).toBe(0)
    const [audit] = await auditOf('folders.purged', folder)
    expect(audit).toMatchObject({ actor_type: 'system', actor_id: null, source: 'job' })
    expect(audit?.details).toMatchObject({ folders: 2, documents: 1, title: '归档' })
  })

  it('一轮最多清一批，最早到期的先清；剩下的留给下一轮', async () => {
    const spaceId = await teamSpace()
    const documents = await Promise.all(['第一份', '第二份', '第三份'].map(async title => createDocument(database, { spaceId, createdBy: amy.id, title })))
    const entries: string[] = []
    for (const [index, document] of documents.entries()) {
      const entry = await trashed(spaceId, `/api/documents/${document}`)
      // 过期的先后：第一份最早，第三份最晚（都已经过期）
      await setExpiry(entry.id, `${40 - index} days`, `${-(10 - index)} days`)
      entries.push(entry.id)
    }

    // 批量上限是 2：这一轮只清最早到期的两个
    await expect(runPurge(new Date())).resolves.toEqual({ ran: true, purged: 2, skipped: 0, failed: 0 })
    expect((await trashOf(spaceId)).map(item => item.id)).toEqual([entries[2]])

    await expect(runPurge(new Date())).resolves.toEqual({ ran: true, purged: 1, skipped: 0, failed: 0 })
    expect(await trashOf(spaceId)).toEqual([])
  })

  it('两个实例同时跑：另一个已经拿着这把锁时，这一轮整个跳过，什么都不清', async () => {
    const spaceId = await teamSpace()
    const document = await createDocument(database, { spaceId, createdBy: amy.id, title: '别动它' })
    const entry = await trashed(spaceId, `/api/documents/${document}`)

    await database.query(async (client) => {
      // 另一个连接（模拟另一个实例）在事务里拿着同一把 advisory lock
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [TRASH_PURGE_LOCK])
      try {
        await expect(runPurge(expired(entry))).resolves.toEqual({ ran: false, purged: 0, skipped: 0, failed: 0 })
        expect(await count('SELECT count(*) FROM documents WHERE id = $1', [document])).toBe(1)
      }
      finally {
        await client.query('ROLLBACK')
      }
    })

    // 锁放开之后照常清理
    await expect(runPurge(expired(entry))).resolves.toEqual({ ran: true, purged: 1, skipped: 0, failed: 0 })
    expect(await count('SELECT count(*) FROM documents WHERE id = $1', [document])).toBe(0)
  })

  it('归档的空间里照样清（清理不判断人的权限）', async () => {
    const spaceId = await teamSpace()
    const document = await createDocument(database, { spaceId, createdBy: amy.id, title: '归档空间里的' })
    const entry = await trashed(spaceId, `/api/documents/${document}`)
    await setSpaceState(database, spaceId, { status: 'archived' })

    await expect(runPurge(expired(entry))).resolves.toEqual({ ran: true, purged: 1, skipped: 0, failed: 0 })
    expect(await count('SELECT count(*) FROM documents WHERE id = $1', [document])).toBe(0)
  })

  /**
   * 跳过的另一条路（`reason: 'moved'`）：这一单的空间是批次取出时读到的，清理事务的树锁按它取；
   * 等锁期间它随子树被搬到别的空间，手里的锁就保护不到它了——不在错的锁下删东西，留给下一轮。
   */
  it('批次取出之后、清理事务拿到树锁之前，子树被跨空间搬走：这一轮跳过，留给下一轮', async () => {
    const from = await teamSpace()
    const to = await teamSpace()
    const folder = await newFolder(from, '会被搬走的')
    const document = await createDocument(database, { spaceId: from, createdBy: amy.id, title: '里面的', folderId: folder })
    const entry = await trashed(from, `/api/folders/${folder}`)

    const round = await raceAgainstHeldLock(database, {
      // 持住来源空间的树锁：清理这一单的事务第一步就要它
      hold: async client => client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended(\'nerve-office:space-tree:\' || $1::uuid::text, 0))',
        [from],
      ),
      request: async () => runPurge(expired(entry)),
      // 清理正等在锁上：这棵子树连同里面的文档与这一单被搬到另一个空间（跨空间移动的效果）
      change: async (client) => {
        await client.query('UPDATE folders SET space_id = $2 WHERE id = $1', [folder, to])
        await client.query('UPDATE documents SET space_id = $2 WHERE folder_id = $1', [folder, to])
        await client.query('UPDATE trash_entries SET space_id = $2, origin_space_id = $2 WHERE id = $1', [entry.id, to])
      },
    })
    expect(round).toEqual({ ran: true, purged: 0, skipped: 1, failed: 0 })
    expect(await count('SELECT count(*) FROM trash_entries WHERE id = $1', [entry.id])).toBe(1)
    expect(await count('SELECT count(*) FROM documents WHERE id = $1', [document])).toBe(1)

    // 下一轮按它现在所在的空间取锁，照常清掉
    await expect(runPurge(expired(entry))).resolves.toEqual({ ran: true, purged: 1, skipped: 0, failed: 0 })
    expect(await count('SELECT count(*) FROM documents WHERE id = $1', [document])).toBe(0)
    expect(await count('SELECT count(*) FROM folders WHERE id = $1', [folder])).toBe(0)
  })

  it('定时器：应用自己按间隔跑，已经过期的东西不必等谁来触发', async () => {
    const spaceId = await teamSpace()
    const document = await createDocument(database, { spaceId, createdBy: amy.id, title: '等定时器来清' })
    const entry = await trashed(spaceId, `/api/documents/${document}`)
    // 已经过期（系统时钟看得到的过期）：定时器那一轮用的是真实的时钟
    await setExpiry(entry.id, '31 days', '-1 days')

    const timed = await startTestApp({ databaseUrl: database.url, env: { NERVE_TRASH_PURGE_ENABLED: 'true', NERVE_TRASH_PURGE_INTERVAL_MS: '1000' } })
    try {
      const deadline = Date.now() + 20_000
      while (await count('SELECT count(*) FROM documents WHERE id = $1', [document]) > 0) {
        if (Date.now() > deadline)
          throw new Error('20 秒内定时器没有清掉已经过期的删除单元')
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      expect(await count('SELECT count(*) FROM trash_entries WHERE id = $1', [entry.id])).toBe(0)
      expect(timed.logs.entries().some(line => line.job === 'trash-purge' && String(line.msg).includes('清理了回收站里到期的东西'))).toBe(true)
    }
    finally {
      await timed.close()
    }
  })
})
