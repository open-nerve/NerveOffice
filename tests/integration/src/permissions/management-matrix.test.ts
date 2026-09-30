// 权限矩阵：空间页头、成员的查看与管理、改名，以及系统管理的团队空间操作与停用者文档的转移（M2-P2 设计 §3.11，US-M2-14 的空间部分）。
// 预期逐格写在表里（00 号计划书 §5.2、§5.3，M2-P2 设计 §3.4），不调用生产代码的规则来算。
// 会改数据的格子各用各的：添加、调整、移出各用一个新的人，归档与全员可见各用一个新的空间，改名与创建各用一个新的名称，
// 转移各用一个新的停用者与他的一份文档。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { MatrixOperation, MatrixTable, MatrixWorld, Row, TargetName } from './matrix-world.ts'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { createDocument } from '../support/documents.ts'
import { asUser } from '../support/session-client.ts'
import { buildMatrixWorld, cellsOf, expectCell } from './matrix-world.ts'

let database: TestDatabase
let app: TestApp
let world: MatrixWorld

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  world = await buildMatrixWorld(database, app)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

type Operation = 'getSpace' | 'listMembers' | 'addMember' | 'changeRole' | 'removeMember' | 'rename'
  | 'adminCreate' | 'adminSetVisibility' | 'adminArchive' | 'adminRestore' | 'adminTransfer'

/**
 * 管理成员与改名：团队空间的空间管理员（归档之后至多是查看者，不能管理）与系统管理员（归档的也可以）；
 * 其他看得到的人 403；个人空间的所有者 403（没有成员、不能改名），其他人 404（系统管理员也看不到个人空间）
 */
function manage(success: 200 | 201 | 204): Readonly<Record<TargetName, Row>> {
  return {
    personal: [403, 404, 404, 404, 404, 404],
    team: [404, success, 403, 403, 404, success],
    visible: [403, success, 403, 403, 403, success],
    archived: [404, 403, 403, 403, 404, success],
    // 归档且全员可见：所有人看得到（403 而不是 404），只有系统管理员能管理
    archivedVisible: [403, 403, 403, 403, 403, success],
    missing: [404, 404, 404, 404, 404, 404],
  }
}

/** 系统管理的团队空间操作：只有系统管理员（会话守卫拦下其他人）；个人空间与不存在的空间是 404 */
function administer(success: 200): Readonly<Record<TargetName, Row>> {
  return {
    personal: [403, 403, 403, 403, 403, 404],
    team: [403, 403, 403, 403, 403, success],
    visible: [403, 403, 403, 403, 403, success],
    archived: [403, 403, 403, 403, 403, success],
    archivedVisible: [403, 403, 403, 403, 403, success],
    missing: [403, 403, 403, 403, 403, 404],
  }
}

/** 系统管理员才能做、与目标空间无关的操作（创建团队空间）：每个目标都一样 */
const ONLY_SYSTEM_ADMIN_CREATES: Row = [403, 403, 403, 403, 403, 201]

const MATRIX: MatrixTable<Operation> = {
  // 空间页头是内容：有空间角色才看得到；没有加入的系统管理员看不到团队空间的内容
  getSpace: {
    personal: [200, 404, 404, 404, 404, 404],
    team: [404, 200, 200, 200, 404, 404],
    visible: [200, 200, 200, 200, 200, 200],
    archived: [404, 200, 200, 200, 404, 404],
    archivedVisible: [200, 200, 200, 200, 200, 200],
    missing: [404, 404, 404, 404, 404, 404],
  },
  // 成员列表：团队空间里有空间角色的人与系统管理员；个人空间的所有者 403（个人空间没有成员）
  listMembers: {
    personal: [403, 404, 404, 404, 404, 404],
    team: [404, 200, 200, 200, 404, 200],
    visible: [200, 200, 200, 200, 200, 200],
    archived: [404, 200, 200, 200, 404, 200],
    archivedVisible: [200, 200, 200, 200, 200, 200],
    missing: [404, 404, 404, 404, 404, 404],
  },
  addMember: manage(201),
  changeRole: manage(200),
  removeMember: manage(204),
  rename: manage(200),
  // 创建不针对已有的空间：只有系统管理员（会话守卫拦下其他人）
  adminCreate: {
    personal: ONLY_SYSTEM_ADMIN_CREATES,
    team: ONLY_SYSTEM_ADMIN_CREATES,
    visible: ONLY_SYSTEM_ADMIN_CREATES,
    archived: ONLY_SYSTEM_ADMIN_CREATES,
    archivedVisible: ONLY_SYSTEM_ADMIN_CREATES,
    missing: ONLY_SYSTEM_ADMIN_CREATES,
  },
  adminSetVisibility: administer(200),
  adminArchive: administer(200),
  adminRestore: administer(200),
  // 停用者的文档转移到目标空间：只有系统管理员；个人空间是转给它的所有者（有效账户）；
  // 团队空间要没有归档（409 SPACE_ARCHIVED），不存在的 404。转移不看系统管理员在目标空间里的角色（他没有加入）
  adminTransfer: {
    personal: [403, 403, 403, 403, 403, 200],
    team: [403, 403, 403, 403, 403, 200],
    visible: [403, 403, 403, 403, 403, 200],
    archived: [403, 403, 403, 403, 403, 409],
    archivedVisible: [403, 403, 403, 403, 403, 409],
    missing: [403, 403, 403, 403, 403, 404],
  },
}

let renames = 0
let creations = 0
let leavers = 0

/** 一个新的停用者，个人空间里有一份文档 */
async function freshLeaver(): Promise<{ id: string, document: string }> {
  leavers += 1
  const account = await createPassiveAccount(database, { username: `matrix-leaver-${leavers}`, status: 'disabled' })
  return { id: account.id, document: await createDocument(database, { spaceId: account.personalSpaceId, createdBy: account.id, title: `矩阵：转移 ${leavers}` }) }
}

const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
  getSpace: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/spaces/${world.spaces[target]}`),
  listMembers: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/spaces/${world.spaces[target]}/members`),
  addMember: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/spaces/${world.spaces[target]}/members`, {
    method: 'POST',
    body: { userId: await world.freshSubject(target, false), role: 'viewer' },
  }),
  changeRole: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/spaces/${world.spaces[target]}/members/${await world.freshSubject(target, true)}`, {
    method: 'PUT',
    body: { role: 'editor' },
  }),
  removeMember: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/spaces/${world.spaces[target]}/members/${await world.freshSubject(target, true)}`, {
    method: 'DELETE',
  }),
  rename: async (actor, target) => {
    renames += 1
    return asUser(app.baseUrl, actor.session, `/api/spaces/${world.spaces[target]}/name`, { method: 'PUT', body: { name: `矩阵改名 ${renames}` } })
  },
  adminCreate: async (actor) => {
    creations += 1
    return asUser(app.baseUrl, actor.session, '/api/admin/spaces', {
      method: 'POST',
      body: { name: `矩阵创建 ${creations}`, adminUserId: await world.freshSubject('team', false), visibleToAll: false },
    })
  },
  // 每一格都真的改一次：全员可见的改成不可见，其余的改成全员可见
  adminSetVisibility: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/admin/spaces/${await world.freshSpace(target)}/visibility`, {
    method: 'PUT',
    body: { visibleToAll: target !== 'visible' && target !== 'archivedVisible' },
  }),
  adminArchive: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/admin/spaces/${await world.freshSpace(target)}/archive`, { method: 'POST' }),
  adminRestore: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/admin/spaces/${await world.freshSpace(target)}/restore`, { method: 'POST' }),
  adminTransfer: async (actor, target) => {
    const leaver = await freshLeaver()
    const destination = target === 'personal' ? { type: 'personal', userId: world.actors.owner.id } : { type: 'team', spaceId: world.spaces[target] }
    return asUser(app.baseUrl, actor.session, `/api/admin/users/${leaver.id}/documents/transfer`, {
      method: 'POST',
      body: { documentIds: [leaver.document], target: destination },
    })
  },
}

const CELLS = cellsOf(MATRIX)

describe('US-M2-14 权限矩阵：空间与成员的管理', () => {
  it.each(CELLS)('US-M2-14 $operation：$actor 对 $target → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell)
  })
})
