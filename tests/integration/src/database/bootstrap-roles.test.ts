// 数据库的两个角色（P5 设计 §3.3，审查 A21）：用部署的初始化脚本（deploy/sql/bootstrap-roles.sql）建角色与库，
// 所有者执行迁移，应用以应用角色运行：关不掉审计表的触发器、改不了审计记录、执行不了 DDL，业务的读写照常；
// 以所有者或超级用户运行时，启动自检告警。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { readExpectedMigrations, runMigrations } from '@nerve-office/api'
import { createdDocumentSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { databaseUrl, testDatabaseName, testDatabaseUrl, withClient } from '../support/database.ts'
import { runPsqlScript } from '../support/psql-script.ts'
import { asUser, login } from '../support/session-client.ts'

const SCRIPT = readFileSync(fileURLToPath(new URL('../../../../deploy/sql/bootstrap-roles.sql', import.meta.url)), 'utf8')
const BYPASS_WARNING = '连接数据库的角色关得掉审计表的触发器，审计记录只追加的保护可以被绕过：生产环境请用只有读写权限的应用角色（见部署说明）'
const RESTRICTED = '数据库角色关不掉审计表的触发器'

const name = testDatabaseName()
const roles = { owner: `${name}_owner`, app: `${name}_app` }
const passwords = { owner: randomBytes(18).toString('base64url'), app: randomBytes(18).toString('base64url') }

function urlAs(role: string, password: string): string {
  const url = new URL(databaseUrl(name))
  url.username = role
  url.password = password
  return url.toString()
}

const ownerUrl = urlAs(roles.owner, passwords.owner)
const appUrl = urlAs(roles.app, passwords.app)

/** 以应用角色访问这个库：测试数据也经应用角色写入，顺带验证它的权限 */
const asApp: TestDatabase = {
  name,
  url: appUrl,
  query: async fn => withClient(fn, appUrl),
  drop: async () => {},
}

const apps: TestApp[] = []

beforeAll(async () => {
  await runPsqlScript(SCRIPT, {
    connectionString: testDatabaseUrl(),
    variables: { owner_role: roles.owner, app_role: roles.app, database: name },
    env: { NERVE_DB_OWNER_PASSWORD: passwords.owner, NERVE_DB_APP_PASSWORD: passwords.app },
  })
  await runMigrations({ connectionString: ownerUrl, lockTimeoutMs: 30_000 })
})

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

afterAll(async () => {
  await withClient(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`)
    await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(roles.app)}`)
    await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(roles.owner)}`)
  })
})

async function start(databaseUrl: string): Promise<TestApp> {
  const app = await startTestApp({ databaseUrl })
  apps.push(app)
  return app
}

async function first<T extends Record<string, unknown>>(client: pg.Client, query: string, values: unknown[] = []): Promise<T | undefined> {
  return (await client.query<T>(query, values)).rows[0]
}

describe('初始化脚本', () => {
  it('出错即停；建角色之前关掉这个会话的语句日志：明文的密码不进服务器日志（审查 A2）', () => {
    const firstRole = SCRIPT.search(/^CREATE ROLE/m)
    const settings = [
      'SET log_statement = \'none\';',
      'SET log_min_error_statement = \'panic\';',
      'SET log_min_duration_statement = -1;',
      // 抽样与统计视图同样会记下语句原文（复验 RA1）
      'SET log_min_duration_sample = -1;',
      'SET log_transaction_sample_rate = 0;',
      'SET pg_stat_statements.track_utility = off;',
    ]
    expect(SCRIPT.indexOf('\\set ON_ERROR_STOP on')).toBeGreaterThanOrEqual(0)
    for (const line of settings) {
      expect(SCRIPT.indexOf(line), line).toBeGreaterThanOrEqual(0)
      expect(SCRIPT.indexOf(line), line).toBeLessThan(firstRole)
    }
  })

  it('库属于所有者，编码与排序规则与开发库相同；只有两个角色能连接', async () => {
    const database = await withClient(async client => first(client, `
      SELECT pg_get_userbyid(datdba) AS owner, pg_encoding_to_char(encoding) AS encoding, datlocprovider AS provider, datlocale AS locale,
             has_database_privilege('public', datname, 'CONNECT') AS public_connect,
             has_database_privilege('public', datname, 'TEMPORARY') AS public_temporary,
             has_database_privilege($2, datname, 'CONNECT') AS app_connect
      FROM pg_database WHERE datname = $1`, [name, roles.app]))
    expect(database).toEqual({ owner: roles.owner, encoding: 'UTF8', provider: 'b', locale: 'C.UTF-8', public_connect: false, public_temporary: false, app_connect: true })
  })

  it('两个角色都不是超级用户，不能建库、建角色', async () => {
    const attributes = await withClient(async client => (await client.query<Record<string, unknown>>(
      'SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname',
      [[roles.app, roles.owner]],
    )).rows)
    expect(attributes).toEqual([roles.app, roles.owner].map(rolname => ({
      rolname,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: true,
    })))
  })
})

describe('应用角色的权限', () => {
  it('不拥有任何对象，也不能切换成所有者', async () => {
    await withClient(async (client) => {
      expect(await first(client, 'SELECT count(*) AS owned FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)')).toEqual({ owned: '0' })
      await expect(client.query(`SET ROLE ${pg.escapeIdentifier(roles.owner)}`)).rejects.toMatchObject({ code: '42501' })
    }, appUrl)
  })

  it('关不掉审计表的触发器，改不了、删不了、清空不了审计记录', async () => {
    await withClient(async (client) => {
      await client.query('INSERT INTO audit_events (action, actor_type, source) VALUES (\'auth.logout\', \'system\', \'cli\')')
      await expect(client.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only')).rejects.toMatchObject({ code: '42501' })
      await expect(client.query('ALTER TABLE audit_events DISABLE TRIGGER ALL')).rejects.toMatchObject({ code: '42501' })
      await expect(client.query('UPDATE audit_events SET details = \'{}\'')).rejects.toThrow('audit_events 只追加')
      await expect(client.query('DELETE FROM audit_events')).rejects.toThrow('audit_events 只追加')
      await expect(client.query('TRUNCATE audit_events')).rejects.toMatchObject({ code: '42501' })
      await expect(client.query('DROP TRIGGER audit_events_append_only ON audit_events')).rejects.toMatchObject({ code: '42501' })
    }, appUrl)
  })

  it('执行不了 DDL：建表、建 schema、改表、删表都被拒绝', async () => {
    await withClient(async (client) => {
      await expect(client.query('CREATE TABLE intruder (id int)')).rejects.toMatchObject({ code: '42501' })
      await expect(client.query('CREATE SCHEMA intruder')).rejects.toMatchObject({ code: '42501' })
      await expect(client.query('ALTER TABLE users ADD COLUMN intruder int')).rejects.toMatchObject({ code: '42501' })
      await expect(client.query('DROP TABLE auth_sessions')).rejects.toMatchObject({ code: '42501' })
    }, appUrl)
  })

  it('迁移记录只读：就绪探针读得到，改不了', async () => {
    await withClient(async (client) => {
      expect(await first(client, 'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations')).toEqual({ count: readExpectedMigrations().length })
      await expect(client.query('DELETE FROM drizzle.__drizzle_migrations')).rejects.toMatchObject({ code: '42501' })
      await expect(client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (\'x\', 0)')).rejects.toMatchObject({ code: '42501' })
    }, appUrl)
  })
})

describe('以不同的角色运行应用', () => {
  it('应用角色：就绪，启动自检不告警；登录、新建、保存、读取、退出都正常', async () => {
    const app = await start(appUrl)
    expect((await fetch(`${app.baseUrl}/api/health/ready`)).status).toBe(200)
    // 启动自检最多等 2 秒，超过时启动之后才记：等到结果再断言（复验 RA4）
    await vi.waitFor(() => expect(app.logs.entries().map(entry => entry.msg)).toContain(RESTRICTED), { timeout: 10_000 })
    expect(app.logs.entries().map(entry => entry.msg)).not.toContain(BYPASS_WARNING)

    const alice = await createAccount(asApp, { username: 'alice' })
    const session = await login(app.baseUrl, 'alice', alice.password)
    const created = await asUser(app.baseUrl, session, '/api/documents', { method: 'POST', body: { type: 'sheet', title: '角色验证', requestId: randomUUID() } })
    expect(created.status).toBe(201)
    const document = parseExact(createdDocumentSchema, await created.json())
    const contentPath = `/api/documents/${document.id}/content`
    const unitId = (JSON.parse(await (await asUser(app.baseUrl, session, contentPath)).text()) as { id: string }).id
    const sheet = SHEET_TEMPLATE.sheets['sheet-1']
    const raw = Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: unitId, sheets: { 'sheet-1': { ...sheet, cellData: { 0: { 0: { v: '应用角色' } } } } } }), 'utf8')
    const query = new URLSearchParams({ baseRevision: '1', requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: '1' })
    const saved = await asUser(app.baseUrl, session, `${contentPath}?${query.toString()}`, { method: 'PUT', binary: { contentType: 'application/gzip', bytes: zlib.gzipSync(raw) } })
    expect(saved.status).toBe(200)
    expect(Buffer.from(await (await asUser(app.baseUrl, session, contentPath)).arrayBuffer())).toEqual(raw)
    expect((await asUser(app.baseUrl, session, '/api/auth/logout', { method: 'POST' })).status).toBe(204)

    const actions = await withClient(async client => (await client.query<{ action: string }>('SELECT action FROM audit_events WHERE actor_type = \'user\' ORDER BY occurred_at, id')).rows.map(row => row.action), appUrl)
    expect(actions).toEqual(['auth.login_succeeded', 'documents.created', 'documents.content_saved', 'auth.logout'])
  })

  it('所有者：审计表是它的，启动自检告警', async () => {
    const app = await start(ownerUrl)
    await vi.waitFor(() => expect(app.logs.entries()).toContainEqual(expect.objectContaining({ level: 'warn', msg: BYPASS_WARNING, role: roles.owner, superuser: false, ownsAuditTable: true })), { timeout: 10_000 })
  })

  it('超级用户（开发库与本机测试的账号）：启动自检告警', async () => {
    const app = await start(databaseUrl(name))
    await vi.waitFor(() => expect(app.logs.entries()).toContainEqual(expect.objectContaining({ level: 'warn', msg: BYPASS_WARNING, superuser: true })), { timeout: 10_000 })
  })
})
