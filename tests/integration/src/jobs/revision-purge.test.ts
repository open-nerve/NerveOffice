// 修订记录与回执的保留期清理（M3-P3 设计 §3.9，S5）：真实的数据库与真实的应用，时刻由可控的时钟给出（把"现在"推到 30 天之后，不必真的等）。覆盖：
// - 没过保留期一条不删；过了保留期：不是当前修订的修订记录与回执都删掉，当前修订那一行一直留着（边界精确到毫秒，天数在 SQL 里换算）；
// - 删掉之后同一个 requestId 的重试不再是重放（按新的保存处理，得到修订号冲突）；当前修订那一行的重放照样成立，修订号冲突与申请编辑权的来源、
//   "内容相同不递增"给出的保存时间照样读得到；
// - 新建、复制、另存为副本的幂等窗口随之是保留期：那一行删掉之后同一个 requestId 是一次新的请求，没再保存过的（那一行是当前修订）照样重放；
// - 分批（一批至多 NERVE_REVISION_PURGE_BATCH 条）、退出时做完手上这一批就停；另一个实例持着锁时这一轮跳过；
// - 与并发的保存交错：保存等着文档行时跑一轮，不等它、不删它的基准，保存照常提交；与永久删除交错：被级联删除锁着的行跳过，不等、不死锁；
//   几份文档同时保存的同时跑几轮，都不出错；
// - 保留天数取自配置；定时器自己按间隔跑，每一轮的"现在"是数据库的时间；
// - 不变量：每份文档当前修订的那一行都在（每条用例之后核对），删库时照常扫一遍只由服务保证的不变量。
import type { RevisionPurgeRound } from '@nerve-office/api'
import type { CreatedDocument, SaveContentResponse } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { HeldLease } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { REVISION_PURGE_LOCK, RevisionPurgeJob } from '@nerve-office/api'
import { acquiredEditLeaseSchema, createdDocumentSchema, errorResponseSchema, revisionConflictDetailsSchema, saveContentResponseSchema } from '@nerve-office/contracts'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { acquireBody } from '../support/client-format.ts'
import { pageSnapshot, postConflictCopy } from '../support/conflict-copies.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { acquireLease, releaseLease, saveContent } from '../support/edit-leases.ts'
import { completesWithoutWaiting, raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'

const DAY_MS = 24 * 3_600_000
/** 测试应用一批的数量：小一点，分批看得出来 */
const BATCH = 2

let database: TestDatabase
let app: TestApp
let amy: TestAccount
let amySession: LoggedIn

beforeAll(async () => {
  database = await createTestDatabase()
  // 定时器关掉（testEnvironment 的默认）：这个文件自己按给定的时刻跑一轮（定时器的用例另起一个开着它的应用）
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_REVISION_PURGE_BATCH: String(BATCH) } })
  amy = await createAccount(database, { username: 'retention-amy' })
  amySession = await login(app.baseUrl, amy.username, amy.password)
})

/** 文档当前修订的那一行不见了的文档：保留期的清理绝不能删它（冲突的来源、申请编辑权与"内容相同不递增"都读它） */
const CURRENT_REVISION_MISSING = `SELECT d.id, d.revision FROM documents d
  WHERE NOT EXISTS (SELECT 1 FROM document_revisions r WHERE r.document_id = d.id AND r.revision = d.revision)`

afterEach(async () => {
  // 这个库里的文档都是经接口建的：每一份都该有当前修订的那一行
  expect(await database.query(async client => (await client.query<{ id: string, revision: number }>(CURRENT_REVISION_MISSING)).rows)).toEqual([])
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

/** 一份经接口新建的文档：id、它的 unitId（保存要用它构造快照）与新建的 requestId */
interface Sheet {
  readonly id: string
  readonly unitId: string
  readonly requestId: string
}

async function created(response: Response): Promise<CreatedDocument> {
  expect(response.status, await response.clone().text()).toBe(201)
  return parseExact(createdDocumentSchema, await response.json())
}

async function unitIdOf(documentId: string): Promise<string> {
  const unitId = await database.query(async client => (await client.query<{ unit_id: string }>('SELECT unit_id FROM documents WHERE id = $1', [documentId])).rows[0]?.unit_id)
  if (unitId === undefined)
    throw new Error(`没有这份文档：${documentId}`)
  return unitId
}

async function postDocument(requestId: string, title = '保留期'): Promise<Response> {
  return asUser(app.baseUrl, amySession, '/api/documents', { method: 'POST', body: { type: 'sheet', title, requestId } })
}

async function newSheet(title = '保留期'): Promise<Sheet> {
  const requestId = randomUUID()
  const document = await created(await postDocument(requestId, title))
  return { id: document.id, unitId: await unitIdOf(document.id), requestId }
}

async function postCopy(sourceId: string, requestId: string): Promise<Response> {
  return asUser(app.baseUrl, amySession, `/api/documents/${sourceId}/copy`, { method: 'POST', body: { spaceId: amy.personalSpaceId, requestId } })
}

interface SaveRequest {
  readonly baseRevision: number
  readonly requestId?: string
  /** 保存的标签页：核对来源时给定 */
  readonly clientInstanceId?: string
  readonly lease?: HeldLease
}

/** 保存一次：A1 写入 value（同样的 value 就是同样的内容） */
async function save(sheet: Pick<Sheet, 'id' | 'unitId'>, value: string, request: SaveRequest): Promise<Response> {
  return saveContent(app.baseUrl, amySession, sheet.id, zlib.gzipSync(pageSnapshot(sheet.unitId, value)), {
    baseRevision: request.baseRevision,
    requestId: request.requestId ?? randomUUID(),
    ...(request.clientInstanceId === undefined ? {} : { clientInstanceId: request.clientInstanceId }),
    ...(request.lease === undefined ? {} : { lease: request.lease }),
  })
}

async function saved(response: Response): Promise<SaveContentResponse> {
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(saveContentResponseSchema, await response.json())
}

/** 409 修订号冲突的详情（当前修订号与它的来源） */
async function conflictOf(response: Response) {
  expect(response.status, await response.clone().text()).toBe(409)
  const { error } = parseExact(errorResponseSchema, await response.json())
  expect(error.code).toBe('DOCUMENT_REVISION_CONFLICT')
  return parseExact(revisionConflictDetailsSchema, error.details)
}

async function revisionsOf(documentId: string): Promise<number[]> {
  return database.query(async client => (await client.query<{ revision: number }>(
    'SELECT revision FROM document_revisions WHERE document_id = $1 ORDER BY revision',
    [documentId],
  )).rows.map(row => row.revision))
}

async function receiptsOf(documentId: string): Promise<string[]> {
  return database.query(async client => (await client.query<{ request_id: string }>(
    'SELECT request_id FROM document_save_receipts WHERE document_id = $1 ORDER BY created_at',
    [documentId],
  )).rows.map(row => row.request_id))
}

async function databaseNow(): Promise<Date> {
  return database.query(async client => (await client.query<{ now: Date }>('SELECT now()')).rows[0]?.now ?? new Date(Number.NaN))
}

/** 数据库的现在再过 days 天：可控的时钟给出的"现在" */
async function daysLater(days: number): Promise<Date> {
  return new Date((await databaseNow()).getTime() + days * DAY_MS)
}

/** 按给定的时刻跑一轮（可控的时钟），不是数据库的 now() */
async function purge(now: Date, signal?: AbortSignal, target: TestApp = app): Promise<RevisionPurgeRound> {
  return target.runtime.get(RevisionPurgeJob).runOnce(now, signal)
}

/** 先把前面的用例留下的都删掉：之后这一条用例的计数只是它自己的 */
async function drain(): Promise<void> {
  expect(await purge(await daysLater(31))).toMatchObject({ ran: true, ending: 'drained' })
}

describe('保留期之前的修订记录与回执', () => {
  it('没过保留期一条不删；过了保留期：不是当前修订的修订记录与回执都删掉（边界精确到毫秒），当前修订那一行一直留着', async () => {
    await drain()
    const sheet = await newSheet()
    expect((await saved(await save(sheet, '一', { baseRevision: 1 }))).revision).toBe(2)
    expect((await saved(await save(sheet, '二', { baseRevision: 2 }))).revision).toBe(3)
    // 内容相同：修订号不变，写一条回执
    const unchanged = randomUUID()
    expect(await saved(await save(sheet, '二', { baseRevision: 3, requestId: unchanged }))).toMatchObject({ revision: 3, unchanged: true })
    expect((await saved(await save(sheet, '三', { baseRevision: 3 }))).revision).toBe(4)
    expect(await revisionsOf(sheet.id)).toEqual([1, 2, 3, 4])
    expect(await receiptsOf(sheet.id)).toEqual([unchanged])

    // 还差一天：一条不删
    await expect(purge(await daysLater(29))).resolves.toEqual({ ran: true, revisions: 0, receipts: 0, batches: 1, ending: 'drained' })
    expect(await revisionsOf(sheet.id)).toEqual([1, 2, 3, 4])

    // 边界：回执写下的那一刻再过 30 天（库里带微秒，这里截到毫秒，所以不晚于它）还不算过期；它之前的三行修订记录都过了，分两批删掉
    const receiptAt = await database.query(async client => (await client.query<{ created_at: Date }>('SELECT created_at FROM document_save_receipts WHERE request_id = $1', [unchanged])).rows[0]?.created_at)
    expect(receiptAt).toBeInstanceOf(Date)
    const receiptExpiry = (receiptAt ?? new Date(Number.NaN)).getTime() + 30 * DAY_MS
    await expect(purge(new Date(receiptExpiry))).resolves.toEqual({ ran: true, revisions: 3, receipts: 0, batches: 2, ending: 'drained' })
    expect(await revisionsOf(sheet.id)).toEqual([4])
    expect(await receiptsOf(sheet.id)).toEqual([unchanged])
    // 再过 1 毫秒：回执也过了
    await expect(purge(new Date(receiptExpiry + 1))).resolves.toEqual({ ran: true, revisions: 0, receipts: 1, batches: 1, ending: 'drained' })
    expect(await receiptsOf(sheet.id)).toEqual([])

    // 当前修订那一行早已过了保留期，照样留着
    await expect(purge(await daysLater(400))).resolves.toEqual({ ran: true, revisions: 0, receipts: 0, batches: 1, ending: 'drained' })
    expect(await revisionsOf(sheet.id)).toEqual([4])
  })

  it('删掉之后同一个 requestId 的重试不再是重放（按新的保存处理，得到修订号冲突）；当前修订那一行的重放照样成立，冲突与申请编辑权的来源、"内容相同"的保存时间照样读得到', async () => {
    const sheet = await newSheet()
    const tab = randomUUID()
    const [first, sameAgain, latest] = [randomUUID(), randomUUID(), randomUUID()]
    const original = await saved(await save(sheet, '一', { baseRevision: 1, requestId: first }))
    expect(await saved(await save(sheet, '一', { baseRevision: 2, requestId: sameAgain }))).toMatchObject({ revision: 2, unchanged: true })
    const current = await saved(await save(sheet, '二', { baseRevision: 2, requestId: latest, clientInstanceId: tab }))
    expect(current.revision).toBe(3)

    // 删之前：两次都是重放，原来的结果原样给出
    expect(await saved(await save(sheet, '一', { baseRevision: 1, requestId: first }))).toEqual(original)
    expect(await saved(await save(sheet, '一', { baseRevision: 2, requestId: sameAgain }))).toEqual({ revision: 2, savedAt: original.savedAt, unchanged: true })

    await purge(await daysLater(31))
    expect(await revisionsOf(sheet.id)).toEqual([3])
    expect(await receiptsOf(sheet.id)).toEqual([])

    // 删之后：同一个请求按新的保存处理——基准落后，修订号冲突；冲突的来源取当前修订那一行（本人保存的，给出标签页与序号）
    const source = { clientInstanceId: tab, localSeq: 1 }
    expect(await conflictOf(await save(sheet, '一', { baseRevision: 1, requestId: first }))).toEqual({ currentRevision: 3, source })
    expect(await conflictOf(await save(sheet, '一', { baseRevision: 2, requestId: sameAgain }))).toEqual({ currentRevision: 3, source })
    // 当前修订那一行的重放照样成立
    expect(await saved(await save(sheet, '二', { baseRevision: 2, requestId: latest, clientInstanceId: tab }))).toEqual(current)
    // 内容相同不递增：给出的保存时间是当前修订那一行的时间
    expect(await saved(await save(sheet, '二', { baseRevision: 3 }))).toEqual({ ...current, unchanged: true })
    // 申请编辑权：响应里的来源同样取当前修订那一行
    const leaseTab = randomUUID()
    const response = await asUser(app.baseUrl, amySession, `/api/documents/${sheet.id}/edit-lease`, { method: 'POST', body: acquireBody(leaseTab) })
    expect(response.status).toBe(201)
    const acquired = parseExact(acquiredEditLeaseSchema, await response.json())
    expect({ revision: acquired.revision, source: acquired.source }).toEqual({ revision: 3, source })
    await releaseLease(app.baseUrl, amySession, sheet.id, { token: acquired.token, writeEpoch: acquired.writeEpoch, clientInstanceId: leaseTab })
  })

  it('新建、复制、另存为副本的幂等窗口随之是保留期：那一行删掉之后同一个 requestId 是一次新的请求；没再保存过的（那一行就是当前修订）照样重放', async () => {
    // 新建之后保存过一次（新建那一行不再是当前修订）与没再保存过的
    const edited = await newSheet('保存过的')
    await saved(await save(edited, '改过', { baseRevision: 1 }))
    const untouched = await newSheet('没动过的')
    // 复制：一份之后保存过，一份没有
    const [copiedEdited, copiedUntouched] = [randomUUID(), randomUUID()]
    const copyEdited = await created(await postCopy(edited.id, copiedEdited))
    await saved(await save({ id: copyEdited.id, unitId: edited.unitId }, '副本改过', { baseRevision: 1 }))
    const copyUntouched = await created(await postCopy(edited.id, copiedUntouched))
    // 另存为副本：之后保存过（副本的 unitId 与原文档相同）
    const conflictCopied = randomUUID()
    const conflictCopy = await created(await postConflictCopy(app.baseUrl, amySession, edited.id, edited.unitId, { requestId: conflictCopied }))
    await saved(await save({ id: conflictCopy.id, unitId: edited.unitId }, '冲突副本改过', { baseRevision: 1 }))

    await purge(await daysLater(31))

    // 那一行还在（当前修订）：重放，给出的是同一份
    expect(await created(await postDocument(untouched.requestId, '没动过的'))).toMatchObject({ id: untouched.id, replayed: true })
    expect(await created(await postCopy(edited.id, copiedUntouched))).toMatchObject({ id: copyUntouched.id, replayed: true })
    // 那一行删掉了：同一个 requestId 是一次新的请求，建出另一份
    const again = await created(await postDocument(edited.requestId, '保存过的'))
    expect(again).toMatchObject({ replayed: false })
    expect(again.id).not.toBe(edited.id)
    const copyAgain = await created(await postCopy(edited.id, copiedEdited))
    expect(copyAgain).toMatchObject({ replayed: false })
    expect(copyAgain.id).not.toBe(copyEdited.id)
    const conflictCopyAgain = await created(await postConflictCopy(app.baseUrl, amySession, edited.id, edited.unitId, { requestId: conflictCopied }))
    expect(conflictCopyAgain).toMatchObject({ replayed: false })
    expect(conflictCopyAgain.id).not.toBe(conflictCopy.id)
  })
})

describe('一轮怎样跑', () => {
  it('分批：一批至多 NERVE_REVISION_PURGE_BATCH 条修订记录与这么多条回执、最旧的先删；退出（signal 已经中止）时做完手上这一批就停，余下的留给下一轮', async () => {
    await drain()
    const sheet = await newSheet()
    for (let revision = 1; revision <= 5; revision += 1)
      await saved(await save(sheet, `第 ${revision} 次`, { baseRevision: revision }))
    // 内容与当前相同的三次保存：三条回执
    const receipts = [randomUUID(), randomUUID(), randomUUID()]
    for (const requestId of receipts)
      expect(await saved(await save(sheet, '第 5 次', { baseRevision: 6, requestId }))).toMatchObject({ unchanged: true })
    expect(await revisionsOf(sheet.id)).toEqual([1, 2, 3, 4, 5, 6])
    expect(await receiptsOf(sheet.id)).toEqual(receipts)

    const later = await daysLater(31)
    await expect(purge(later, AbortSignal.abort())).resolves.toEqual({ ran: true, revisions: BATCH, receipts: BATCH, batches: 1, ending: 'stopped' })
    expect(await revisionsOf(sheet.id)).toEqual([3, 4, 5, 6])
    expect(await receiptsOf(sheet.id)).toEqual(receipts.slice(BATCH))
    // 下一轮删完：一批满了（哪一样满了都算）接着删，两样都不满一批就停
    await expect(purge(later)).resolves.toEqual({ ran: true, revisions: 3, receipts: 1, batches: 2, ending: 'drained' })
    expect(await revisionsOf(sheet.id)).toEqual([6])
    expect(await receiptsOf(sheet.id)).toEqual([])
  })

  it('两个实例同时跑：另一个实例持着这把锁时，这一轮整个跳过；锁放开之后照常', async () => {
    await drain()
    const sheet = await newSheet()
    await saved(await save(sheet, '一', { baseRevision: 1 }))
    const later = await daysLater(31)
    await database.query(async (client) => {
      // 另一个连接（模拟另一个实例的一批）在事务里拿着同一把锁
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [REVISION_PURGE_LOCK])
      try {
        await expect(purge(later)).resolves.toEqual({ ran: false, revisions: 0, receipts: 0, batches: 0, ending: 'contended' })
        expect(await revisionsOf(sheet.id)).toEqual([1, 2])
      }
      finally {
        await client.query('ROLLBACK')
      }
    })
    await expect(purge(later)).resolves.toEqual({ ran: true, revisions: 1, receipts: 0, batches: 1, ending: 'drained' })
    expect(await revisionsOf(sheet.id)).toEqual([2])
  })

  it('保留的天数取自配置（NERVE_REVISION_RETENTION_DAYS=15）', async () => {
    const sheet = await newSheet()
    await saved(await save(sheet, '一', { baseRevision: 1 }))
    const fifteen = await startTestApp({ databaseUrl: database.url, env: { NERVE_REVISION_RETENTION_DAYS: '15' } })
    try {
      await expect(purge(await daysLater(14), undefined, fifteen)).resolves.toMatchObject({ revisions: 0, receipts: 0 })
      expect(await revisionsOf(sheet.id)).toEqual([1, 2])
      await purge(await daysLater(16), undefined, fifteen)
      expect(await revisionsOf(sheet.id)).toEqual([2])
    }
    finally {
      await fifteen.close()
    }
  })
})

describe('与并发的写入交错', () => {
  it('保存正等着文档行的锁时跑一轮：这一轮不等它，也不删它的基准（那时的当前修订）；保存随后照常提交，下一轮再删它的基准', async () => {
    await drain()
    const sheet = await newSheet()
    await saved(await save(sheet, '一', { baseRevision: 1 }))
    // 先申请好编辑权：让被测的保存（而不是申请）停在文档行的锁上
    const lease = await acquireLease(app.baseUrl, amySession, sheet.id)
    const later = await daysLater(31)
    let round: RevisionPurgeRound | undefined
    const response = await raceAgainstHeldLock(database, {
      // 保存在事务里锁文档行（能编辑时 FOR UPDATE）：测试先持着它
      hold: async client => client.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [sheet.id]),
      request: async () => save(sheet, '二', { baseRevision: 2, lease }),
      change: async () => {
        // 保存还停在锁上：这一轮不碰文档行，不必等它
        const running = purge(later)
        expect(await completesWithoutWaiting(database, running, 2), '保留期的清理不该等文档行的锁').toBe(true)
        round = await running
      },
    })
    expect(round).toEqual({ ran: true, revisions: 1, receipts: 0, batches: 1, ending: 'drained' })
    expect((await saved(response)).revision).toBe(3)
    await releaseLease(app.baseUrl, amySession, sheet.id, lease)
    // 那一轮删的是新建那一行；保存的基准（那时的当前修订）留下了，保存提交之后它不再是当前修订，下一轮删掉
    expect(await revisionsOf(sheet.id)).toEqual([2, 3])
    await expect(purge(later)).resolves.toEqual({ ran: true, revisions: 1, receipts: 0, batches: 1, ending: 'drained' })
    expect(await revisionsOf(sheet.id)).toEqual([3])
  })

  it('一份文档正在被永久删除（外键级联锁着它的修订记录与回执）时跑一轮：跳过被锁着的行，不等、不死锁；别的照常删，跳过的留给下一轮', async () => {
    await drain()
    const [deleting, other] = [await newSheet('正在永久删除的'), await newSheet('别的')]
    await saved(await save(deleting, '一', { baseRevision: 1 }))
    expect(await saved(await save(deleting, '一', { baseRevision: 2 }))).toMatchObject({ unchanged: true })
    await saved(await save(other, '一', { baseRevision: 1 }))
    expect(await saved(await save(other, '一', { baseRevision: 2 }))).toMatchObject({ unchanged: true })
    const later = await daysLater(31)
    const round = await database.query(async (client) => {
      await client.query('BEGIN')
      try {
        // 永久删除的效果：删文档行，级联删（锁住）它的修订记录与回执；提交之前跑一轮
        await client.query('DELETE FROM documents WHERE id = $1', [deleting.id])
        const running = purge(later)
        expect(await completesWithoutWaiting(database, running, 1), '保留期的清理不该等被级联删除锁着的行').toBe(true)
        return await running
      }
      finally {
        // 回滚：这份文档回来了，它的修订记录与回执还在
        await client.query('ROLLBACK')
      }
    })
    expect(round).toEqual({ ran: true, revisions: 1, receipts: 1, batches: 1, ending: 'drained' })
    expect(await revisionsOf(other.id)).toEqual([2])
    expect(await receiptsOf(other.id)).toEqual([])
    expect(await revisionsOf(deleting.id)).toEqual([1, 2])
    expect(await receiptsOf(deleting.id)).toHaveLength(1)
    await expect(purge(later)).resolves.toEqual({ ran: true, revisions: 1, receipts: 1, batches: 1, ending: 'drained' })
    expect(await revisionsOf(deleting.id)).toEqual([2])
    expect(await receiptsOf(deleting.id)).toEqual([])
  })

  it('几份文档同时保存的同时跑几轮：保存都成功，每一轮都正常结束，最后只剩当前修订', async () => {
    await drain()
    const sheets = await Promise.all(['甲', '乙', '丙'].map(async title => newSheet(title)))
    const later = await daysLater(31)
    const saving = Promise.all(sheets.map(async (sheet) => {
      const results: number[] = []
      for (let revision = 1; revision <= 3; revision += 1)
        results.push((await saved(await save(sheet, `${sheet.id} 第 ${revision} 次`, { baseRevision: revision }))).revision)
      return results
    }))
    const rounds: RevisionPurgeRound[] = []
    const purging = (async () => {
      for (let round = 0; round < 6; round += 1)
        rounds.push(await purge(later))
    })()
    const [revisions] = await Promise.all([saving, purging])
    expect(revisions).toEqual([[2, 3, 4], [2, 3, 4], [2, 3, 4]])
    expect(rounds.map(round => [round.ran, round.ending])).toEqual(Array.from({ length: 6 }, () => [true, 'drained']))
    await purge(later)
    for (const sheet of sheets)
      expect(await revisionsOf(sheet.id)).toEqual([4])
  })
})

describe('定时器', () => {
  it('应用自己按间隔跑，每一轮的"现在"是数据库的时间：过了保留期的不必等谁来触发，当前修订那一行留着', async () => {
    const sheet = await newSheet()
    await saved(await save(sheet, '一', { baseRevision: 1 }))
    const unchanged = randomUUID()
    expect(await saved(await save(sheet, '一', { baseRevision: 2, requestId: unchanged }))).toMatchObject({ unchanged: true })
    await saved(await save(sheet, '二', { baseRevision: 2 }))
    // 这份文档的修订记录与回执都挪到 31 天之前（连当前修订那一行也挪）：数据库的时间看来都过了保留期
    await database.query(async (client) => {
      await client.query('UPDATE document_revisions SET created_at = now() - interval \'31 days\' WHERE document_id = $1', [sheet.id])
      await client.query('UPDATE document_save_receipts SET created_at = now() - interval \'31 days\' WHERE document_id = $1', [sheet.id])
    })

    const timed = await startTestApp({ databaseUrl: database.url, env: { NERVE_REVISION_PURGE_ENABLED: 'true', NERVE_REVISION_PURGE_INTERVAL_MS: '1000' } })
    try {
      const deadline = performance.now() + 20_000
      while ((await revisionsOf(sheet.id)).length > 1 || (await receiptsOf(sheet.id)).length > 0) {
        if (performance.now() > deadline)
          throw new Error('20 秒内定时器没有删掉过了保留期的修订记录与回执')
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      expect(await revisionsOf(sheet.id)).toEqual([3])
      expect(timed.logs.entries().some(line => line.job === 'revision-purge' && String(line.msg).includes('修订记录与回执的保留期清理已启动'))).toBe(true)
      expect(timed.logs.entries().some(line => line.job === 'revision-purge' && String(line.msg).includes('删掉了过了保留期的修订记录与回执'))).toBe(true)
    }
    finally {
      await timed.close()
    }
  })
})
