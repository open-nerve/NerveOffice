// 存活与就绪探针（P2 设计 §3.9）：就绪要求数据库连得上、库结构版本一致。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { errorResponseSchema, healthLiveResponseSchema, healthReadyResponseSchema } from '@nerve-office/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { removeTestAssetRoot, testAssetRoot } from '../support/asset-root.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'

const apps: TestApp[] = []
const databases: TestDatabase[] = []
const roots = new Set<string>()

async function appOn(databaseUrl: string): Promise<TestApp> {
  roots.add(databaseUrl)
  const app = await startTestApp({ databaseUrl })
  apps.push(app)
  return app
}

async function database(options?: { migrated?: boolean }): Promise<TestDatabase> {
  const created = await createTestDatabase(options)
  databases.push(created)
  return created
}

async function notReadyReason(app: TestApp): Promise<string> {
  const response = await fetch(`${app.baseUrl}/api/health/ready`)
  expect(response.status).toBe(503)
  const { error } = parseExact(errorResponseSchema, await response.json())
  expect(error.code).toBe('SERVICE_UNAVAILABLE')
  return error.message
}

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
  for (const created of databases.splice(0))
    await created.drop()
  for (const url of roots)
    await removeTestAssetRoot(url)
  roots.clear()
})

describe('健康检查（进程内的真实应用）', () => {
  it('库已迁移：存活与就绪都返回 200', async () => {
    const app = await appOn((await database()).url)
    const live = await fetch(`${app.baseUrl}/api/health/live`)
    expect(parseExact(healthLiveResponseSchema, await live.json())).toEqual({ status: 'ok' })
    const ready = await fetch(`${app.baseUrl}/api/health/ready`)
    expect(ready.status).toBe(200)
    expect(parseExact(healthReadyResponseSchema, await ready.json())).toEqual({ status: 'ready' })
  })

  it('空库（还没迁移）：就绪 503，说明待执行的迁移个数；启动时记一条警告，不自动迁移', async () => {
    const empty = await database({ migrated: false })
    const app = await appOn(empty.url)
    expect(await notReadyReason(app)).toMatch(/^库结构版本落后：待执行 \d+ 个迁移$/)
    expect(app.logs.entries()).toContainEqual(expect.objectContaining({ level: 'warn', msg: '数据库未就绪，就绪探针会失败' }))
    const tables = await empty.query(async client => (await client.query<{ table: string | null }>('SELECT to_regclass(\'public.audit_events\')::text AS table')).rows[0])
    expect(tables).toEqual({ table: null })
  })

  it('已执行的迁移被改动过：就绪 503，说明库结构不一致', async () => {
    const tampered = await database()
    await tampered.query(async client => client.query('UPDATE drizzle.__drizzle_migrations SET hash = \'tampered\''))
    expect(await notReadyReason(await appOn(tampered.url))).toMatch(/^库结构不一致：/)
  })

  it('数据库不可达，即使有待恢复图片临时文件：存活仍然 200，就绪 503，不清掉上传残留', async () => {
    const url = 'postgres://nerve:nerve_dev_only@127.0.0.1:1/nerve_office'
    roots.add(url)
    const root = testAssetRoot(url)
    await mkdir(join(root, 'staging'), { mode: 0o700, recursive: true })
    const temporary = join(root, 'staging', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp')
    await writeFile(temporary, 'pending image', { mode: 0o600 })
    const app = await appOn(url)
    expect((await fetch(`${app.baseUrl}/api/health/live`)).status).toBe(200)
    expect(await notReadyReason(app)).toBe('数据库不可达')
    expect(await readFile(temporary, 'utf8')).toBe('pending image')
  })
})
