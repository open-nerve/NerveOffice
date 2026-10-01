// 回收站里到期的删除单元的自动清理（M2-P4 设计 §3.4 第 6 条，S4）：真实的数据库与真实的应用，
// 时刻由假时钟给出（把"现在"推到 30 天之后，不必真的等）。覆盖：到期的才清、内容与修订记录一起没了、
// 未到期的不动、审计的操作者是系统、一轮的批量上限与"最早到期的先清"、
// 两个实例同时跑只有一个干活（另一个连接持有同一把 advisory lock）、归档的空间照样清、
// 等树锁期间这一单被跨空间搬走时这一轮跳过（留给下一轮）、归档先取完空间行时等它提交、一直失败的条目暂缓重试而不挡住后面到期的、定时器真的会跑、
// 定时器每一轮的"现在"取的是数据库的时间（连接的会话时区不是 UTC 时也一样）。
import type { TrashListResponse } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { Clock, TRASH_PURGE_LOCK, TrashPurgeJob } from '@nerve-office/api'
import { folderSchema, trashListResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase, withClient } from '../support/database.ts'
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
      // 只记份数与删除单元，不记标题（M2-P6 复核 M-1）
      details: { spaceId, trashEntryId: entry.id, folders: 0, documents: 1, cascadedEntries: 0 },
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
    // 明细逐字段相等：不记文件夹的名称（M2-P6 复核 M-1）
    expect(audit?.details).toEqual({ spaceId, trashEntryId: entry.id, folders: 2, documents: 1, cascadedEntries: 0 })
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
        await client.query('UPDATE trash_entries SET space_id = $2 WHERE id = $1', [entry.id, to])
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

  /**
   * 与归档、移出成员互斥（M2-P6 第 3 片复验）：清理与人工的永久删除一样取空间行的共享锁，归档（空间行的 FOR NO KEY UPDATE）
   * 先取完锁时，这一单的清理等它提交，再照常清掉（归档的空间照样清）。不取这把锁的话，清理不等它、直接走完
   */
  it('归档先取完锁（空间行）：这一单的清理等它提交，再照常清掉', async () => {
    const spaceId = await teamSpace()
    const document = await createDocument(database, { spaceId, createdBy: amy.id, title: '等归档的' })
    const entry = await trashed(spaceId, `/api/documents/${document}`)
    // 别的用例留下的删除单元都挪到还没到期：这一轮只碰这一单
    await database.query(async client => client.query('UPDATE trash_entries SET deleted_at = now(), expires_at = now() + interval \'30 days\' WHERE space_id <> $1', [spaceId]))
    const round = await raceAgainstHeldLock(database, {
      // 归档的效果：锁住空间行（FOR NO KEY UPDATE），提交之前改成已归档
      hold: async client => client.query('SELECT id FROM spaces WHERE id = $1 FOR NO KEY UPDATE', [spaceId]),
      request: async () => runPurge(expired(entry)),
      change: async client => client.query('UPDATE spaces SET status = \'archived\' WHERE id = $1', [spaceId]),
    })
    expect(round).toEqual({ ran: true, purged: 1, skipped: 0, failed: 0 })
    expect(await count('SELECT count(*) FROM documents WHERE id = $1', [document])).toBe(0)
  })

  /**
   * 一直失败的条目不挡住后面到期的（M2-P6 复核 A 的 S-1、B 的 G2）：它们到期最早，每一批都从它们取起，
   * 攒够一批之后后面到期的就再也轮不到。现在本进程记下失败过的条目，之后的几轮取批时让开它们。
   */
  it('最早到期的两单一直失败（批量 2）：之后的一轮让开它们，后面到期的那一单照常清掉；失败日志带着连续失败的次数', async () => {
    const spaceId = await teamSpace()
    const failing = await Promise.all(['坏的一', '坏的二'].map(async title => createDocument(database, { spaceId, createdBy: amy.id, title })))
    const good = await createDocument(database, { spaceId, createdBy: amy.id, title: '好的' })
    const failingEntries: string[] = []
    for (const document of failing)
      failingEntries.push((await trashed(spaceId, `/api/documents/${document}`)).id)
    const goodEntry = (await trashed(spaceId, `/api/documents/${good}`)).id
    // 别的用例留下的删除单元都挪到还没到期：这几轮只碰这个用例的三单
    await database.query(async client => client.query('UPDATE trash_entries SET deleted_at = now(), expires_at = now() + interval \'30 days\' WHERE space_id <> $1', [spaceId]))
    // 两单"坏的"最早到期；"好的"也已经到期，只是晚一点
    await setExpiry(failingEntries[0] ?? '', '42 days', '-12 days')
    await setExpiry(failingEntries[1] ?? '', '41 days', '-11 days')
    await setExpiry(goodEntry, '35 days', '-5 days')
    // 让"坏的"两份每次永久删除都失败（例如数据不一致、语句超时）：触发器只挡这两份
    await database.query(async client => client.query(`
      CREATE FUNCTION refuse_purge() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = ANY('{${failing.join(',')}}'::uuid[]) THEN
          RAISE EXCEPTION '这份文档删不掉';
        END IF;
        RETURN OLD;
      END
      $$;
      CREATE TRIGGER refuse_purge BEFORE DELETE ON documents FOR EACH ROW EXECUTE FUNCTION refuse_purge();`))
    // 单独起一个应用（批量 2）：失败过的条目记在它的内存里，不带进别的用例
    const isolated = await startTestApp({ databaseUrl: database.url, env: { NERVE_TRASH_PURGE_BATCH: '2' } })
    try {
      const job = isolated.runtime.get(TrashPurgeJob)
      await expect(job.runOnce(new Date())).resolves.toEqual({ ran: true, purged: 0, skipped: 0, failed: 2 })
      // 下一轮让开那两单："好的"那一单照常清掉
      await expect(job.runOnce(new Date())).resolves.toEqual({ ran: true, purged: 1, skipped: 0, failed: 0 })
      expect(await count('SELECT count(*) FROM documents WHERE id = $1', [good])).toBe(0)
      // 让开的一轮过了：再试一次，仍然失败，连续失败的次数是 2（之后让开两轮）
      await expect(job.runOnce(new Date())).resolves.toEqual({ ran: true, purged: 0, skipped: 0, failed: 2 })
      const failures = isolated.logs.entries()
        .filter(line => line.job === 'trash-purge' && line.level === 'error')
        .map(line => [line.trashEntryId, line.consecutiveFailures, line.deferredRounds])
      expect(failures).toEqual([
        [failingEntries[0], 1, 1],
        [failingEntries[1], 1, 1],
        [failingEntries[0], 2, 2],
        [failingEntries[1], 2, 2],
      ])
      expect(await count('SELECT count(*) FROM documents WHERE id = ANY($1::uuid[])', [failing])).toBe(2)
    }
    finally {
      await isolated.close()
      await database.query(async client => client.query('DROP TRIGGER refuse_purge ON documents; DROP FUNCTION refuse_purge();'))
    }
    // 收拾好：两单"坏的"人工永久删除（触发器已经拿掉），不留给后面的用例
    for (const entry of failingEntries)
      expect((await asUser(app.baseUrl, amySession, `/api/trash/${entry}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('定时器：应用自己按间隔跑，已经过期的东西不必等谁来触发', async () => {
    const spaceId = await teamSpace()
    const document = await createDocument(database, { spaceId, createdBy: amy.id, title: '等定时器来清' })
    const entry = await trashed(spaceId, `/api/documents/${document}`)
    // 已经过期：定时器那一轮的"现在"是数据库的时间
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

  it('定时器每一轮的"现在"取数据库的时间，不看应用主机的时钟（M2-P6 复核 A 的疑点 Q-1）：主机的钟拨到 2036 年、应用连接的会话时区是上海，给出的仍是数据库的时间', async () => {
    // 应用的连接用 UTC 以外的会话时区（M2-P6 第 3 片复验 建议 2）：测试库默认是 UTC，换算时漏了时区也看不出来——
    // 部署在上海时区的库上，那样会提前 8 小时永久删除
    const url = new URL(database.url)
    url.searchParams.set('options', '-c TimeZone=Asia/Shanghai')
    expect(await withClient(async client => (await client.query<{ TimeZone: string }>('SHOW TimeZone')).rows[0]?.TimeZone, url.toString())).toBe('Asia/Shanghai')
    const shanghai = await startTestApp({ databaseUrl: url.toString() })
    try {
      const databaseNow = async (): Promise<Date> => database.query(async client => (await client.query<{ now: Date }>('SELECT now()')).rows[0]?.now ?? new Date(Number.NaN))
      const before = await databaseNow()
      // 只换掉 Date（定时器照旧）：应用里 new Date() 与 Date.now() 都是 2036 年
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2036-01-01T00:00:00.000Z') })
      let now: Date
      try {
        expect(new Date().getUTCFullYear()).toBe(2036)
        now = await shanghai.runtime.get(Clock).now()
      }
      finally {
        vi.useRealTimers()
      }
      const after = await databaseNow()
      expect(now.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(now.getTime()).toBeLessThanOrEqual(after.getTime())
    }
    finally {
      await shanghai.close()
    }
  })
})
