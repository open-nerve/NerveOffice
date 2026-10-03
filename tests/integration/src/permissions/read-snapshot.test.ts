// 读请求的权限判断与读到的数据在同一个快照里（M2 Codex 评审 CX1，A03、US-M2-06/10/12/14）：在途的读请求可以按撤权之前那一刻回答，
// 或者被拒绝，不能带出撤权之后才写进去的数据。原来权限判断与读数据是连接池上各自自动提交的语句，READ COMMITTED 下
// 每条语句看到的是它执行那一刻的数据：判断完权限、读数据之前撤权并写入的新数据，会被这个在途的请求带出去（Codex 的三个探针）。
// 现在每个登录之后的读请求在一个只读快照（REPEATABLE READ READ ONLY）里判断权限、读数据，快照开头的语句是开场核对：
// 会话守卫判断过的会话有效（M2 Codex 评审复验的建议 3）、账户有效、系统角色在快照里再查一次。
// 做法（确定的交错，与 Codex 的探针相同）：在应用里包装一个方法加闸门，被测的请求走到那里停住，期间经真实的接口撤权、写入新数据，
// 并用一个新请求自证撤权已经生效；放行之后闸门调用原来的实现。两类停点：
// - 已经判断完权限、读数据之前（快照里）：读正文停在 DocumentContentsRepository.findCurrent，搜索停在 DocumentsRepository.searchByTitle；
// - 处理器开始之前（守卫之后、快照之前）：停在 TransactionRunner.readSnapshot，期间撤销这条会话（签发重置、退出）、停用账户、取消系统管理员。
// 只用真实的 HTTP 与 PostgreSQL，不 mock 数据库
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { TransactionRunner } from '@nerve-office/api'
import { DocumentContentsRepository, DocumentsRepository } from '@nerve-office/api/testing'
import { errorResponseSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
let root: TestAccount
let owner: TestAccount
let rootSession: LoggedIn
let ownerSession: LoggedIn
let people = 0
let spaces = 0

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'snapshot-root', systemRole: 'admin' })
  owner = await createAccount(database, { username: 'snapshot-owner' })
  rootSession = await login(app.baseUrl, root.username, root.password)
  ownerSession = await login(app.baseUrl, owner.username, owner.password)
})

afterAll(async () => {
  vi.restoreAllMocks()
  await app.close()
  await database.drop()
})

/** 每条用例一个新的人（停用、取消系统管理员的用例会改他，互不影响） */
async function newPerson(systemRole: 'admin' | 'member' = 'member'): Promise<{ account: TestAccount, session: LoggedIn }> {
  people += 1
  const account = await createAccount(database, { username: `snapshot-person-${people}`, systemRole })
  return { account, session: await login(app.baseUrl, account.username, account.password) }
}

/** 团队空间：owner 是空间管理员，viewer 是查看者 */
async function teamWith(viewer: TestAccount): Promise<string> {
  spaces += 1
  return createTeamSpace(database, { name: `快照：团队 ${spaces}`, createdBy: root.id, members: { [owner.id]: 'admin', [viewer.id]: 'viewer' } })
}

/** 闸门：走到这里时 arrived 兑现，等 release 之后才往下走 */
function gate() {
  let reach: () => void = () => {}
  let release: () => void = () => {}
  const arrived = new Promise<void>((resolve) => {
    reach = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { arrived, reach: () => reach(), wait, release: () => release() }
}

/**
 * 被测的读请求走到 method 时停住（第一次调用；matches 核对停住的确实是它），这期间执行 change（撤权、写入新数据），
 * 放行之后闸门调用原来的实现，返回这个请求的响应。被测的请求没走到停点就结束了，立即失败并报出它的结果（不空等到超时）；
 * 不论成败都放行、还原
 */
async function whilePaused<T extends object, K extends keyof T & string>(
  target: T,
  method: K,
  matches: (...args: unknown[]) => boolean,
  request: () => Promise<Response>,
  change: () => Promise<void>,
): Promise<Response> {
  const original = (target[method] as (...args: unknown[]) => Promise<unknown>).bind(target)
  const barrier = gate()
  const spy = vi.spyOn(target, method as never).mockImplementationOnce((async (...args: unknown[]) => {
    expect(matches(...args), `停住的不是被测的请求：${method}`).toBe(true)
    barrier.reach()
    await barrier.wait
    return original(...args)
  }) as never)
  const pending = request()
  const ended = pending.then(response => `HTTP ${response.status}`, (error: unknown) => `失败：${String(error)}`)
  try {
    const reached = await Promise.race([barrier.arrived.then(() => true), ended.then(() => false)])
    if (!reached)
      throw new Error(`被测的请求没有走到 ${method} 就结束了（${await ended}）`)
    await change()
  }
  finally {
    barrier.release()
    spy.mockRestore()
  }
  return pending
}

async function read(session: LoggedIn, documentId: string): Promise<Response> {
  return asUser(app.baseUrl, session, `/api/documents/${documentId}/content`)
}

/** 保存一份只有一格写着 marker 的内容（撤权之后才写进去的新数据） */
async function saveMarker(documentId: string, unitId: string, marker: string): Promise<Response> {
  const sheet = SHEET_TEMPLATE.sheets['sheet-1']
  const raw = Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: unitId, sheets: { 'sheet-1': { ...sheet, cellData: { 0: { 0: { v: marker } } } } } }), 'utf8')
  const query = new URLSearchParams({ baseRevision: '1', requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: '1' })
  return asUser(app.baseUrl, ownerSession, `/api/documents/${documentId}/content?${query.toString()}`, { method: 'PUT', binary: { contentType: 'application/gzip', bytes: zlib.gzipSync(raw) } })
}

/** 在途的读正文：按撤权之前那一刻回答（修订号 1、没有新内容），或者被拒绝（404），不能带出撤权之后才保存的 marker */
async function expectNoLaterContent(response: Response, marker: string): Promise<void> {
  const body = await response.text()
  expect(body.includes(marker), '响应里有撤权之后才保存的内容').toBe(false)
  expect([200, 404]).toContain(response.status)
  if (response.status === 200)
    expect(response.headers.get('etag')).toBe('"1"')
}

describe('判断完权限、读数据之前撤权：在途的读请求不带出撤权之后的数据（M2 Codex 评审 CX1）', () => {
  it('读正文时被取消单独授权，所有者随即保存：拿到的是取消之前那一刻的内容（修订号 1），或者被拒绝', async () => {
    const { account: viewer, session } = await newPerson()
    const document = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '快照：单独授权' })
    expect((await asUser(app.baseUrl, ownerSession, `/api/documents/${document.id}/grants/${viewer.id}`, { method: 'PUT', body: { role: 'viewer' } })).status).toBe(200)
    expect((await read(session, document.id)).status).toBe(200)
    const marker = `revoked-grant-${randomUUID()}`
    const response = await whilePaused(app.runtime.get(DocumentContentsRepository), 'findCurrent', id => id === document.id, async () => read(session, document.id), async () => {
      expect((await asUser(app.baseUrl, ownerSession, `/api/documents/${document.id}/grants/${viewer.id}`, { method: 'DELETE' })).status).toBe(204)
      // 撤权已经生效：新请求看不到
      expect((await read(session, document.id)).status).toBe(404)
      expect((await saveMarker(document.id, document.unitId, marker)).status).toBe(200)
    })
    await expectNoLaterContent(response, marker)
  })

  it('读正文时被移出团队空间，所有者随即保存：拿到的是移出之前那一刻的内容（修订号 1），或者被拒绝', async () => {
    const { account: viewer, session } = await newPerson()
    const spaceId = await teamWith(viewer)
    const document = await seedDocument(database, { spaceId, createdBy: owner.id, title: '快照：成员' })
    expect((await read(session, document.id)).status).toBe(200)
    const marker = `removed-member-${randomUUID()}`
    const response = await whilePaused(app.runtime.get(DocumentContentsRepository), 'findCurrent', id => id === document.id, async () => read(session, document.id), async () => {
      expect((await asUser(app.baseUrl, ownerSession, `/api/spaces/${spaceId}/members/${viewer.id}`, { method: 'DELETE' })).status).toBe(204)
      expect((await read(session, document.id)).status).toBe(404)
      expect((await saveMarker(document.id, document.unitId, marker)).status).toBe(200)
    })
    await expectNoLaterContent(response, marker)
  })

  it('搜索时被移出团队空间，随即在那个空间里新建文档：结果里没有移出之后才建的文档', async () => {
    const { account: viewer, session } = await newPerson()
    const spaceId = await teamWith(viewer)
    const keyword = `snapshot-secret-${randomUUID().slice(0, 8)}`
    const before = await seedDocument(database, { spaceId, createdBy: owner.id, title: `${keyword} 移出之前就有的` })
    let created = ''
    const response = await whilePaused(
      app.runtime.get(DocumentsRepository),
      'searchByTitle',
      scope => (scope as { readonly spaceIds: readonly string[] }).spaceIds.includes(spaceId),
      async () => asUser(app.baseUrl, session, `/api/search?query=${encodeURIComponent(keyword)}`),
      async () => {
        expect((await asUser(app.baseUrl, ownerSession, `/api/spaces/${spaceId}/members/${viewer.id}`, { method: 'DELETE' })).status).toBe(204)
        const document = await asUser(app.baseUrl, ownerSession, '/api/documents', { method: 'POST', body: { type: 'sheet', title: `${keyword} 移出之后才建的`, spaceId, requestId: randomUUID() } })
        expect(document.status).toBe(201)
        created = ((await document.json()) as { id: string }).id
        expect((await asUser(app.baseUrl, session, `/api/documents/${created}`)).status).toBe(404)
      },
    )
    const body = await response.text()
    expect(body.includes(created), '搜索结果里有移出之后才建的文档').toBe(false)
    // 按移出之前那一刻回答：那时就有的那一份照样在（也可以被拒绝，但不能多出新的）
    if (response.status === 200)
      expect((JSON.parse(body) as { items: { id: string }[] }).items.map(item => item.id)).toEqual([before.id])
    else
      expect(response.status).toBe(404)
  })
})

describe('守卫之后、快照之前撤权：开场核对在快照里再查一次，放行之后不返回变化之后的数据（M2 Codex 评审 CX1）', () => {
  /** 处理器开始之前停住：停在 TransactionRunner.readSnapshot（守卫已经放行，快照还没开） */
  async function pausedBeforeSnapshot(request: () => Promise<Response>, change: () => Promise<void>): Promise<Response> {
    return whilePaused(app.runtime.get(TransactionRunner), 'readSnapshot', () => true, request, change)
  }

  async function errorCodeOf(response: Response): Promise<{ status: number, code: string | undefined, body: string }> {
    const body = await response.text()
    const parsed = errorResponseSchema.safeParse(body === '' ? undefined : JSON.parse(body))
    return { status: response.status, code: parsed.success ? parsed.data.error.code : undefined, body }
  }

  it('读正文时账户被停用，所有者随即保存（授权还在）：登录已过期（401 SESSION_EXPIRED），不返回停用之后保存的内容', async () => {
    const { account: viewer, session } = await newPerson()
    const document = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '快照：停用' })
    expect((await asUser(app.baseUrl, ownerSession, `/api/documents/${document.id}/grants/${viewer.id}`, { method: 'PUT', body: { role: 'viewer' } })).status).toBe(200)
    const marker = `disabled-${randomUUID()}`
    const response = await pausedBeforeSnapshot(async () => read(session, document.id), async () => {
      expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${viewer.id}/disable`, { method: 'POST' })).status).toBe(200)
      // 停用已经生效：新请求被守卫拒绝
      expect((await read(session, document.id)).status).toBe(401)
      expect((await saveMarker(document.id, document.unitId, marker)).status).toBe(200)
    })
    const outcome = await errorCodeOf(response)
    expect(outcome.body.includes(marker), '响应里有停用之后才保存的内容').toBe(false)
    expect([outcome.status, outcome.code]).toEqual([401, 'SESSION_EXPIRED'])
  })

  /** 账户的状态（直接查库）：撤销会话的用例据此自证账户仍然有效，拒绝只能来自会话的核对 */
  async function statusOf(userId: string): Promise<string | undefined> {
    return database.query(async client => (await client.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [userId])).rows[0]?.status)
  }

  it('读正文时这条会话被撤销（管理员签发重置，撤销这个人的全部会话，账户仍然有效、授权还在），所有者随即保存：登录已过期（401 SESSION_EXPIRED），不返回撤销之后保存的内容（M2 Codex 评审复验的建议 3）', async () => {
    const { account: viewer, session } = await newPerson()
    const document = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '快照：签发重置' })
    expect((await asUser(app.baseUrl, ownerSession, `/api/documents/${document.id}/grants/${viewer.id}`, { method: 'PUT', body: { role: 'viewer' } })).status).toBe(200)
    const marker = `reset-${randomUUID()}`
    const response = await pausedBeforeSnapshot(async () => read(session, document.id), async () => {
      expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${viewer.id}/password-reset`, { method: 'POST' })).status).toBe(201)
      // 撤销已经生效：新请求被守卫拒绝；账户仍然有效（不是停用）
      expect((await read(session, document.id)).status).toBe(401)
      expect(await statusOf(viewer.id)).toBe('active')
      expect((await saveMarker(document.id, document.unitId, marker)).status).toBe(200)
    })
    const outcome = await errorCodeOf(response)
    expect(outcome.body.includes(marker), '响应里有撤销之后才保存的内容').toBe(false)
    expect([outcome.status, outcome.code]).toEqual([401, 'SESSION_EXPIRED'])
  })

  it('读正文时本人退出了这条会话（同一个 Cookie），所有者随即保存：401 SESSION_EXPIRED，不返回退出之后保存的内容', async () => {
    const { account: viewer, session } = await newPerson()
    const document = await seedDocument(database, { spaceId: owner.personalSpaceId, createdBy: owner.id, title: '快照：退出' })
    expect((await asUser(app.baseUrl, ownerSession, `/api/documents/${document.id}/grants/${viewer.id}`, { method: 'PUT', body: { role: 'viewer' } })).status).toBe(200)
    const marker = `logout-${randomUUID()}`
    const response = await pausedBeforeSnapshot(async () => read(session, document.id), async () => {
      expect((await asUser(app.baseUrl, session, '/api/auth/logout', { method: 'POST' })).status).toBe(204)
      expect((await read(session, document.id)).status).toBe(401)
      expect(await statusOf(viewer.id)).toBe('active')
      expect((await saveMarker(document.id, document.unitId, marker)).status).toBe(200)
    })
    const outcome = await errorCodeOf(response)
    expect(outcome.body.includes(marker), '响应里有退出之后才保存的内容').toBe(false)
    expect([outcome.status, outcome.code]).toEqual([401, 'SESSION_EXPIRED'])
  })

  it('管理界面读账户时被取消系统管理员：没有权限（403 PERMISSION_DENIED），不返回取消之后的数据', async () => {
    const { account: admin, session } = await newPerson('admin')
    const response = await pausedBeforeSnapshot(async () => asUser(app.baseUrl, session, `/api/admin/users/${admin.id}`), async () => {
      expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${admin.id}/system-role`, { method: 'PUT', body: { systemRole: 'member' } })).status).toBe(200)
      // 取消已经生效：新请求被守卫拒绝
      expect((await asUser(app.baseUrl, session, `/api/admin/users/${admin.id}`)).status).toBe(403)
    })
    const outcome = await errorCodeOf(response)
    // 取消之后的数据：这个人的系统角色已经是 member
    expect(outcome.body.includes('"systemRole":"member"'), '响应里有取消之后的数据').toBe(false)
    expect([outcome.status, outcome.code]).toEqual([403, 'PERMISSION_DENIED'])
  })

  it('不只给系统管理员的接口同样要看系统角色：没有加入的系统管理员看团队空间的成员时被取消系统管理员，403，不返回成员列表', async () => {
    const { account: admin, session } = await newPerson('admin')
    const { account: member } = await newPerson()
    const spaceId = await teamWith(member)
    expect((await asUser(app.baseUrl, session, `/api/spaces/${spaceId}/members`)).status).toBe(200)
    const response = await pausedBeforeSnapshot(async () => asUser(app.baseUrl, session, `/api/spaces/${spaceId}/members`), async () => {
      expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${admin.id}/system-role`, { method: 'PUT', body: { systemRole: 'member' } })).status).toBe(200)
      // 取消已经生效：他不是成员，新请求看不到这个空间
      expect((await asUser(app.baseUrl, session, `/api/spaces/${spaceId}/members`)).status).toBe(404)
    })
    const outcome = await errorCodeOf(response)
    expect(outcome.body.includes(member.id), '响应里有成员列表').toBe(false)
    expect([outcome.status, outcome.code]).toEqual([403, 'PERMISSION_DENIED'])
  })
})
