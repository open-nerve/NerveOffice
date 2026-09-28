// 审计查询（M2-P1 设计 §3.7，US-M2-13）：条件（时间、操作者、动作、对象）、倒序翻页、补上账户与邀请的名字、只给系统管理员。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { auditEventListResponseSchema, errorResponseSchema, issuedInvitationSchema, issuedPasswordResetSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { postPublic, tokenOf } from '../support/links.ts'
import { asUser, login } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let admin: TestAccount
let adminSession: LoggedIn
let target: TestAccount
let invitationId: string

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  admin = await createAccount(database, { username: 'root', displayName: '管理员', systemRole: 'admin' })
  adminSession = await login(app.baseUrl, 'root', admin.password)
  target = await createAccount(database, { username: 'amy', displayName: '艾米' })
  await asUser(app.baseUrl, adminSession, `/api/admin/users/${target.id}/disable`, { method: 'POST' })
  await asUser(app.baseUrl, adminSession, `/api/admin/users/${target.id}/enable`, { method: 'POST' })
  const issued = await asUser(app.baseUrl, adminSession, '/api/admin/invitations', { method: 'POST', body: { username: 'bea', displayName: '贝亚' } })
  invitationId = parseExact(issuedInvitationSchema, await issued.json()).invitation.id
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function search(query: string, session: LoggedIn = adminSession) {
  const response = await asUser(app.baseUrl, session, `/api/admin/audit-events${query}`)
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(auditEventListResponseSchema, await response.json())
}

describe('US-M2-13 审计查询', () => {
  it('按时间倒序；账户补上当前的登录名与显示名，对象是账户时标签是"显示名（登录名）"', async () => {
    const page = await search(`?targetType=user&targetId=${target.id}`)
    expect(page.items.map(item => item.action)).toEqual(['users.enabled', 'users.disabled'])
    const [enabled] = page.items
    expect(enabled?.actor).toEqual({ type: 'user', id: admin.id, username: 'root', displayName: '管理员' })
    expect(enabled?.target).toEqual({ type: 'user', id: target.id, label: '艾米（amy）' })
    expect(enabled?.source).toBe('http')
    expect(enabled?.clientIp).toBe('127.0.0.1')
  })

  it('邀请：对象的标签是登录名；details 原样给出', async () => {
    const page = await search(`?action=users.invited&targetId=${invitationId}`)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.target).toEqual({ type: 'invitation', id: invitationId, label: 'bea' })
    expect(page.items[0]?.details).toEqual({ username: 'bea' })
  })

  it('按操作者与动作过滤；时间范围（含起点、不含终点）', async () => {
    const byActor = await search(`?actorId=${admin.id}&action=users.disabled`)
    expect(byActor.items.map(item => item.target?.id)).toEqual([target.id])
    const future = new Date(Date.now() + 60_000).toISOString()
    expect((await search(`?from=${encodeURIComponent(future)}`)).items).toEqual([])
    const all = await search(`?to=${encodeURIComponent(future)}&actorId=${admin.id}`)
    expect(all.items.length).toBeGreaterThanOrEqual(4)
  })

  it('每页 50 条，游标翻页，不重复不遗漏；游标不是我们发的：400', async () => {
    // 直接写 55 条（审计表只拒绝更新与删除），时间各不相同
    await database.query(async client => client.query(
      `INSERT INTO audit_events (occurred_at, action, actor_type, source) SELECT now() - make_interval(secs => n), 'auth.logout', 'system', 'cli' FROM generate_series(1, 55) AS n`,
    ))
    const first = await search('?action=auth.logout')
    expect(first.items).toHaveLength(50)
    expect(first.nextCursor).not.toBeNull()
    const second = await search(`?action=auth.logout&cursor=${first.nextCursor ?? ''}`)
    expect(second.items).toHaveLength(5)
    expect(second.nextCursor).toBeNull()
    const ids = [...first.items, ...second.items].map(item => item.id)
    expect(new Set(ids).size).toBe(55)
    const response = await asUser(app.baseUrl, adminSession, '/api/admin/audit-events?cursor=broken')
    expect(parseExact(errorResponseSchema, await response.json()).error.code).toBe('REQUEST_INVALID')
  })

  it('没有操作者的事件（系统、未登录的访问者）：操作者只有类型', async () => {
    const page = await search('?action=auth.logout')
    expect(page.items[0]?.actor).toEqual({ type: 'system', id: null, username: null, displayName: null })
  })

  it('成员查询：403；条件不合法（未知的动作、不是 UUID、PostgreSQL 没有的 0 年）：400，不是 500', async () => {
    const member = await createAccount(database, { username: 'cai' })
    const session = await login(app.baseUrl, 'cai', member.password)
    const denied = await asUser(app.baseUrl, session, '/api/admin/audit-events')
    expect(parseExact(errorResponseSchema, await denied.json()).error.code).toBe('PERMISSION_DENIED')
    for (const query of ['?action=users.deleted', '?actorId=root', '?from=yesterday', '?from=0000-01-01T00:00:00Z', '?to=0000-12-31T23:59:59Z']) {
      const response = await asUser(app.baseUrl, adminSession, `/api/admin/audit-events${query}`)
      expect(response.status, query).toBe(400)
    }
  })
})

describe('US-M2-13 审计里没有令牌与密码（审查 A5）', () => {
  it('邀请、接受、修改密码（含一次失败）、签发与完成重置、登录走一遍之后，整张审计表的 details 里没有令牌与密码', async () => {
    const secrets: string[] = []
    const invited = parseExact(issuedInvitationSchema, await (await asUser(app.baseUrl, adminSession, '/api/admin/invitations', { method: 'POST', body: { username: 'dora', displayName: '朵拉' } })).json())
    const invitationToken = tokenOf(invited.url)
    const firstPassword = 'dora first password'
    secrets.push(invitationToken, firstPassword)
    expect((await postPublic(app.baseUrl, '/api/auth/invitations/inspect', { token: invitationToken })).status).toBe(200)
    expect((await postPublic(app.baseUrl, '/api/auth/invitations/accept', { token: invitationToken, displayName: '朵拉', password: firstPassword })).status).toBe(200)

    const dora = await login(app.baseUrl, 'dora', firstPassword)
    const secondPassword = 'dora second password'
    const wrongGuess = 'dora wrong guess'
    secrets.push(secondPassword, wrongGuess)
    expect((await asUser(app.baseUrl, dora, '/api/auth/password', { method: 'PUT', body: { currentPassword: wrongGuess, newPassword: secondPassword } })).status).toBe(403)
    expect((await asUser(app.baseUrl, dora, '/api/auth/password', { method: 'PUT', body: { currentPassword: firstPassword, newPassword: secondPassword } })).status).toBe(204)

    const reset = parseExact(issuedPasswordResetSchema, await (await asUser(app.baseUrl, adminSession, `/api/admin/users/${dora.session.user.id}/password-reset`, { method: 'POST' })).json())
    const resetToken = tokenOf(reset.url)
    const thirdPassword = 'dora third password'
    secrets.push(resetToken, thirdPassword)
    expect((await postPublic(app.baseUrl, '/api/auth/password-resets/inspect', { token: resetToken })).status).toBe(200)
    expect((await postPublic(app.baseUrl, '/api/auth/password-resets/complete', { token: resetToken, password: thirdPassword })).status).toBe(200)
    expect((await postPublic(app.baseUrl, '/api/auth/password-resets/complete', { token: resetToken, password: thirdPassword })).status).toBe(410)
    await login(app.baseUrl, 'dora', thirdPassword)

    const rows = await database.query(async client => (await client.query<{ action: string, details: string }>('SELECT action, details::text AS details FROM audit_events')).rows)
    expect(rows.map(row => row.action)).toEqual(expect.arrayContaining(['users.invited', 'users.invitation_accepted', 'users.password_change_failed', 'users.password_changed', 'users.password_reset_issued', 'users.password_reset_completed', 'auth.link_rejected']))
    for (const row of rows) {
      for (const secret of secrets)
        expect(row.details, row.action).not.toContain(secret)
    }
  })
})
