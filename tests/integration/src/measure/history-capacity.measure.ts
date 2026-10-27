// 手动测量：先生成样本，再设置 NERVE_HISTORY_MEASURE_SAMPLES，以专用 Vitest config 串行运行。
// 正式服务、锁、原 gzip 与真实提交；只替换测试时钟的返回时刻，仍执行真实取时 SQL。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { gzipSync } from 'node:zlib'
import { TransactionRunner } from '@nerve-office/api'
import { AssetUploadService, DocumentCheckpointClock, DocumentCheckpointService, DocumentsRepository } from '@nerve-office/api/testing'
import { canonicalContentText, checkResources, contentHashInput, SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'
import { afterAll, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { testAssetRoot } from '../support/asset-root.ts'
import { createAssetActor } from '../support/assets.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'

const sampleSchema = z.object({
  name: z.string().regex(/^(?:big-1m|perf-50k|big-5m)-(?:plain|images)$/),
  source: z.string(),
  rawBytes: z.number().int().positive(),
  gzipBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  assetPlaceholders: z.array(z.uuid()).max(10),
})
const manifestSchema = z.object({ unitId: z.uuid(), samples: z.array(sampleSchema).length(6) })
const directory = process.env.NERVE_HISTORY_MEASURE_SAMPLES
if (directory === undefined || !path.isAbsolute(directory))
  throw new Error('容量测量需要 NERVE_HISTORY_MEASURE_SAMPLES 的绝对目录')
const manifest = manifestSchema.parse(JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8')))
expect(new Set(manifest.samples.map(sample => sample.name)).size).toBe(6)

interface RelationSize {
  name: string
  heap: number
  indexes: number
  toast: number
  total: number
}

async function sizes(database: TestDatabase) {
  return database.query(async client => ({
    relations: (await client.query<RelationSize>(`SELECT relname AS name,
      pg_relation_size(oid)::float8 AS heap, pg_indexes_size(oid)::float8 AS indexes,
      CASE WHEN reltoastrelid=0 THEN 0 ELSE pg_total_relation_size(reltoastrelid) END::float8 AS toast,
      pg_total_relation_size(oid)::float8 AS total FROM pg_class
      WHERE oid IN ('document_checkpoints'::regclass, 'document_history_buckets'::regclass,
        'document_checkpoint_assets'::regclass, 'asset_reference_activity'::regclass)
      ORDER BY relname`)).rows,
    databaseBytes: (await client.query<{ bytes: number }>('SELECT pg_database_size(current_database())::float8 AS bytes')).rows[0]!.bytes,
    lsn: (await client.query<{ lsn: string }>('SELECT pg_current_wal_insert_lsn()::text AS lsn')).rows[0]!.lsn,
    otherActiveClients: (await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE pid<>pg_backend_pid() AND backend_type='client backend' AND state='active'`)).rows[0]!.count,
  }))
}

function latency(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return { rounds: values.length, firstMs: values[0], p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1), allMs: values }
}

const results: unknown[] = []
afterAll(() => {
  expect(results).toHaveLength(6)
  process.stdout.write(`HISTORY_CAPACITY_RESULT=${JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, results })}\n`)
})

it.each(manifest.samples)('$name：168 个小时与 30 个运维事件，逐字节和关系核对', async (sample) => {
  const database = await createTestDatabase()
  let app: TestApp | undefined
  try {
    app = await startTestApp({ databaseUrl: database.url })
    const owner = await createPassiveAccount(database, { username: 'history-capacity' })
    const doc = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: sample.name, unitId: manifest.unitId })
    let raw = await readFile(path.join(directory, `${sample.name}.json`))
    expect(raw.length).toBe(sample.rawBytes)
    expect(createHash('sha256').update(raw).digest('hex')).toBe(sample.sha256)
    expect(gzipSync(raw).length).toBe(sample.gzipBytes)
    const actor = await createAssetActor(database, owner.id)
    const image = await readFile(new URL('../../../../apps/api/src/modules/assets/testdata/minimum.png', import.meta.url))
    const uploaded: string[] = []
    for (const placeholder of sample.assetPlaceholders) {
      const asset = await app.runtime.get(AssetUploadService).upload(actor, async () => ({ data: image, mimeType: 'image/png', extension: 'png' }), new AbortController().signal)
      uploaded.push(asset.assetId)
      raw = Buffer.from(raw.toString('utf8').replaceAll(placeholder, asset.assetId))
    }
    expect(raw.length).toBeLessThanOrEqual(SNAPSHOT_MAX_RAW_BYTES)
    expect(new Set(uploaded).size).toBe(sample.assetPlaceholders.length)
    const snapshot = gzipSync(raw)
    const parsed = z.object({ resources: z.array(z.object({ name: z.string(), data: z.string() })) }).parse(JSON.parse(raw.toString('utf8')))
    const resources = checkResources(parsed.resources, 'sheet@1')
    if (!resources.ok)
      throw new Error('Capacity sample resources are invalid')
    const contentHash = createHash('sha256').update(contentHashInput(canonicalContentText(raw.toString('utf8')))).digest()
    await database.query(async (client) => {
      await client.query(`WITH changed AS (UPDATE document_contents SET snapshot=$2,raw_bytes=$3,stored_bytes=$4,
        resource_names=$5,content_hash=$6 WHERE document_id=$1 RETURNING document_id)
        UPDATE document_revisions r SET content_hash=$6 FROM changed c WHERE r.document_id=c.document_id AND r.revision=1`, [doc.id, snapshot, raw.length, snapshot.length, resources.nonEmpty, contentHash])
      for (const id of uploaded)
        await client.query('INSERT INTO document_asset_links(document_id,asset_id) VALUES($1,$2)', [doc.id, id])
    })
    const objectsBefore = await database.query(async client => (await client.query<{ storage_key: string, bytes: number }>('SELECT storage_key, bytes::float8 AS bytes FROM asset_objects')).rows)
    expect(objectsBefore).toHaveLength(uploaded.length === 0 ? 0 : 1)
    for (const object of objectsBefore)
      expect((await stat(path.join(testAssetRoot(database.url), object.storage_key))).size).toBe(object.bytes)

    const service = app.runtime.get(DocumentCheckpointService)
    const transactions = app.runtime.get(TransactionRunner)
    const documents = app.runtime.get(DocumentsRepository)
    const clock = app.runtime.get(DocumentCheckpointClock)
    const realNow = clock.now.bind(clock)
    const anchor = Math.floor(Date.now() / 3_600_000) * 3_600_000
    let at = new Date(anchor - 167 * 3_600_000)
    vi.spyOn(clock, 'now').mockImplementation(async (transaction) => {
      await realNow(transaction)
      return at
    })
    async function capture(kind: 'hourly' | 'before_upgrade'): Promise<string | undefined> {
      return transactions.run(async (transaction) => {
        await documents.lockById(doc.id, transaction)
        return kind === 'hourly' ? service.captureHourly(doc.id, transaction) : service.captureOperation(doc.id, kind, randomUUID(), transaction)
      })
    }
    const environment = await database.query(async client => (await client.query<Record<string, string>>(`SELECT version() AS version,
      current_setting('block_size') AS block_size, current_setting('wal_level') AS wal_level,
      current_setting('wal_compression') AS wal_compression, current_setting('full_page_writes') AS full_page_writes,
      current_setting('synchronous_commit') AS synchronous_commit, current_setting('default_toast_compression') AS toast_compression`)).rows[0])
    const before = await sizes(database)
    const hours: number[] = []
    const sameHour: number[] = []
    for (let hour = 0; hour < 168; hour++) {
      at = new Date(anchor - (167 - hour) * 3_600_000)
      const started = performance.now()
      const id = await capture('hourly')
      hours.push(performance.now() - started)
      expect(id).toEqual(expect.any(String))
    }
    const hourly = await sizes(database)
    for (let repeat = 0; repeat < 20; repeat++) {
      const started = performance.now()
      const id = await capture('hourly')
      sameHour.push(performance.now() - started)
      expect(id).toBeUndefined()
    }
    const afterSameHour = await sizes(database)
    const operations: number[] = []
    for (let event = 0; event < 30; event++) {
      const started = performance.now()
      const id = await capture('before_upgrade')
      operations.push(performance.now() - started)
      expect(id).toEqual(expect.any(String))
    }
    const after = await sizes(database)
    const facts = await database.query(async client => (await client.query<{
      count: number
      identical: boolean
      validHash: boolean
      distinctBytes: number
      stored: number
      columnBytes: number
      links: number
      buckets: number
      quotaBytes: number
      quotaAssets: number
      activity: number
      hourlyWal: number
      operationsWal: number
    }>(`SELECT count(*)::int AS count, bool_and(snapshot=$2) AS identical,
      bool_and(snapshot_hash=sha256(snapshot)) AS "validHash", count(DISTINCT snapshot_hash)::int AS "distinctBytes",
      sum(stored_bytes)::float8 AS stored, sum(pg_column_size(snapshot))::float8 AS "columnBytes",
      (SELECT count(*)::int FROM document_checkpoint_assets) AS links,
      (SELECT count(*)::int FROM document_history_buckets) AS buckets,
      COALESCE((SELECT used_bytes::float8 FROM asset_quota),0) AS "quotaBytes",
      COALESCE((SELECT used_assets::int FROM asset_quota),0) AS "quotaAssets",
      (SELECT count(*)::int FROM asset_reference_activity) AS activity,
      pg_wal_lsn_diff($3::pg_lsn,$4::pg_lsn)::float8 AS "hourlyWal",
      pg_wal_lsn_diff($6::pg_lsn,$3::pg_lsn)::float8 AS "sameHourWal",
      pg_wal_lsn_diff($5::pg_lsn,$6::pg_lsn)::float8 AS "operationsWal"
      FROM document_checkpoints WHERE source_document_id=$1`, [doc.id, snapshot, hourly.lsn, before.lsn, after.lsn, afterSameHour.lsn])).rows[0]!)
    expect(facts).toMatchObject({ count: 198, identical: true, validHash: true, distinctBytes: 1, stored: 198 * snapshot.length, links: 198 * uploaded.length, buckets: 168, quotaAssets: uploaded.length })
    expect(facts.quotaBytes).toBe(objectsBefore.reduce((sum, object) => sum + object.bytes, 0))
    expect(facts.hourlyWal).toBeGreaterThan(0)
    expect(facts.operationsWal).toBeGreaterThan(0)
    expect(await database.query(async client => (await client.query<{ storage_key: string, bytes: number }>('SELECT storage_key, bytes::float8 AS bytes FROM asset_objects')).rows)).toEqual(objectsBefore)
    results.push({ name: sample.name, rawBytes: raw.length, gzipBytes: snapshot.length, inputSha256: sample.sha256, imageIds: uploaded.length, physicalImageBytes: facts.quotaBytes, environment, hourly: latency(hours), sameHour: latency(sameHour), operations: latency(operations), before, afterHourly: hourly, afterSameHour, afterOperations: after, facts })
  }
  finally {
    vi.restoreAllMocks()
    try {
      await app?.close()
    }
    finally {
      await database.drop()
    }
  }
})
