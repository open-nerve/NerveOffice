// 收回写入权接上编辑租约（M3-P1 设计 §3.4.6；A06 的租约与保存部分，US-M3-12）：五种范围逐个经真实的接口——
// 停用（user）、移出空间与降为查看者（membership）、归档（space）、删除、跨空间移动与转移（documents）、取消与降低单独授权（userDocuments）。
// 每种核对：失去编辑权的持有者的租约记 revoked、文档的代次加一；他之后的心跳与保存先被访问与编辑权拒绝（401、403、404）；
// 别人（还能编辑的）能申请，收回是明确结束，没有异常中断的提醒。变化之后仍能编辑的持有者租约不动，被移到别的空间时按 stale 失效、续上。
// 进行中的保存、申请与撤权的确定交错，以及锁的顺序，在 lease-revocation-locks.test.ts。
import type { SpaceRole } from '@nerve-office/contracts'
import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { SeededDocument } from '../support/documents.ts'
import type { HeldLease, LeaseState } from '../support/edit-leases.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { acquiredEditLeaseSchema, createdFolderSchema, SHEET_TEMPLATE, trashListResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { acquireBody } from '../support/client-format.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, leaseStateOf, outcomeOf, renewLease, saveContent } from '../support/edit-leases.ts'
import { setGrant } from '../support/grants.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
/** 系统管理员（停用、归档、转移）；每个团队空间的空间管理员（移出、降级、删除、移动、分享）；每个团队空间里的另一位编辑者 */
let root: TestAccount
let amy: TestAccount
let cat: TestAccount
let rootSession: LoggedIn
let amySession: LoggedIn
let catSession: LoggedIn
let people = 0
let spaces = 0

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await createAccount(database, { username: 'revocation-root', systemRole: 'admin' })
  amy = await createAccount(database, { username: 'revocation-amy' })
  cat = await createAccount(database, { username: 'revocation-cat' })
  rootSession = await login(app.baseUrl, root.username, root.password)
  amySession = await login(app.baseUrl, amy.username, amy.password)
  catSession = await login(app.baseUrl, cat.username, cat.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

interface Person {
  readonly account: TestAccount
  readonly session: LoggedIn
}

/** 一个新的人：会被停用、移出、降级的持有者各用各的，不影响别的用例 */
async function person(): Promise<Person> {
  people += 1
  const account = await createAccount(database, { username: `revocation-${people}` })
  return { account, session: await login(app.baseUrl, account.username, account.password) }
}

/** 新的团队空间：艾米是空间管理员，卡特是编辑者，另加 members */
async function teamSpace(members: Readonly<Record<string, SpaceRole>> = {}): Promise<string> {
  spaces += 1
  return createTeamSpace(database, { name: `收回写入权 ${spaces}`, createdBy: root.id, members: { [amy.id]: 'admin', [cat.id]: 'editor', ...members } })
}

async function documentIn(spaceId: string, folderId?: string): Promise<SeededDocument> {
  return seedDocument(database, { spaceId, createdBy: amy.id, title: `收回写入权的文档 ${randomUUID().slice(0, 8)}`, folderId })
}

async function folderIn(spaceId: string): Promise<string> {
  const response = await asUser(app.baseUrl, amySession, '/api/folders', { method: 'POST', body: { spaceId, name: `文件夹 ${randomUUID().slice(0, 8)}`, requestId: randomUUID() } })
  expect(response.status, await response.clone().text()).toBe(201)
  return parseExact(createdFolderSchema, await response.json()).id
}

async function save(user: LoggedIn, document: SeededDocument, lease: HeldLease, baseRevision = 1): Promise<Response> {
  const raw = Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: document.unitId }), 'utf8')
  return saveContent(app.baseUrl, user, document.id, zlib.gzipSync(raw), { baseRevision, lease })
}

/** 持有者之后的心跳与保存各自的结局（同一个页面：同一份租约） */
async function holderOutcomes(user: LoggedIn, document: SeededDocument, lease: HeldLease): Promise<[string, string]> {
  return [await outcomeOf(await renewLease(app.baseUrl, user, document.id, lease)), await outcomeOf(await save(user, document, lease))]
}

/** 别人申请：状态码，成功时连同异常中断的提醒里是谁（没有提醒为 null） */
async function acquisitionBy(user: LoggedIn, documentId: string): Promise<{ readonly status: number, readonly interruption?: string | null }> {
  const response = await asUser(app.baseUrl, user, `/api/documents/${documentId}/edit-lease`, { method: 'POST', body: acquireBody(randomUUID()) })
  if (response.status !== 201) {
    await response.arrayBuffer()
    return { status: response.status }
  }
  return { status: 201, interruption: parseExact(acquiredEditLeaseSchema, await response.json()).interruption?.holder.id ?? null }
}

/** 收回之后的租约行：这一代记 revoked，文档的代次在它之上加了 added（收回加一；删除、移动、转移本身另加一） */
function revoked(holder: TestAccount, lease: HeldLease, added = 1): LeaseState {
  return { holderId: holder.id, endReason: 'revoked', leaseEpoch: lease.writeEpoch, documentEpoch: lease.writeEpoch + added }
}

/** 没被结束的租约行：文档的代次在它之上加了 added（0 是什么也没变；移动、转移之后是 1，这一代按 stale 失效） */
function untouched(holder: TestAccount, lease: HeldLease, added = 0): LeaseState {
  return { holderId: holder.id, endReason: null, leaseEpoch: lease.writeEpoch, documentEpoch: lease.writeEpoch + added }
}

const NO_NOTICE = { status: 201, interruption: null }

describe('US-M3-12 收回写入权的五种范围：失去编辑权的持有者的租约在同一个事务里结束、代次加一（P1 设计 §3.4.6）', () => {
  it('US-M3-12 停用账户（user）：他持有的租约都记 revoked、代次加一；他之后的请求是登录已失效（401）；别人能申请，没有提醒；别人的租约不动', async () => {
    const holder = await person()
    const space = await teamSpace({ [holder.account.id]: 'editor' })
    const elsewhere = await teamSpace({ [holder.account.id]: 'editor' })
    const first = await documentIn(space)
    const second = await documentIn(elsewhere)
    const others = await documentIn(space)
    const firstLease = await acquireLease(app.baseUrl, holder.session, first.id)
    const secondLease = await acquireLease(app.baseUrl, holder.session, second.id)
    const catLease = await acquireLease(app.baseUrl, catSession, others.id)

    expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${holder.account.id}/disable`, { method: 'POST' })).status).toBe(200)
    expect(await leaseStateOf(database, first.id)).toEqual(revoked(holder.account, firstLease))
    expect(await leaseStateOf(database, second.id)).toEqual(revoked(holder.account, secondLease))
    expect(await leaseStateOf(database, others.id)).toEqual(untouched(cat, catLease))
    expect(await holderOutcomes(holder.session, first, firstLease)).toEqual(['401 SESSION_EXPIRED', '401 SESSION_EXPIRED'])
    expect(await acquisitionBy(catSession, first.id)).toEqual(NO_NOTICE)
  })

  it('US-M3-12 移出空间（membership）：他在这个空间里的租约记 revoked、代次加一，之后心跳与保存 404，别人能申请；他在别的空间里的、这个空间里别人的租约不动', async () => {
    const holder = await person()
    const space = await teamSpace({ [holder.account.id]: 'editor' })
    const elsewhere = await teamSpace({ [holder.account.id]: 'editor' })
    const first = await documentIn(space)
    const second = await documentIn(elsewhere)
    const others = await documentIn(space)
    const firstLease = await acquireLease(app.baseUrl, holder.session, first.id)
    const secondLease = await acquireLease(app.baseUrl, holder.session, second.id)
    const catLease = await acquireLease(app.baseUrl, catSession, others.id)

    expect((await asUser(app.baseUrl, amySession, `/api/spaces/${space}/members/${holder.account.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await leaseStateOf(database, first.id)).toEqual(revoked(holder.account, firstLease))
    expect(await leaseStateOf(database, second.id)).toEqual(untouched(holder.account, secondLease))
    expect(await leaseStateOf(database, others.id)).toEqual(untouched(cat, catLease))
    expect(await holderOutcomes(holder.session, first, firstLease)).toEqual(['404 NOT_FOUND', '404 NOT_FOUND'])
    expect(await outcomeOf(await renewLease(app.baseUrl, holder.session, second.id, secondLease))).toBe('200')
    expect(await acquisitionBy(catSession, first.id)).toEqual(NO_NOTICE)
  })

  it('US-M3-12 降为查看者（membership）：租约记 revoked、代次加一，之后心跳与保存 403，别人能申请；空间管理员降为编辑者仍能编辑，租约不动，照常心跳与保存', async () => {
    const holder = await person()
    const manager = await person()
    const space = await teamSpace({ [holder.account.id]: 'editor', [manager.account.id]: 'admin' })
    const first = await documentIn(space)
    const second = await documentIn(space)
    const lease = await acquireLease(app.baseUrl, holder.session, first.id)
    const managerLease = await acquireLease(app.baseUrl, manager.session, second.id)

    expect((await asUser(app.baseUrl, amySession, `/api/spaces/${space}/members/${holder.account.id}`, { method: 'PUT', body: { role: 'viewer' } })).status).toBe(200)
    expect((await asUser(app.baseUrl, amySession, `/api/spaces/${space}/members/${manager.account.id}`, { method: 'PUT', body: { role: 'editor' } })).status).toBe(200)
    expect(await leaseStateOf(database, first.id)).toEqual(revoked(holder.account, lease))
    expect(await holderOutcomes(holder.session, first, lease)).toEqual(['403 PERMISSION_DENIED', '403 PERMISSION_DENIED'])
    expect(await acquisitionBy(catSession, first.id)).toEqual(NO_NOTICE)
    // 降了级仍是编辑者：入口按变化之后的权限判断，不是"被调整了就结束"
    expect(await leaseStateOf(database, second.id)).toEqual(untouched(manager.account, managerLease))
    expect(await holderOutcomes(manager.session, second, managerLease)).toEqual(['200', '200'])
  })

  it('US-M3-12 归档（space）：这个空间里的租约都记 revoked（只凭授权编辑的人同样）、代次加一，持有者心跳与保存 403，谁也申请不了；别的空间里的不动；恢复之后能申请，没有提醒', async () => {
    const holder = await person()
    const grantee = await person()
    const space = await teamSpace({ [holder.account.id]: 'editor' })
    const elsewhere = await teamSpace({ [holder.account.id]: 'editor' })
    const first = await documentIn(space)
    const granted = await documentIn(space)
    const third = await documentIn(elsewhere)
    await setGrant(database, { documentId: granted.id, userId: grantee.account.id, role: 'editor', grantedBy: amy.id })
    const firstLease = await acquireLease(app.baseUrl, holder.session, first.id)
    const grantedLease = await acquireLease(app.baseUrl, grantee.session, granted.id)
    const thirdLease = await acquireLease(app.baseUrl, holder.session, third.id)

    expect((await asUser(app.baseUrl, rootSession, `/api/admin/spaces/${space}/archive`, { method: 'POST' })).status).toBe(200)
    expect(await leaseStateOf(database, first.id)).toEqual(revoked(holder.account, firstLease))
    expect(await leaseStateOf(database, granted.id)).toEqual(revoked(grantee.account, grantedLease))
    expect(await leaseStateOf(database, third.id)).toEqual(untouched(holder.account, thirdLease))
    expect(await holderOutcomes(holder.session, first, firstLease)).toEqual(['403 PERMISSION_DENIED', '403 PERMISSION_DENIED'])
    expect(await holderOutcomes(grantee.session, granted, grantedLease)).toEqual(['403 PERMISSION_DENIED', '403 PERMISSION_DENIED'])
    expect(await acquisitionBy(catSession, first.id)).toEqual({ status: 403 })

    expect((await asUser(app.baseUrl, rootSession, `/api/admin/spaces/${space}/restore`, { method: 'POST' })).status).toBe(200)
    expect(await acquisitionBy(catSession, first.id)).toEqual(NO_NOTICE)
  })

  it('US-M3-12 删除文档与文件夹（documents）：租约记 revoked，代次在删除加的一之上再加一，之后心跳与保存 404；从回收站恢复之后旧的租约仍然失效（revoked），重新申请才能接着编辑', async () => {
    const holder = await person()
    const space = await teamSpace({ [holder.account.id]: 'editor' })
    const folder = await folderIn(space)
    const document = await documentIn(space)
    const inFolder = await documentIn(space, folder)
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    const catLease = await acquireLease(app.baseUrl, catSession, inFolder.id)

    expect((await asUser(app.baseUrl, amySession, `/api/documents/${document.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await asUser(app.baseUrl, amySession, `/api/folders/${folder}`, { method: 'DELETE' })).status).toBe(204)
    expect(await leaseStateOf(database, document.id)).toEqual(revoked(holder.account, lease, 2))
    expect(await leaseStateOf(database, inFolder.id)).toEqual(revoked(cat, catLease, 2))
    expect(await holderOutcomes(holder.session, document, lease)).toEqual(['404 NOT_FOUND', '404 NOT_FOUND'])

    const trash = parseExact(trashListResponseSchema, await (await asUser(app.baseUrl, amySession, `/api/trash?spaceId=${space}`)).json())
    const entry = trash.items.find(item => item.kind === 'document')
    expect((await asUser(app.baseUrl, amySession, `/api/trash/${entry?.id ?? ''}/restore`, { method: 'POST' })).status).toBe(200)
    // 恢复不给代次加一，也不让结束了的租约回来：同一个页面拿旧的令牌，编辑权已失效（明确结束：revoked）
    expect(await leaseStateOf(database, document.id)).toEqual(revoked(holder.account, lease, 2))
    expect(await holderOutcomes(holder.session, document, lease)).toEqual(['409 EDIT_LEASE_LOST:revoked', '409 EDIT_LEASE_LOST:revoked'])
    const again = await acquireLease(app.baseUrl, holder.session, document.id, lease.clientInstanceId)
    expect(await outcomeOf(await save(holder.session, document, again))).toBe('200')
  })

  it('US-M3-12 跨空间移动文档（documents）：移到他仍能编辑的空间——租约不动，按代次过时（stale），同一个页面重新申请之后接着保存；移到他不能编辑的空间——租约记 revoked（移动与收回各加一），之后 404', async () => {
    const holder = await person()
    const source = await teamSpace({ [holder.account.id]: 'editor' })
    const editable = await teamSpace({ [holder.account.id]: 'editor' })
    const closed = await teamSpace()
    const staying = await documentIn(source)
    const leaving = await documentIn(source)
    const stayingLease = await acquireLease(app.baseUrl, holder.session, staying.id)
    const leavingLease = await acquireLease(app.baseUrl, holder.session, leaving.id)

    expect((await asUser(app.baseUrl, amySession, `/api/documents/${staying.id}/move`, { method: 'POST', body: { spaceId: editable } })).status).toBe(200)
    expect((await asUser(app.baseUrl, amySession, `/api/documents/${leaving.id}/move`, { method: 'POST', body: { spaceId: closed } })).status).toBe(200)
    expect(await leaseStateOf(database, staying.id)).toEqual(untouched(holder.account, stayingLease, 1))
    expect(await holderOutcomes(holder.session, staying, stayingLease)).toEqual(['409 EDIT_LEASE_LOST:stale', '409 EDIT_LEASE_LOST:stale'])
    const again = await acquireLease(app.baseUrl, holder.session, staying.id, stayingLease.clientInstanceId)
    expect(await outcomeOf(await save(holder.session, staying, again))).toBe('200')

    expect(await leaseStateOf(database, leaving.id)).toEqual(revoked(holder.account, leavingLease, 2))
    expect(await holderOutcomes(holder.session, leaving, leavingLease)).toEqual(['404 NOT_FOUND', '404 NOT_FOUND'])
  })

  it('US-M3-12 文件夹连同子树移到别的空间（documents，一批）：在那里不能编辑的持有者的租约记 revoked，仍能编辑的按 stale 失效；一次移动里两种都有', async () => {
    const holder = await person()
    const source = await teamSpace({ [holder.account.id]: 'editor' })
    // 目标空间里卡特是编辑者，本人不是成员
    const target = await teamSpace()
    const folder = await folderIn(source)
    const holders = await documentIn(source, folder)
    const cats = await documentIn(source, folder)
    const lease = await acquireLease(app.baseUrl, holder.session, holders.id)
    const catLease = await acquireLease(app.baseUrl, catSession, cats.id)

    expect((await asUser(app.baseUrl, amySession, `/api/folders/${folder}/move`, { method: 'POST', body: { spaceId: target } })).status).toBe(200)
    expect(await leaseStateOf(database, holders.id)).toEqual(revoked(holder.account, lease, 2))
    expect(await leaseStateOf(database, cats.id)).toEqual(untouched(cat, catLease, 1))
    expect(await holderOutcomes(holder.session, holders, lease)).toEqual(['404 NOT_FOUND', '404 NOT_FOUND'])
    expect(await outcomeOf(await renewLease(app.baseUrl, catSession, cats.id, catLease))).toBe('409 EDIT_LEASE_LOST:stale')
  })

  it('US-M3-12 转移停用者的文档（documents）：授权跟着文档走，凭单独授权仍能编辑的持有者租约不动，按 stale 失效，重新申请之后接着保存', async () => {
    const owner = await person()
    const holder = await person()
    const team = await teamSpace()
    const document = await seedDocument(database, { spaceId: owner.account.personalSpaceId, createdBy: owner.account.id, title: '停用者的文档' })
    await setGrant(database, { documentId: document.id, userId: holder.account.id, role: 'editor', grantedBy: owner.account.id })
    const lease = await acquireLease(app.baseUrl, holder.session, document.id)
    expect((await asUser(app.baseUrl, rootSession, `/api/admin/users/${owner.account.id}/disable`, { method: 'POST' })).status).toBe(200)
    // 停用的是所有者：他不是这个租约的持有者，不动
    expect(await leaseStateOf(database, document.id)).toEqual(untouched(holder.account, lease))

    const transferred = await asUser(app.baseUrl, rootSession, `/api/admin/users/${owner.account.id}/documents/transfer`, { method: 'POST', body: { documentIds: [document.id], target: { type: 'team', spaceId: team } } })
    expect(transferred.status, await transferred.clone().text()).toBe(200)
    expect(await leaseStateOf(database, document.id)).toEqual(untouched(holder.account, lease, 1))
    expect(await holderOutcomes(holder.session, document, lease)).toEqual(['409 EDIT_LEASE_LOST:stale', '409 EDIT_LEASE_LOST:stale'])
    const again = await acquireLease(app.baseUrl, holder.session, document.id, lease.clientInstanceId)
    expect(await outcomeOf(await save(holder.session, document, again))).toBe('200')
  })

  it('US-M3-12 取消单独授权（userDocuments）：只凭授权编辑的人的租约记 revoked、代次加一，之后心跳与保存 404，别人能申请；取消的是别人的授权时，正在编辑的人的租约不动', async () => {
    const grantee = await person()
    const other = await person()
    const space = await teamSpace()
    const document = await documentIn(space)
    const catsDocument = await documentIn(space)
    await setGrant(database, { documentId: document.id, userId: grantee.account.id, role: 'editor', grantedBy: amy.id })
    await setGrant(database, { documentId: catsDocument.id, userId: other.account.id, role: 'editor', grantedBy: amy.id })
    const lease = await acquireLease(app.baseUrl, grantee.session, document.id)
    const catLease = await acquireLease(app.baseUrl, catSession, catsDocument.id)

    expect((await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/grants/${grantee.account.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await leaseStateOf(database, document.id)).toEqual(revoked(grantee.account, lease))
    expect(await holderOutcomes(grantee.session, document, lease)).toEqual(['404 NOT_FOUND', '404 NOT_FOUND'])
    expect(await acquisitionBy(catSession, document.id)).toEqual(NO_NOTICE)

    // 这一种范围只涉及那一个人（不能用 documents：那会把正在编辑这份文档的卡特一起结束）
    expect((await asUser(app.baseUrl, amySession, `/api/documents/${catsDocument.id}/grants/${other.account.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await leaseStateOf(database, catsDocument.id)).toEqual(untouched(cat, catLease))
    expect(await outcomeOf(await renewLease(app.baseUrl, catSession, catsDocument.id, catLease))).toBe('200')
  })

  it('US-M3-12 降低单独授权为查看者（userDocuments）：只凭授权编辑的人的租约记 revoked，之后心跳与保存 403；他同时是空间的编辑者时仍能编辑，租约不动', async () => {
    const grantee = await person()
    const member = await person()
    const space = await teamSpace({ [member.account.id]: 'editor' })
    const document = await documentIn(space)
    const membersDocument = await documentIn(space)
    await setGrant(database, { documentId: document.id, userId: grantee.account.id, role: 'editor', grantedBy: amy.id })
    await setGrant(database, { documentId: membersDocument.id, userId: member.account.id, role: 'editor', grantedBy: amy.id })
    const lease = await acquireLease(app.baseUrl, grantee.session, document.id)
    const memberLease = await acquireLease(app.baseUrl, member.session, membersDocument.id)

    expect((await asUser(app.baseUrl, amySession, `/api/documents/${document.id}/grants/${grantee.account.id}`, { method: 'PUT', body: { role: 'viewer' } })).status).toBe(200)
    expect((await asUser(app.baseUrl, amySession, `/api/documents/${membersDocument.id}/grants/${member.account.id}`, { method: 'PUT', body: { role: 'viewer' } })).status).toBe(200)
    expect(await leaseStateOf(database, document.id)).toEqual(revoked(grantee.account, lease))
    expect(await holderOutcomes(grantee.session, document, lease)).toEqual(['403 PERMISSION_DENIED', '403 PERMISSION_DENIED'])
    expect(await leaseStateOf(database, membersDocument.id)).toEqual(untouched(member.account, memberLease))
    expect(await holderOutcomes(member.session, membersDocument, memberLease)).toEqual(['200', '200'])
  })
})
