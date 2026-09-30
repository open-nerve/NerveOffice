// 审计查询（M2-P1 设计 §3.7，US-M2-13）：条件（时间、操作者、动作、对象）、倒序翻页、补上账户与邀请的名字、只给系统管理员。
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { randomUUID } from 'node:crypto'
import { TrashPurgeJob } from '@nerve-office/api'
import { auditEventListResponseSchema, errorResponseSchema, issuedInvitationSchema, issuedPasswordResetSchema, trashListResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { postPublic, tokenOf } from '../support/links.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

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

  it('按操作者过滤：同一个动作有两位操作者时，只给出这一位的（M2-P6 复核 S-3）', async () => {
    const other = await createAccount(database, { username: 'other-admin', displayName: '另一位管理员', systemRole: 'admin' })
    const otherSession = await login(app.baseUrl, 'other-admin', other.password)
    const victim = await createAccount(database, { username: 'dan', displayName: '丹' })
    expect((await asUser(app.baseUrl, otherSession, `/api/admin/users/${victim.id}/disable`, { method: 'POST' })).status).toBe(200)
    // 不按操作者时两条都在：条件真的起了作用，而不是库里本来就只有一条
    expect((await search('?action=users.disabled')).items.map(item => item.target?.id).sort()).toEqual([target.id, victim.id].sort())
    expect((await search(`?actorId=${admin.id}&action=users.disabled`)).items.map(item => item.target?.id)).toEqual([target.id])
    expect((await search(`?actorId=${other.id}&action=users.disabled`)).items.map(item => item.target?.id)).toEqual([victim.id])
  })

  it('时间范围：含起点、不含终点（M2-P6 复核 S-3）', async () => {
    // 直接写三条时间确定的事件（审计表只拒绝更新与删除），对象是同一个，按对象圈定这三条
    const subject = '0199a2c4-3b4c-7d5e-8f60-718293a4b5c6'
    await database.query(async client => client.query(
      `INSERT INTO audit_events (occurred_at, action, actor_type, source, target_type, target_id)
       SELECT t, 'users.enabled', 'system', 'cli', 'user', $1 FROM unnest($2::timestamptz[]) AS t`,
      [subject, ['2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', '2026-01-01T02:00:00Z']],
    ))
    const times = async (query: string) => (await search(`?targetId=${subject}${query}`)).items.map(item => item.occurredAt)
    expect(await times('')).toEqual(['2026-01-01T02:00:00.000Z', '2026-01-01T01:00:00.000Z', '2026-01-01T00:00:00.000Z'])
    // 终点不含：正好在终点的那一条不在里面
    expect(await times(`&to=${encodeURIComponent('2026-01-01T01:00:00Z')}`)).toEqual(['2026-01-01T00:00:00.000Z'])
    expect(await times(`&to=${encodeURIComponent('2026-01-01T01:00:00.001Z')}`)).toEqual(['2026-01-01T01:00:00.000Z', '2026-01-01T00:00:00.000Z'])
    // 起点含：正好在起点的那一条在里面
    expect(await times(`&from=${encodeURIComponent('2026-01-01T01:00:00Z')}`)).toEqual(['2026-01-01T02:00:00.000Z', '2026-01-01T01:00:00.000Z'])
    expect(await times(`&from=${encodeURIComponent('2026-01-01T00:30:00Z')}&to=${encodeURIComponent('2026-01-01T01:30:00Z')}`)).toEqual(['2026-01-01T01:00:00.000Z'])
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

describe('US-M2-13 审计与日志里没有令牌与密码（审查 A5，M2-P6 复核 S-6）', () => {
  it('邀请（含重发）、接受、修改密码（含一次失败）、签发（含再签发）与完成重置、登录走一遍之后，整张审计表与服务端日志里都没有令牌与密码', async () => {
    const secrets: string[] = []
    const first = parseExact(issuedInvitationSchema, await (await asUser(app.baseUrl, adminSession, '/api/admin/invitations', { method: 'POST', body: { username: 'dora', displayName: '朵拉' } })).json())
    // 重发：旧的作废，给出新的链接。两条链接的令牌都不能出现
    const reissued = parseExact(issuedInvitationSchema, await (await asUser(app.baseUrl, adminSession, `/api/admin/invitations/${first.invitation.id}/reissue`, { method: 'POST' })).json())
    const invitationToken = tokenOf(reissued.url)
    const firstPassword = 'dora first password'
    secrets.push(tokenOf(first.url), invitationToken, firstPassword)
    expect((await postPublic(app.baseUrl, '/api/auth/invitations/inspect', { token: invitationToken })).status).toBe(200)
    expect((await postPublic(app.baseUrl, '/api/auth/invitations/accept', { token: invitationToken, displayName: '朵拉', password: firstPassword })).status).toBe(200)

    const dora = await login(app.baseUrl, 'dora', firstPassword)
    const secondPassword = 'dora second password'
    const wrongGuess = 'dora wrong guess'
    secrets.push(secondPassword, wrongGuess)
    expect((await asUser(app.baseUrl, dora, '/api/auth/password', { method: 'PUT', body: { currentPassword: wrongGuess, newPassword: secondPassword } })).status).toBe(403)
    expect((await asUser(app.baseUrl, dora, '/api/auth/password', { method: 'PUT', body: { currentPassword: firstPassword, newPassword: secondPassword } })).status).toBe(200)

    // 签发两次：第二次作废第一次（记作废的审计），两条链接的令牌都不能出现
    const resetFirst = parseExact(issuedPasswordResetSchema, await (await asUser(app.baseUrl, adminSession, `/api/admin/users/${dora.session.user.id}/password-reset`, { method: 'POST' })).json())
    const reset = parseExact(issuedPasswordResetSchema, await (await asUser(app.baseUrl, adminSession, `/api/admin/users/${dora.session.user.id}/password-reset`, { method: 'POST' })).json())
    const resetToken = tokenOf(reset.url)
    const thirdPassword = 'dora third password'
    secrets.push(tokenOf(resetFirst.url), resetToken, thirdPassword)
    expect((await postPublic(app.baseUrl, '/api/auth/password-resets/inspect', { token: resetToken })).status).toBe(200)
    expect((await postPublic(app.baseUrl, '/api/auth/password-resets/complete', { token: resetToken, password: thirdPassword })).status).toBe(200)
    expect((await postPublic(app.baseUrl, '/api/auth/password-resets/complete', { token: resetToken, password: thirdPassword })).status).toBe(410)
    await login(app.baseUrl, 'dora', thirdPassword)

    const rows = await database.query(async client => (await client.query<{ action: string, row: string }>('SELECT action, row_to_json(e)::text AS row FROM audit_events e')).rows)
    expect(rows.map(row => row.action)).toEqual(expect.arrayContaining(['users.invited', 'users.invitation_revoked', 'users.invitation_accepted', 'users.password_change_failed', 'users.password_changed', 'users.password_reset_issued', 'users.password_reset_revoked', 'users.password_reset_completed', 'auth.link_rejected']))
    for (const row of rows) {
      for (const secret of secrets)
        expect(row.row, row.action).not.toContain(secret)
    }
    // 服务端日志：签发、重发、接受、完成的请求都记过日志，令牌与密码一处都没有（链接只在签发的响应里出现一次）
    const logs = app.logs.text()
    expect(logs).toContain('/api/admin/invitations')
    for (const secret of secrets)
      expect(logs).not.toContain(secret)
  })
})

describe('US-M2-13 审计里没有文档标题与文件夹名称（M2 总设计 §2.1 第 5 条，M2-P6 复核 M-1）', () => {
  it('新建、改名、移动（空间内与跨空间）、复制、删除、恢复、永久删除、到期自动清理走一遍之后，整张审计表里没有这些标题与名称', async () => {
    // 特征明显的标题与名称：每个都带一段独有的 ASCII 记号，审计表里出现任何一个记号都说明记进去了（中文在 JSON 文本里原样保存，
    // 记号是 ASCII，怎么转义都认得出）
    const titles = { created: '周报 TTL-CREATED-Q7', renamed: '月报 TTL-RENAMED-Q7', copied: '副本 TTL-COPIED-Q7', expiring: '旧表 TTL-EXPIRING-Q7', inFolder: '夹里 TTL-INFOLDER-Q7' }
    const names = { created: '资料 FLD-CREATED-Q7', renamed: '档案 FLD-RENAMED-Q7', child: '子目录 FLD-CHILD-Q7', expiring: '旧目录 FLD-EXPIRING-Q7' }
    const markers = [...Object.values(titles), ...Object.values(names)].map(text => text.split(' ')[1] ?? text)
    const eva = await createAccount(database, { username: 'eva', displayName: '伊娃' })
    const session = await login(app.baseUrl, 'eva', eva.password)
    const team = await createTeamSpace(database, { name: '审计隐私的团队空间', createdBy: admin.id, members: { [eva.id]: 'admin' } })
    const personal = eva.personalSpaceId
    const call = async (path: string, method: string, body?: unknown): Promise<Response> => {
      const response = await asUser(app.baseUrl, session, path, { method, body })
      expect(response.status, `${method} ${path}：${await response.clone().text()}`).toBeLessThan(300)
      return response
    }
    const idOf = async (response: Response): Promise<string> => z.object({ id: z.uuid() }).parse(await response.json()).id
    const lastEntry = async (spaceId: string): Promise<string> => {
      const entry = parseExact(trashListResponseSchema, await (await call(`/api/trash?spaceId=${spaceId}`, 'GET')).json()).items[0]
      if (entry === undefined)
        throw new Error('回收站里没有东西')
      return entry.id
    }

    // 新建文档与文件夹，改名，空间内移动
    const document = await idOf(await call('/api/documents', 'POST', { type: 'sheet', title: titles.created, requestId: randomUUID(), spaceId: personal }))
    const folder = await idOf(await call('/api/folders', 'POST', { spaceId: personal, name: names.created, requestId: randomUUID() }))
    await call(`/api/documents/${document}`, 'PATCH', { title: titles.renamed })
    await call(`/api/folders/${folder}`, 'PATCH', { name: names.renamed })
    await call(`/api/documents/${document}`, 'PATCH', { folderId: folder })
    const child = await idOf(await call('/api/folders', 'POST', { spaceId: personal, name: names.child, requestId: randomUUID() }))
    await call(`/api/folders/${child}`, 'PATCH', { parentId: folder })
    // 复制到团队空间、再跨空间移回来；文件夹跨空间移到团队空间
    const copy = await idOf(await call(`/api/documents/${document}/copy`, 'POST', { spaceId: team, title: titles.copied, requestId: randomUUID() }))
    await call(`/api/documents/${copy}/move`, 'POST', { spaceId: personal })
    await call(`/api/folders/${child}/move`, 'POST', { spaceId: team })
    // 删除与恢复一份文档；删除一个文件夹（连同里面的文档）再永久删除
    await call(`/api/documents/${copy}`, 'DELETE')
    await call(`/api/trash/${await lastEntry(personal)}/restore`, 'POST')
    await call(`/api/folders/${folder}`, 'DELETE')
    await call(`/api/trash/${await lastEntry(personal)}`, 'DELETE')
    // 到期自动清理：团队空间里删掉一份文档与一个带文档的文件夹，把时间推到 30 天之后跑一轮
    const expiring = await idOf(await call('/api/documents', 'POST', { type: 'sheet', title: titles.expiring, requestId: randomUUID(), spaceId: team }))
    const expiringFolder = await idOf(await call('/api/folders', 'POST', { spaceId: team, name: names.expiring, requestId: randomUUID() }))
    await call('/api/documents', 'POST', { type: 'sheet', title: titles.inFolder, requestId: randomUUID(), spaceId: team, folderId: expiringFolder })
    await call(`/api/documents/${expiring}`, 'DELETE')
    await call(`/api/folders/${expiringFolder}`, 'DELETE')
    const round = await app.runtime.get(TrashPurgeJob).runOnce(new Date(Date.now() + 31 * 24 * 3_600_000))
    expect(round).toMatchObject({ ran: true, failed: 0 })
    expect(round.purged).toBeGreaterThanOrEqual(2)

    const rows = await database.query(async client => (await client.query<{ action: string, actor_type: string, row: string }>('SELECT action, actor_type, row_to_json(e)::text AS row FROM audit_events e')).rows)
    // 这些动作都真的记过（到期清理的那两条操作者是系统）
    expect(rows.map(row => row.action)).toEqual(expect.arrayContaining([
      'documents.created',
      'folders.created',
      'documents.renamed',
      'folders.renamed',
      'documents.moved',
      'folders.moved',
      'documents.copied',
      'documents.deleted',
      'documents.restored',
      'folders.deleted',
      'folders.purged',
    ]))
    expect(rows.filter(row => row.actor_type === 'system').map(row => row.action)).toEqual(expect.arrayContaining(['documents.purged', 'folders.purged']))
    for (const row of rows) {
      for (const marker of markers)
        expect(row.row, row.action).not.toContain(marker)
    }
  })
})
