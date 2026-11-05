// 手动测量（M5-P7 Q-03）：删除大文件夹时，删除前检查点在同一事务里逐份复制原 gzip，事务持有空间树锁与全部文档行锁。
// 每个规模点一个新的隔离库，测完即删；经正式接口删除，记录删除耗时、WAL 增量，以及同一空间里并发的结构性操作（新建文件夹）
// 等空间树锁的结果。正文用不可压缩的内容取最坏情况（原 gzip 接近未压缩大小；未压缩上限 5 MiB 由表约束保证）。
// 只由显式手动命令运行，不进默认测试、覆盖率或 CI：
//   python3 -B tools/test-resources/run.py integration -- pnpm exec vitest run --config vitest.folder-delete-measure.config.ts
import type pg from 'pg'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { gzipSync } from 'node:zlib'
import { createdFolderSchema } from '@nerve-office/contracts'
import { afterAll, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

/** 有界规模：总的原 gzip 不超过约 200 MiB 一点，三点合计写入（源、副本与 WAL）约 1.5 GiB；更大规模按字节线性外推 */
const POINTS = [
  { name: '1000x64KiB', documents: 1000, rawBytes: 64 * 1024 },
  { name: '200x1MiB', documents: 200, rawBytes: 1024 * 1024 },
  { name: '50x5MiB', documents: 50, rawBytes: 5 * 1024 * 1024 },
] as const
/** 应用连接的默认 lock_timeout（NERVE_DATABASE_LOCK_TIMEOUT_MS）：并发操作等锁超过它就失败 */
const LOCK_TIMEOUT_MS = 5000

const results: unknown[] = []
afterAll(() => {
  expect(results).toHaveLength(POINTS.length)
  process.stdout.write(`FOLDER_DELETE_RESULT=${JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, lockTimeoutMs: LOCK_TIMEOUT_MS, results })}\n`)
})

async function wal(database: TestDatabase): Promise<{ lsn: string, databaseBytes: number }> {
  return database.query(async client => (await client.query<{ lsn: string, databaseBytes: number }>(
    'SELECT pg_current_wal_insert_lsn()::text AS lsn, pg_database_size(current_database())::float8 AS "databaseBytes"',
  )).rows[0]!)
}

async function walBytes(database: TestDatabase, from: string, to: string): Promise<number> {
  return database.query(async client => (await client.query<{ bytes: number }>('SELECT pg_wal_lsn_diff($2::pg_lsn, $1::pg_lsn)::float8 AS bytes', [from, to])).rows[0]!.bytes)
}

/** 删除事务已经拿到这个空间的空间树锁（与 holdSpaceTree 同一个键） */
async function treeLockHeld(client: pg.Client, spaceId: string): Promise<boolean> {
  return (await client.query<{ held: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_locks l, (SELECT hashtextextended('nerve-office:space-tree:' || $1::uuid::text, 0) AS k) h
      WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND l.classid::bigint = ((h.k >> 32) & 4294967295) AND l.objid::bigint = (h.k & 4294967295)
    ) AS held`, [spaceId])).rows[0]!.held
}

async function newFolder(app: TestApp, user: LoggedIn, spaceId: string, name: string) {
  return asUser(app.baseUrl, user, '/api/folders', { method: 'POST', body: { requestId: randomUUID(), spaceId, name } })
}

it.each(POINTS)('$name：经正式接口删除整个文件夹，记录耗时、WAL 与并发等锁', async (point) => {
  const database = await createTestDatabase()
  let app: TestApp | undefined
  try {
    app = await startTestApp({ databaseUrl: database.url })
    const root = await createAccount(database, { username: 'measure-root', systemRole: 'admin' })
    const admin = await createAccount(database, { username: 'measure-admin' })
    const spaceId = await createTeamSpace(database, { name: '文件夹删除测量', createdBy: root.id, members: { [admin.id]: 'admin' } })
    const session = await login(app.baseUrl, 'measure-admin', admin.password)
    const created = await newFolder(app, session, spaceId, '大文件夹')
    expect(created.status).toBe(201)
    const folder = parseExact(createdFolderSchema, await created.json())

    // 不可压缩的正文：base64 随机串，gzip 后约为原大小的 3/4
    const raw = randomBytes(point.rawBytes * 3 / 4).toString('base64')
    const snapshot = gzipSync(Buffer.from(raw, 'utf8'))
    const seedStarted = performance.now()
    for (let i = 0; i < point.documents; i++) {
      const document = await seedDocument(database, { spaceId, createdBy: admin.id, title: `文档 ${i}`, folderId: folder.id })
      await database.query(async client => client.query('UPDATE document_contents SET snapshot=$1, raw_bytes=$2, stored_bytes=$3 WHERE document_id=$4', [snapshot, Buffer.byteLength(raw, 'utf8'), snapshot.length, document.id]))
    }
    const seedMs = performance.now() - seedStarted
    await database.query(async client => client.query('CHECKPOINT'))
    const before = await wal(database)

    const started = performance.now()
    const deletion = asUser(app.baseUrl, session, `/api/folders/${folder.id}`, { method: 'DELETE' }).then(response => ({ status: response.status, ms: performance.now() - started }))
    // 删除事务拿到空间树锁之后，再在同一空间发起一个结构性操作（新建文件夹），看它等锁的结果
    const overlapped = await database.query(async (client) => {
      for (;;) {
        if (await treeLockHeld(client, spaceId))
          return true
        if (await Promise.race([deletion.then(() => true), new Promise<boolean>(resolve => setTimeout(resolve, 2, false))]))
          return false
      }
    })
    const probeStarted = performance.now()
    const probe = overlapped
      ? await newFolder(app, session, spaceId, '并发新建').then(async response => ({ status: response.status, code: response.status === 201 ? undefined : (await response.json() as { code?: string }).code, waitedMs: performance.now() - probeStarted }))
      : undefined
    const deleted = await deletion
    const after = await wal(database)
    expect(deleted.status).toBe(204)
    const copied = await database.query(async client => (await client.query<{ count: number, bytes: number }>(
      'SELECT count(*)::int AS count, coalesce(sum(stored_bytes), 0)::float8 AS bytes FROM document_checkpoints WHERE kind = \'before_delete\'',
    )).rows[0]!)
    expect(copied.count).toBe(point.documents)

    results.push({
      name: point.name,
      documents: point.documents,
      rawBytesPerDocument: Buffer.byteLength(raw, 'utf8'),
      storedBytesPerDocument: snapshot.length,
      copiedBytes: copied.bytes,
      seedMs: Math.round(seedMs),
      deleteStatus: deleted.status,
      deleteMs: Math.round(deleted.ms),
      walBytes: await walBytes(database, before.lsn, after.lsn),
      databaseGrowthBytes: after.databaseBytes - before.databaseBytes,
      probe: probe === undefined ? { overlapped: false } : { overlapped: true, ...probe, waitedMs: Math.round(probe.waitedMs) },
    })
  }
  finally {
    await app?.close()
    await database.drop()
  }
})
