// M4-P2 S3：部署能力由共同的会话响应组装，实际 HTTP 的每个登录入口都必须给出同一个事实。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { issuedInvitationSchema, issuedPasswordResetSchema, sessionResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { postPublic, tokenOf } from '../support/links.ts'
import { asUser, login, postLogin } from '../support/session-client.ts'

const cases: readonly { label: string, env: Readonly<Record<string, string>>, enabled: boolean }[] = [
  { label: '默认开启', env: {}, enabled: true },
  { label: '显式开启', env: { NERVE_LOCAL_DRAFTS_ENABLED: 'true' }, enabled: true },
  { label: '部署关闭', env: { NERVE_LOCAL_DRAFTS_ENABLED: 'false' }, enabled: false },
]

describe.each(cases)('US-M4-15 $label：全部会话入口返回本机草稿能力', ({ env, enabled }) => {
  let database: TestDatabase
  let app: TestApp
  let admin: LoggedIn
  let password: string

  beforeAll(async () => {
    database = await createTestDatabase()
    app = await startTestApp({ databaseUrl: database.url, env })
    const account = await createAccount(database, { username: 'feature-admin', systemRole: 'admin' })
    password = account.password
    admin = await login(app.baseUrl, 'feature-admin', password)
  })

  afterAll(async () => {
    await app.close()
    await database.drop()
  })

  async function expectFeature(response: Response): Promise<void> {
    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    // 先看真实响应，不能让 schema 为旧响应补的 false 掩盖服务端漏字段。
    expect(body).toMatchObject({ features: { localDraftsEnabled: enabled } })
    expect(parseExact(sessionResponseSchema, body)).toMatchObject({ features: { localDraftsEnabled: enabled } })
  }

  it('登录', async () => {
    await expectFeature(await postLogin(app.baseUrl, { username: 'feature-admin', password }))
  })

  it('当前会话', async () => {
    await expectFeature(await asUser(app.baseUrl, admin, '/api/auth/session'))
  })

  it('修改密码后换上的会话', async () => {
    const account = await createAccount(database, { username: 'feature-password' })
    const session = await login(app.baseUrl, account.username, account.password)
    await expectFeature(await asUser(app.baseUrl, session, '/api/auth/password', {
      method: 'PUT',
      body: { currentPassword: account.password, newPassword: 'changed feature password' },
    }))
  })

  it('接受邀请后新建的会话', async () => {
    const response = await asUser(app.baseUrl, admin, '/api/admin/invitations', {
      method: 'POST',
      body: { username: 'feature-invited', displayName: '草稿能力测试' },
    })
    expect(response.status).toBe(201)
    const issued = parseExact(issuedInvitationSchema, await response.json())
    await expectFeature(await postPublic(app.baseUrl, '/api/auth/invitations/accept', {
      token: tokenOf(issued.url),
      displayName: '受邀成员',
      password: 'invited feature password',
    }))
  })

  it('完成密码重置后新建的会话', async () => {
    const account = await createAccount(database, { username: 'feature-reset' })
    const response = await asUser(app.baseUrl, admin, `/api/admin/users/${account.id}/password-reset`, { method: 'POST' })
    expect(response.status).toBe(201)
    const issued = parseExact(issuedPasswordResetSchema, await response.json())
    await expectFeature(await postPublic(app.baseUrl, '/api/auth/password-resets/complete', {
      token: tokenOf(issued.url),
      password: 'reset feature password',
    }))
  })
})
