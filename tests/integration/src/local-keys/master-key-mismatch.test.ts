// 主密钥与库里的对不上、包装结果被改动（M3-P6 设计 §3.1、§3.4、§3.5）：照常启动、文档照常可用；启动自检记下现在的主密钥的标识，
// 库里有别的主密钥包装的就记 error（把数、两边的标识与处置）；那个人取用 500，请求日志里有用户、版本与标识、没有密钥材料，不自动重新生成；
// 系统管理员吊销之后（吊销不需要旧的主密钥）他取到用现在的主密钥包装的下一版。同一个库先后起两个应用，sessions 在库里，登录照常沿用。
// 日志只给把数：部署说明里"找出要吊销的人"的 SQL 照抄出来执行，核对它列出的正是这些人（审查 B4）
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LogEntry } from '../support/log-capture.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { errorResponseSchema, revokeLocalKeyResponseSchema } from '@nerve-office/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp, TEST_LOCAL_KEYS_MASTER_KEY } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { currentMaterialOf, fetchLocalKey, localKeyRowsOf, masterKeyIdOf, revokeLocalKey, takeLocalKey, unwrapLocalKey } from '../support/local-keys.ts'
import { asUser, login } from '../support/session-client.ts'

const started: TestApp[] = []
const databases: TestDatabase[] = []

afterEach(async () => {
  for (const app of started.splice(0))
    await app.close()
  for (const database of databases.splice(0))
    await database.drop()
})

async function start(database: TestDatabase, masterKey: string = TEST_LOCAL_KEYS_MASTER_KEY): Promise<TestApp> {
  const app = await startTestApp({ databaseUrl: database.url, env: { NERVE_LOCAL_KEYS_MASTER_KEY: masterKey } })
  started.push(app)
  return app
}

/** 一个库、一位系统管理员与一位成员，成员先在 app 上取过第 1 版 */
async function world(): Promise<{ database: TestDatabase, app: TestApp, adminSession: LoggedIn, amy: { id: string, session: LoggedIn }, first: string }> {
  const database = await createTestDatabase()
  databases.push(database)
  const app = await start(database)
  const admin = await createAccount(database, { username: 'mismatch-root', systemRole: 'admin' })
  const amy = await createAccount(database, { username: 'mismatch-amy' })
  const amySession = await login(app.baseUrl, amy.username, amy.password)
  const first = await takeLocalKey(app.baseUrl, amySession)
  expect(first.version).toBe(1)
  return { database, app, adminSession: await login(app.baseUrl, admin.username, admin.password), amy: { id: amy.id, session: amySession }, first: first.key }
}

/** 请求日志里意外错误的那一条（异常过滤器判定为意外错误时带着 err） */
function unexpectedErrors(app: TestApp): LogEntry[] {
  return app.logs.entries().filter(entry => entry.msg === '请求失败' && typeof entry.err === 'object')
}

async function errorCodeOf(response: Response): Promise<[number, string]> {
  return [response.status, parseExact(errorResponseSchema, await response.json()).error.code]
}

/** 部署说明（deploy/README.md 的"本机密钥的主密钥"一节）里"找出要吊销的人"那条 psql 命令 -c 之后的 SQL */
const HOLDERS_COMMAND = /psql -U nerve_app -d nerve_office -c "([^"]+)"/
const MASTER_KEY_PLACEHOLDER = 'decode(\'<masterKeyId>\', \'hex\')'

/**
 * 照抄部署说明里的那条 SQL 执行（审查 B4：运维照它找出要逐个吊销的人）：foreign 按说明把 <masterKeyId> 换成启动日志里现在的标识；
 * all 按说明去掉主密钥那一句（所有取过本机密钥的人）。说明里的写法跟着库结构走：表、列改了名，或者说明里的命令改了样子，这里就失败
 */
async function documentedHolders(database: TestDatabase, masterKeyId: string, scope: 'foreign' | 'all'): Promise<Record<string, unknown>[]> {
  const readme = readFileSync(new URL('../../../../deploy/README.md', import.meta.url), 'utf8')
  const documented = HOLDERS_COMMAND.exec(readme)?.[1]
  if (documented === undefined || !documented.includes(` AND k.master_key_id <> ${MASTER_KEY_PLACEHOLDER}`))
    throw new Error('部署说明里没有找到"找出要吊销的人"的那条 SQL（或者它的写法变了）')
  const text = scope === 'foreign'
    ? documented.replace(MASTER_KEY_PLACEHOLDER, `decode('${masterKeyId}', 'hex')`)
    : documented.replace(` AND k.master_key_id <> ${MASTER_KEY_PLACEHOLDER}`, '')
  return database.query(async client => (await client.query<Record<string, unknown>>(text)).rows)
}

describe('主密钥与库里的对不上（M3-P6 设计 §3.1：记 error、照常启动；处置走显式的吊销）', () => {
  it('换了主密钥重启：启动自检记 error，带两边的标识与把数；文档、登录照常；那个人取用 500、不自动重新生成；部署说明里的查法列出的正是她；吊销之后取到用新主密钥包装的下一版', async () => {
    const { database, app, adminSession, amy, first } = await world()
    expect(app.logs.entries().find(entry => entry.msg === '本机密钥的主密钥已就绪')).toMatchObject({ level: 'info', masterKeyId: masterKeyIdOf().toString('hex'), currentKeys: 0 })
    await app.close()
    started.splice(started.indexOf(app), 1)

    const replaced = randomBytes(32).toString('base64')
    const next = await start(database, replaced)
    const check = next.logs.entries().find(entry => entry.module === 'local-keys' && entry.level === 'error')
    expect(check).toMatchObject({
      msg: expect.stringContaining('不是现在配置的主密钥包装的') as unknown,
      masterKeyId: masterKeyIdOf(replaced).toString('hex'),
      currentKeys: 0,
      foreignKeys: 1,
      foreignMasterKeys: [{ masterKeyId: masterKeyIdOf().toString('hex'), keys: 1 }],
    })
    // 登录照常（会话在库里）、文档照常
    expect((await asUser(next.baseUrl, amy.session, '/api/auth/session')).status).toBe(200)

    const failed = await fetchLocalKey(next.baseUrl, amy.session)
    const text = await failed.clone().text()
    expect(await errorCodeOf(failed)).toEqual([500, 'INTERNAL_ERROR'])
    expect(text).not.toContain(first)
    const [logged] = unexpectedErrors(next)
    expect(logged?.err).toMatchObject({
      type: 'LocalKeyUnwrapError',
      reason: 'unknown_master_key',
      userId: amy.id,
      version: 1,
      masterKeyId: masterKeyIdOf().toString('hex'),
      currentMasterKeyId: masterKeyIdOf(replaced).toString('hex'),
    })
    // 不自动重新生成：库里还是原来那一行
    expect((await localKeyRowsOf(database, amy.id)).map(row => [row.version, row.revokedAt === null])).toEqual([[1, true]])

    // 找出要吊销的人（审查 B4）：部署说明里照抄的那条 SQL，用启动日志里现在的 masterKeyId，列出的正是取不到的她；
    // 按说明去掉主密钥那一句（所有取过本机密钥的人）同样只有她（管理员没取过）
    const holder = { username: 'mismatch-amy', status: 'active', version: 1, master_key_id: masterKeyIdOf().toString('hex') }
    expect(await documentedHolders(database, String(check?.masterKeyId), 'foreign')).toEqual([holder])
    expect(await documentedHolders(database, String(check?.masterKeyId), 'all')).toEqual([holder])

    // 处置：系统管理员吊销（不需要旧的主密钥），下一版用现在的主密钥包装
    const revoked = await revokeLocalKey(next.baseUrl, adminSession, amy.id)
    expect(parseExact(revokeLocalKeyResponseSchema, await revoked.json())).toMatchObject({ revoked: { version: 1, nextVersion: 2 }, account: { localKey: { version: 2 } } })
    const material = await currentMaterialOf(database, amy.id)
    expect(material.masterKeyId.equals(masterKeyIdOf(replaced))).toBe(true)
    const second = await takeLocalKey(next.baseUrl, amy.session)
    expect(second).toEqual({ version: 2, key: unwrapLocalKey(material, { userId: amy.id, version: 2 }, replaced).toString('base64') })
    // 吊销之后她不再列在"不是现在这把主密钥包装的"里
    expect(await documentedHolders(database, String(check?.masterKeyId), 'foreign')).toEqual([])

    // 两个应用的日志里都没有两把主密钥与交出过的原始密钥
    const logs = `${app.logs.text()}\n${next.logs.text()}`
    for (const secret of [TEST_LOCAL_KEYS_MASTER_KEY, replaced, Buffer.from(replaced, 'base64').toString('hex'), first, second.key, Buffer.from(first, 'base64').toString('hex')])
      expect(logs.includes(secret), '日志里有密钥材料').toBe(false)
  })

  it('库里的包装结果被改动（或损坏）：取用 500（对不上），请求日志说明原因、没有密钥材料，不自动重新生成；吊销之后恢复', async () => {
    const { database, app, adminSession, amy, first } = await world()
    // 标签里的一个字节翻一位（直接改库：模拟被改动或损坏）
    await database.query(async client => client.query('UPDATE user_local_keys SET wrapped_key = set_byte(wrapped_key, 50, get_byte(wrapped_key, 50) # 1) WHERE user_id = $1', [amy.id]))
    const failed = await fetchLocalKey(app.baseUrl, amy.session)
    expect(await errorCodeOf(failed)).toEqual([500, 'INTERNAL_ERROR'])
    expect(unexpectedErrors(app).at(-1)?.err).toMatchObject({ type: 'LocalKeyUnwrapError', reason: 'not_authentic', userId: amy.id, version: 1 })
    expect((await localKeyRowsOf(database, amy.id)).map(row => [row.version, row.revokedAt === null])).toEqual([[1, true]])
    expect((await revokeLocalKey(app.baseUrl, adminSession, amy.id)).status).toBe(200)
    const second = await takeLocalKey(app.baseUrl, amy.session)
    expect(second.version).toBe(2)
    expect(app.logs.text().includes(first)).toBe(false)
    expect(app.logs.text().includes(second.key)).toBe(false)
  })
})
