// 本机密钥的权限矩阵（M3-P6 设计 §3.7，US-M3-17）：预期逐格手写，不调用生产代码的规则来算。
// - 取用（POST /api/local-key）× 调用者：成员与系统管理员都只取到自己的那一把（200），未登录 401 UNAUTHENTICATED，会话已撤销 401 SESSION_EXPIRED；
// - 吊销（POST /api/admin/users/{id}/local-key/revoke）× 调用者 {成员、系统管理员、未登录} × 对象 {有效的人、停用的人、自己、不存在、id 不合法}：
//   只有系统管理员（会话守卫拦下别人，与对象存不存在无关——看不到与不存在的核对里豁免），不存在 404，id 不合法 400。
// 每一格用新的对象：200 的格子核对确实吊销了（版本加一、一条审计），失败的格子核对什么也没变（版本不动、没有审计）
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { adminUserSchema, errorResponseSchema, localKeySchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp, TEST_PUBLIC_ORIGIN } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { fetchLocalKey, localKeyRowsOf, revokeLocalKey, takeLocalKey } from '../support/local-keys.ts'
import { asUser, login } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let people = 0

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

type Caller = 'member' | 'admin' | 'anonymous' | 'revoked'
type Target = 'active' | 'disabled' | 'self' | 'missing' | 'invalid'

async function account(systemRole: 'admin' | 'member' = 'member'): Promise<{ account: TestAccount, session: LoggedIn }> {
  people += 1
  const created = await createAccount(database, { username: `matrix-${people}`, systemRole })
  return { account: created, session: await login(app.baseUrl, created.username, created.password) }
}

/** 一格的结局写成一行："200" 或 "403 PERMISSION_DENIED" */
async function outcomeOf(response: Response): Promise<string> {
  if (response.status === 200)
    return '200'
  const text = await response.text()
  const parsed = errorResponseSchema.safeParse(text === '' ? undefined : JSON.parse(text))
  return `${response.status} ${parsed.success ? parsed.data.error.code : text}`
}

/** 调用者的会话；未登录时为 undefined。会话已撤销：登录之后本人退出，留着旧的 Cookie */
async function callerOf(caller: Caller): Promise<{ account: TestAccount | undefined, session: LoggedIn | undefined }> {
  if (caller === 'anonymous')
    return { account: undefined, session: undefined }
  const made = await account(caller === 'admin' ? 'admin' : 'member')
  if (caller === 'revoked')
    expect((await asUser(app.baseUrl, made.session, '/api/auth/logout', { method: 'POST' })).status).toBe(204)
  return made
}

const FETCH: readonly (readonly [Caller, string])[] = [
  ['member', '200'],
  ['admin', '200'],
  ['anonymous', '401 UNAUTHENTICATED'],
  ['revoked', '401 SESSION_EXPIRED'],
]

describe('取用（POST /api/local-key）× 调用者', () => {
  it.each(FETCH)('%s：%s', async (caller, expected) => {
    const { account: who, session } = await callerOf(caller)
    const response = session === undefined
      ? await fetch(`${app.baseUrl}/api/local-key`, { method: 'POST', headers: { origin: TEST_PUBLIC_ORIGIN } })
      : await fetchLocalKey(app.baseUrl, session)
    if (expected === '200')
      expect(parseExact(localKeySchema, await response.clone().json()).version).toBe(1)
    expect(await outcomeOf(response)).toBe(expected)
    // 只生成调用者自己的那一把；失败的格子什么也不写
    if (who !== undefined)
      expect((await localKeyRowsOf(database, who.id)).length).toBe(expected === '200' ? 1 : 0)
  })
})

const REVOKE: readonly (readonly [Caller, Target, string])[] = [
  ['member', 'active', '403 PERMISSION_DENIED'],
  ['member', 'disabled', '403 PERMISSION_DENIED'],
  ['member', 'self', '403 PERMISSION_DENIED'],
  ['member', 'missing', '403 PERMISSION_DENIED'],
  ['member', 'invalid', '403 PERMISSION_DENIED'],
  ['admin', 'active', '200'],
  ['admin', 'disabled', '200'],
  ['admin', 'self', '200'],
  ['admin', 'missing', '404 NOT_FOUND'],
  ['admin', 'invalid', '400 REQUEST_INVALID'],
  ['anonymous', 'active', '401 UNAUTHENTICATED'],
  ['anonymous', 'missing', '401 UNAUTHENTICATED'],
  ['revoked', 'active', '401 SESSION_EXPIRED'],
]

describe('吊销（POST /api/admin/users/{id}/local-key/revoke）× 调用者 × 对象', () => {
  it.each(REVOKE)('%s 吊销 %s：%s', async (caller, target, expected) => {
    const { account: who, session } = await callerOf(caller)
    // 对象：有自己的一把（第 1 版）的人；停用的人在停用之前取过；自己也先取一把
    let targetId: string
    let keyed: string | undefined
    if (target === 'missing') {
      targetId = '0199a2c4-0000-7000-8000-0000000000ff'
    }
    else if (target === 'invalid') {
      targetId = 'not-a-uuid'
    }
    else if (target === 'self' && who !== undefined && session !== undefined) {
      await takeLocalKey(app.baseUrl, session)
      targetId = who.id
      keyed = who.id
    }
    else {
      const other = await account()
      await takeLocalKey(app.baseUrl, other.session)
      if (target === 'disabled')
        await database.query(async client => client.query('UPDATE users SET status = \'disabled\' WHERE id = $1', [other.account.id]))
      targetId = other.account.id
      keyed = other.account.id
    }
    const response = session === undefined
      ? await fetch(`${app.baseUrl}/api/admin/users/${targetId}/local-key/revoke`, { method: 'POST', headers: { origin: TEST_PUBLIC_ORIGIN } })
      : await revokeLocalKey(app.baseUrl, session, targetId)
    if (expected === '200')
      expect(parseExact(adminUserSchema, await response.clone().json())).toMatchObject({ id: targetId, localKey: { version: 2 } })
    expect(await outcomeOf(response)).toBe(expected)
    if (keyed !== undefined) {
      const versions = (await localKeyRowsOf(database, keyed)).map(row => [row.version, row.revokedAt === null])
      expect(versions).toEqual(expected === '200' ? [[1, false], [2, true]] : [[1, true]])
      const audits = await database.query(async client => (await client.query('SELECT 1 FROM audit_events WHERE action = \'users.local_key_revoked\' AND target_id = $1', [keyed])).rowCount)
      expect(audits).toBe(expected === '200' ? 1 : 0)
    }
  })
})
