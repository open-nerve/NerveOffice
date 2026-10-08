// US-M3-17 本机密钥（M3-P6 设计 §3.5、§3.6）：本人取当前的一把（POST /api/local-key，第一次取时生成第 1 版）、系统管理员吊销（擦掉密钥材料、
// 同时生成下一版、记审计）、管理界面的账户带当前的摘要、正在编辑的页面经心跳得知当前的版本。真实的 HTTP 与 PostgreSQL；
// 库里的包装结果在测试这一侧按设计的格式独立解开（support/local-keys.ts），证明服务端确实是这样加密保存的。
// 并发与确定的交错见 local-key-races.test.ts，主密钥对不上与包装结果被改动见 master-key-mismatch.test.ts，权限矩阵见 permissions/local-key-matrix.test.ts
import type { AdminUser, LocalKey } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { adminUserListResponseSchema, adminUserSchema, CSRF_TOKEN_HEADER, errorResponseSchema, localKeySchema, renewedEditLeaseSchema, revokeLocalKeyResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp, startTestAppInTimeZone, TEST_LOCAL_KEYS_MASTER_KEY, TEST_PUBLIC_ORIGIN } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, renewLease } from '../support/edit-leases.ts'
import { currentMaterialOf, expectMonotonicTimeline, fetchLocalKey, localKeyMomentsOf, localKeyRowsOf, masterKeyIdOf, revokeLocalKey, takeLocalKey, unwrapLocalKey, wrapLocalKey } from '../support/local-keys.ts'
import { requestIdOf } from '../support/request-id.ts'
import { asUser, login, SESSION_COOKIE } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let rootSession: LoggedIn
let people = 0
/** 这个文件里接口交出过的每一把原始密钥（base64）：文件结束时核对应用的日志里一把也没有 */
const issued = new Set<string>()

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'keys-root', systemRole: 'admin' })
  rootSession = await login(app.baseUrl, root.username, root.password)
})

/** 应用的日志里没有主密钥，也没有任何一把交出过的原始密钥（base64 与十六进制都找） */
function expectNoKeyMaterialIn(logs: string): void {
  const master = Buffer.from(TEST_LOCAL_KEYS_MASTER_KEY, 'base64')
  for (const secret of [TEST_LOCAL_KEYS_MASTER_KEY, master.toString('hex'), master.toString('utf8'), ...[...issued].flatMap(key => [key, Buffer.from(key, 'base64').toString('hex')])])
    expect(logs.includes(secret), '应用的日志里有密钥材料').toBe(false)
}

afterAll(async () => {
  try {
    // 整个文件的应用日志
    expect(issued.size).toBeGreaterThanOrEqual(8)
    expectNoKeyMaterialIn(app.logs.text())
  }
  finally {
    await app.close()
    await database.drop()
  }
})

/** 每条用例一个新的人（吊销、停用会改他，互不影响） */
async function person(): Promise<{ account: TestAccount, session: LoggedIn }> {
  people += 1
  const account = await createAccount(database, { username: `keys-${people}` })
  return { account, session: await login(app.baseUrl, account.username, account.password) }
}

/** 取用成功，记下交出的原始密钥 */
async function take(session: LoggedIn): Promise<LocalKey> {
  const key = await takeLocalKey(app.baseUrl, session)
  issued.add(key.key)
  return key
}

async function errorOf(response: Response): Promise<[number, string | undefined]> {
  const text = await response.text()
  const parsed = errorResponseSchema.safeParse(text === '' ? undefined : JSON.parse(text))
  return [response.status, parsed.success ? parsed.data.error.code : undefined]
}

/** 这个人的吊销审计（逐字核对用的各列），按时间 */
async function revocationAuditsOf(userId: string): Promise<Record<string, unknown>[]> {
  return database.query(async client => (await client.query<Record<string, unknown>>(
    `SELECT action, actor_type, actor_id, target_type, target_id, source, request_id, host(client_ip) AS client_ip, details
     FROM audit_events WHERE action = 'users.local_key_revoked' AND target_id = $1 ORDER BY occurred_at, id`,
    [userId],
  )).rows)
}

describe('US-M3-17 本人取当前的本机密钥（POST /api/local-key）', () => {
  it('第一次取：生成第 1 版——200、响应逐字、key 是 32 字节、不缓存（Cache-Control: no-store）、没有 ETag；再取、换一台设备登录再取都是同一把；库里只有这一行', async () => {
    const { account, session } = await person()
    expect(await localKeyRowsOf(database, account.id)).toEqual([])
    const response = await fetchLocalKey(app.baseUrl, session)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    // 没有 Express 按响应体自动算的 ETag：响应体就是原始密钥，ETag 会是它的稳定指纹（M3-P6 审查 A8）
    expect(response.headers.has('etag')).toBe(false)
    const first = parseExact(localKeySchema, await response.json())
    issued.add(first.key)
    expect(first.version).toBe(1)
    expect(Buffer.from(first.key, 'base64')).toHaveLength(32)
    expect(await take(session)).toEqual(first)
    const elsewhere = await login(app.baseUrl, account.username, account.password)
    expect(await take(elsewhere)).toEqual(first)
    const rows = await localKeyRowsOf(database, account.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ version: 1, revokedAt: null })
  })

  it('库里是加密保存的：用测试的主密钥按设计的格式解开那一行，等于交出的（绑定这个人与这一版）；库里的任何一列都不含原始密钥的字节', async () => {
    const { account, session } = await person()
    const key = await take(session)
    const raw = Buffer.from(key.key, 'base64')
    const material = await currentMaterialOf(database, account.id)
    expect(material.masterKeyId.equals(masterKeyIdOf())).toBe(true)
    expect(unwrapLocalKey(material, { userId: account.id, version: 1 }).equals(raw)).toBe(true)
    expect(() => unwrapLocalKey(material, { userId: root.id, version: 1 })).toThrow()
    expect(() => unwrapLocalKey(material, { userId: account.id, version: 2 })).toThrow()
    expect(material.wrappedKey.includes(raw)).toBe(false)
    const dump = await database.query(async client => (await client.query<{ row: string }>('SELECT row_to_json(k)::text AS row FROM user_local_keys AS k')).rows.map(row => row.row).join('\n'))
    expect(dump).toContain(account.id)
    expect(dump).not.toContain(raw.toString('hex'))
    expect(dump).not.toContain(key.key)
  })

  it('状态变更的防护照常：没带 CSRF 令牌 403、Origin 不对 403、未登录 401；都不生成密钥', async () => {
    const { account, session } = await person()
    expect(await errorOf(await fetchLocalKey(app.baseUrl, session, { [CSRF_TOKEN_HEADER]: undefined }))).toEqual([403, 'CSRF_TOKEN_INVALID'])
    expect(await errorOf(await fetchLocalKey(app.baseUrl, session, { origin: 'https://evil.example' }))).toEqual([403, 'ORIGIN_NOT_ALLOWED'])
    expect(await errorOf(await fetch(`${app.baseUrl}/api/local-key`, { method: 'POST', headers: { origin: TEST_PUBLIC_ORIGIN } }))).toEqual([401, 'UNAUTHENTICATED'])
    expect(await localKeyRowsOf(database, account.id)).toEqual([])
  })

  it.each([
    ['退出', async (_account: TestAccount, session: LoggedIn) => {
      expect((await asUser(app.baseUrl, session, '/api/auth/logout', { method: 'POST' })).status).toBe(204)
    }],
    ['管理员签发重置链接（撤销这个人的全部登录）', async (account: TestAccount) => {
      expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${account.id}/password-reset`, { method: 'POST' })).status).toBe(201)
    }],
    ['停用', async (account: TestAccount) => {
      expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${account.id}/disable`, { method: 'POST' })).status).toBe(200)
    }],
    ['别的设备上修改密码', async (account: TestAccount) => {
      const elsewhere = await login(app.baseUrl, account.username, account.password)
      expect((await asUser(app.baseUrl, elsewhere, '/api/auth/password', { method: 'PUT', body: { currentPassword: account.password, newPassword: 'a brand new password 2026' } })).status).toBe(200)
    }],
    ['空闲过期', async (_account: TestAccount, session: LoggedIn) => {
      const digest = createHash('sha256').update(session.cookie.slice(`${SESSION_COOKIE}=`.length)).digest()
      expect(await database.query(async client => (await client.query('UPDATE auth_sessions SET idle_expires_at = now() - interval \'1 second\' WHERE token_hash = $1', [digest])).rowCount)).toBe(1)
    }],
  ])('%s之后取不到：401 SESSION_EXPIRED（会话守卫挡住；守卫之后、事务之前的窗口见 local-key-races.test.ts）', async (_case, revoke) => {
    const { account, session } = await person()
    await take(session)
    await revoke(account, session)
    expect(await errorOf(await fetchLocalKey(app.baseUrl, session))).toEqual([401, 'SESSION_EXPIRED'])
  })
})

describe('US-M3-17 系统管理员吊销本机密钥（POST /api/admin/users/{id}/local-key/revoke）', () => {
  it('吊销：200，这一次的结果是吊销第 1 版、换成第 2 版，账户的现状里本机密钥是第 2 版；旧的那一行记下吊销的时刻、擦掉密钥材料；下一版立即存在、用现在的主密钥包装；本人再取得到下一版、不同的字节；审计逐字；响应里没有密钥材料', async () => {
    const { account, session } = await person()
    const first = await take(session)
    const response = await revokeLocalKey(app.baseUrl, rootSession, account.id)
    expect(response.status).toBe(200)
    const text = await response.text()
    const { revoked: thisTime, account: view } = parseExact(revokeLocalKeyResponseSchema, JSON.parse(text))
    expect(thisTime).toEqual({ version: 1, nextVersion: 2 })
    expect(view).toMatchObject({ id: account.id, status: 'active', localKey: { version: 2 } })

    const rows = await localKeyRowsOf(database, account.id)
    expect(rows.map(row => ({ version: row.version, revoked: row.revokedAt !== null, masterKeyId: row.masterKeyId, wrappedKey: row.wrappedKey === null ? null : 'material' })))
      .toEqual([{ version: 1, revoked: true, masterKeyId: null, wrappedKey: null }, { version: 2, revoked: false, masterKeyId: masterKeyIdOf(), wrappedKey: 'material' }])
    const [revoked, current] = rows
    expect(revoked?.revokedAt?.getTime()).toBeGreaterThanOrEqual(revoked?.createdAt.getTime() ?? Number.POSITIVE_INFINITY)
    expect(view.localKey?.createdAt).toBe(current?.createdAt.toISOString())
    const next = unwrapLocalKey(await currentMaterialOf(database, account.id), { userId: account.id, version: 2 })

    const second = await take(session)
    expect(second).toEqual({ version: 2, key: next.toString('base64') })
    expect(second.key).not.toBe(first.key)
    for (const key of [first.key, second.key])
      expect(text).not.toContain(key)

    expect(await revocationAuditsOf(account.id)).toEqual([{
      action: 'users.local_key_revoked',
      actor_type: 'user',
      actor_id: root.id,
      target_type: 'user',
      target_id: account.id,
      source: 'http',
      request_id: requestIdOf(response),
      client_ip: '127.0.0.1',
      details: { version: 1 },
    }])
    // 吊销不撤销登录（设计 §3.1：设备丢失时另要生成重置链接），这次登录照常
    expect((await asUser(app.baseUrl, session, '/api/auth/session')).status).toBe(200)
  })

  it('再吊销一次：吊销第 2 版、生成第 3 版，审计的明细是 2；版本从 1 起连续', async () => {
    const { account, session } = await person()
    await take(session)
    expect((await revokeLocalKey(app.baseUrl, rootSession, account.id)).status).toBe(200)
    const again = parseExact(revokeLocalKeyResponseSchema, await (await revokeLocalKey(app.baseUrl, rootSession, account.id)).json())
    expect([again.revoked, again.account.localKey?.version]).toEqual([{ version: 2, nextVersion: 3 }, 3])
    expect((await localKeyRowsOf(database, account.id)).map(row => [row.version, row.revokedAt === null])).toEqual([[1, false], [2, false], [3, true]])
    expect((await revocationAuditsOf(account.id)).map(audit => audit.details)).toEqual([{ version: 1 }, { version: 2 }])
    expect((await take(session)).version).toBe(3)
  })

  it('应用连接的会话时区不是 UTC（上海）时吊销两次：每一版生成于上一版被吊销的那一刻（逐微秒相等，不变量 I21）、时间线单调，账户里的生成时刻与库里的一致（复验 C2：测试库的会话默认是 UTC，时刻的换算漏了时区也看不出来）', async () => {
    // 照 jobs/trash-purge.test.ts：连接串带上会话时区，另起一个应用；先核对应用自己的连接确实在上海时区（support/api-app.ts）
    const shanghai = await startTestAppInTimeZone({ databaseUrl: database.url, timeZone: 'Asia/Shanghai' })
    try {
      people += 1
      const account = await createAccount(database, { username: `keys-${people}` })
      const admin = await login(shanghai.baseUrl, root.username, root.password)
      const session = await login(shanghai.baseUrl, account.username, account.password)
      const first = await takeLocalKey(shanghai.baseUrl, session)
      issued.add(first.key)
      expect(first.version).toBe(1)
      let view: AdminUser['localKey'] = null
      for (const version of [2, 3]) {
        const response = await revokeLocalKey(shanghai.baseUrl, admin, account.id)
        expect(response.status, await response.clone().text()).toBe(200)
        const revocation = parseExact(revokeLocalKeyResponseSchema, await response.json())
        view = revocation.account.localKey
        expect([revocation.revoked?.nextVersion, view?.version]).toEqual([version, version])
      }
      await expectMonotonicTimeline(database, account.id, 3)
      // 账户里第 3 版的生成时刻（毫秒精度的 ISO 文本）与库里的（微秒）相差不到 1 毫秒，不差 8 小时
      const current = (await localKeyMomentsOf(database, account.id)).at(-1)
      expect(Math.abs(new Date(view?.createdAt ?? '').getTime() - new Date(current?.createdAt ?? '').getTime())).toBeLessThanOrEqual(1)
      const latest = await takeLocalKey(shanghai.baseUrl, session)
      issued.add(latest.key)
      expect(latest.version).toBe(3)
      expectNoKeyMaterialIn(shanghai.logs.text())
    }
    finally {
      await shanghai.close()
    }
  })

  it('从没取过：这一次的结果为空（没有可吊销的），现状里本机密钥为空；不记审计、什么也不写；之后第一次取得到第 1 版', async () => {
    const { account, session } = await person()
    const response = await revokeLocalKey(app.baseUrl, rootSession, account.id)
    expect(response.status).toBe(200)
    const { revoked, account: view } = parseExact(revokeLocalKeyResponseSchema, await response.json())
    expect(revoked).toBeNull()
    expect(view).toMatchObject({ id: account.id, localKey: null })
    expect(await revocationAuditsOf(account.id)).toEqual([])
    expect(await localKeyRowsOf(database, account.id)).toEqual([])
    expect((await take(session)).version).toBe(1)
  })

  it('停用的账户能吊销（设备丢失常在离职之后）；停用本身不吊销；启用之后本人取到的是下一版', async () => {
    const { account, session } = await person()
    const first = await take(session)
    expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${account.id}/disable`, { method: 'POST' })).status).toBe(200)
    // 停用不顺带吊销（设计 §3.1：停用是可撤回的暂停）
    expect((await localKeyRowsOf(database, account.id)).map(row => row.revokedAt)).toEqual([null])
    const response = await revokeLocalKey(app.baseUrl, rootSession, account.id)
    expect(parseExact(revokeLocalKeyResponseSchema, await response.json())).toMatchObject({ revoked: { version: 1, nextVersion: 2 }, account: { status: 'disabled', localKey: { version: 2 } } })
    expect((await revocationAuditsOf(account.id)).map(audit => audit.details)).toEqual([{ version: 1 }])
    expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${account.id}/enable`, { method: 'POST' })).status).toBe(200)
    const again = await login(app.baseUrl, account.username, account.password)
    const next = await take(again)
    expect(next.version).toBe(2)
    expect(next.key).not.toBe(first.key)
  })

  it('吊销自己：照常（自己的登录不受影响），再取得到下一版', async () => {
    people += 1
    const admin = await createAccount(database, { username: `keys-${people}`, systemRole: 'admin' })
    const session = await login(app.baseUrl, admin.username, admin.password)
    const first = await take(session)
    const response = await revokeLocalKey(app.baseUrl, session, admin.id)
    expect(parseExact(revokeLocalKeyResponseSchema, await response.json())).toMatchObject({ revoked: { version: 1, nextVersion: 2 }, account: { id: admin.id, localKey: { version: 2 } } })
    expect((await revocationAuditsOf(admin.id))[0]).toMatchObject({ actor_id: admin.id, target_id: admin.id, details: { version: 1 } })
    const next = await take(session)
    expect(next.version).toBe(2)
    expect(next.key).not.toBe(first.key)
  })

  it('管理界面的账户带着当前的本机密钥：详情与列表里，取过的人是版本与生成的时刻，没取过的为空', async () => {
    const { account: keyed, session } = await person()
    const { account: never } = await person()
    await take(session)
    const [row] = await localKeyRowsOf(database, keyed.id)
    const detail = parseExact(adminUserSchema, await (await asUser(app.baseUrl, rootSession, `/api/admin/users/${keyed.id}`)).json())
    expect(detail.localKey).toEqual({ version: 1, createdAt: row?.createdAt.toISOString() })
    expect(parseExact(adminUserSchema, await (await asUser(app.baseUrl, rootSession, `/api/admin/users/${never.id}`)).json()).localKey).toBeNull()
    const list = parseExact(adminUserListResponseSchema, await (await asUser(app.baseUrl, rootSession, '/api/admin/users?query=keys-')).json())
    const byId = new Map(list.items.map(item => [item.id, item.localKey]))
    expect(byId.get(keyed.id)).toEqual({ version: 1, createdAt: row?.createdAt.toISOString() })
    expect(byId.get(never.id)).toBeNull()
  })

  it('账户的摘要只取当前的那一把：库里的行先是当前的第 2 版、后是吊销了的第 1 版（物理顺序与版本相反）时，详情与列表给的仍是第 2 版（审查 A4）', async () => {
    const { account } = await person()
    const material = wrapLocalKey(randomBytes(32), { userId: account.id, version: 2 })
    await database.query(async (client) => {
      await client.query('BEGIN')
      try {
        // 同一个事务里 now() 是同一个值：第 2 版生成于第 1 版被吊销的那一刻（不变量 I21）
        await client.query(
          'INSERT INTO user_local_keys (user_id, version, master_key_id, wrapped_key, created_at) VALUES ($1, 2, $2, $3, now() - interval \'1 hour\')',
          [account.id, material.masterKeyId, material.wrappedKey],
        )
        await client.query('INSERT INTO user_local_keys (user_id, version, created_at, revoked_at) VALUES ($1, 1, now() - interval \'2 hours\', now() - interval \'1 hour\')', [account.id])
        await client.query('COMMIT')
      }
      catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    })
    // 前提：物理顺序确实是第 2 版在前——不限"当前的"时按物理顺序读出来，同一个人的最后一行是吊销了的第 1 版，摘要就错成它
    const physical = await database.query(async client => (await client.query<{ version: number }>('SELECT version FROM user_local_keys WHERE user_id = $1 ORDER BY ctid', [account.id])).rows)
    expect(physical.map(row => row.version)).toEqual([2, 1])
    const current = (await localKeyRowsOf(database, account.id)).find(row => row.revokedAt === null)
    const summary = { version: 2, createdAt: current?.createdAt.toISOString() }
    expect(current?.version).toBe(2)
    expect(parseExact(adminUserSchema, await (await asUser(app.baseUrl, rootSession, `/api/admin/users/${account.id}`)).json()).localKey).toEqual(summary)
    const list = parseExact(adminUserListResponseSchema, await (await asUser(app.baseUrl, rootSession, `/api/admin/users?query=${account.username}`)).json())
    expect(list.items.find(item => item.id === account.id)?.localKey).toEqual(summary)
  })
})

describe('US-M3-17 正在编辑的页面经心跳得知调用者自己当前的版本（M3-P6 设计 §3.6）', () => {
  it('从没取过时 null；取过是 1；吊销之后下一次心跳是 2；只看调用者自己的——文档的创建人（别人）的密钥被吊销不影响它', async () => {
    const { account: amy, session: amySession } = await person()
    const { account: ben, session: benSession } = await person()
    const space = await createTeamSpace(database, { name: `本机密钥：心跳 ${people}`, createdBy: root.id, members: { [amy.id]: 'editor', [ben.id]: 'editor' } })
    const document = await seedDocument(database, { spaceId: space, createdBy: ben.id, title: '心跳带版本' })
    // 创建人（本）先有一把：读错了人的话，下面第一次心跳就不是 null
    await take(benSession)
    const lease = await acquireLease(app.baseUrl, amySession, document.id)
    const heartbeat = async (): Promise<number | null> => {
      const response = await renewLease(app.baseUrl, amySession, document.id, lease)
      expect(response.status).toBe(200)
      return parseExact(renewedEditLeaseSchema, await response.json()).localKeyVersion
    }
    expect(await heartbeat()).toBeNull()
    await take(amySession)
    expect(await heartbeat()).toBe(1)
    expect((await revokeLocalKey(app.baseUrl, rootSession, amy.id)).status).toBe(200)
    expect(await heartbeat()).toBe(2)
    // 本的被吊销两次（到第 3 版）：艾米的心跳照旧是她自己的第 2 版
    expect((await revokeLocalKey(app.baseUrl, rootSession, ben.id)).status).toBe(200)
    expect((await revokeLocalKey(app.baseUrl, rootSession, ben.id)).status).toBe(200)
    expect(await heartbeat()).toBe(2)
  })
})
