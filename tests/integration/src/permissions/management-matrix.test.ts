// 权限矩阵：空间页头、成员的查看与管理、改名，以及系统管理的团队空间操作（M2-P2 设计 §3.11，US-M2-14 的空间部分）。
// 预期逐格写在表里（00 号计划书 §5.2、§5.3，M2-P2 设计 §3.4），不调用生产代码的规则来算。
// 会改数据的格子各用各的：添加、调整、移出各用一个新的人，归档与全员可见各用一个新的空间，改名各用一个新的名称。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { MatrixOperation, MatrixTable, MatrixWorld, Row, TargetName } from './matrix-world.ts'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
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
  | 'adminSetVisibility' | 'adminArchive' | 'adminRestore'

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
    missing: [403, 403, 403, 403, 403, 404],
  }
}

const MATRIX: MatrixTable<Operation> = {
  // 空间页头是内容：有空间角色才看得到；没有加入的系统管理员看不到团队空间的内容
  getSpace: {
    personal: [200, 404, 404, 404, 404, 404],
    team: [404, 200, 200, 200, 404, 404],
    visible: [200, 200, 200, 200, 200, 200],
    archived: [404, 200, 200, 200, 404, 404],
    missing: [404, 404, 404, 404, 404, 404],
  },
  // 成员列表：团队空间里有空间角色的人与系统管理员；个人空间的所有者 403（个人空间没有成员）
  listMembers: {
    personal: [403, 404, 404, 404, 404, 404],
    team: [404, 200, 200, 200, 404, 200],
    visible: [200, 200, 200, 200, 200, 200],
    archived: [404, 200, 200, 200, 404, 200],
    missing: [404, 404, 404, 404, 404, 404],
  },
  addMember: manage(201),
  changeRole: manage(200),
  removeMember: manage(204),
  rename: manage(200),
  adminSetVisibility: administer(200),
  adminArchive: administer(200),
  adminRestore: administer(200),
}

let renames = 0

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
  adminSetVisibility: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/admin/spaces/${await world.freshSpace(target)}/visibility`, {
    method: 'PUT',
    body: { visibleToAll: target !== 'visible' },
  }),
  adminArchive: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/admin/spaces/${await world.freshSpace(target)}/archive`, { method: 'POST' }),
  adminRestore: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/admin/spaces/${await world.freshSpace(target)}/restore`, { method: 'POST' }),
}

const CELLS = cellsOf(MATRIX)

describe('US-M2-14 权限矩阵：空间与成员的管理', () => {
  it.each(CELLS)('US-M2-14 $operation：$actor 对 $target → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell)
  })
})
