// 权限矩阵：文档的整理（改名、空间内移动、跨空间移动、复制、删除）——00 号计划书 §5.3 的"删除文档""移出本空间"
// 与补充说明里的"复制""移动"，M2-P4 设计 §3.4 第 7 条，P4-S3 spec §2；A14 的文档管理部分（US-M2-14）。
// 预期逐格写在表里，不调用生产代码的规则来算。每个 404 的格子另与"同一个人对不存在的目标做同一个操作"比较：
// 响应相同（看不到与不存在一致）。
//
// 跨空间的操作牵涉两个空间，矩阵的一行只放得下一个目标，所以拆成两行，各固定一端（固定的那一端是 world.crossSpace，
// 六个人在那里都是空间管理员，所以它那一端对谁都成立）：
// - moveAcrossSpaces、copyDocument：目标固定，目标轴上变的是**源空间**，考核"源空间的规则"；
// - moveIntoSpace、copyIntoSpace：来源固定，目标轴上变的是**目标空间**，考核"目标空间有新建权限"。
//
// 会改数据的格子各用各的：改名、移动、删除各用一份新文档（删除另分"本人创建的"与"别人创建的"两行）；
// 复制不改源文档，所以源用固定的那一份。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { MatrixDocument, MatrixOperation, MatrixTable, MatrixWorld, Row, TargetName } from './matrix-world.ts'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { asUser } from '../support/session-client.ts'
import { buildMatrixWorld, cellsOf, expectCell } from './matrix-world.ts'

let database: TestDatabase
let app: TestApp
let world: MatrixWorld
/** 复制那一行的源文档：放在固定的跨空间里，六个人都读得到，复制也不会改到它 */
let copySource: MatrixDocument

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  world = await buildMatrixWorld(database, app)
  copySource = await world.documentIn(world.crossSpace, world.actors.spaceAdmin.id)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

type Operation = 'renameDocument' | 'moveWithinSpace' | 'deleteOwnDocument' | 'deleteDocument'
  | 'moveAcrossSpaces' | 'copyDocument' | 'moveIntoSpace' | 'copyIntoSpace'

/**
 * 编辑者及以上能做；查看者看得到却不能做（403）；归档的空间里所有人至多是查看者，也 403；
 * 个人空间只有所有者，别人一概看不到（404）。
 */
function editorOrAbove(success: 200 | 204): Readonly<Record<TargetName, Row>> {
  return {
    personal: [success, 404, 404, 404, 404, 404],
    team: [404, success, success, 403, 404, 404],
    visible: [403, success, success, 403, 403, 403],
    archived: [404, 403, 403, 403, 404, 404],
    missing: [404, 404, 404, 404, 404, 404],
  }
}

/** 只有空间管理员（个人空间的所有者）能做；其他看得到的人 403（归档的空间里空间管理员也降为查看者）。 */
function spaceAdminOnly(success: 200 | 204): Readonly<Record<TargetName, Row>> {
  return {
    personal: [success, 404, 404, 404, 404, 404],
    team: [404, success, 403, 403, 404, 404],
    visible: [403, success, 403, 403, 403, 403],
    archived: [404, 403, 403, 403, 404, 404],
    missing: [404, 404, 404, 404, 404, 404],
  }
}

/**
 * 跨空间的目标空间那一维（M2-P4 设计 §3.2）：要看得到（否则 404，不暴露空间是否存在）、
 * 没有归档（409 SPACE_ARCHIVED，排在没有权限之前）、有新建的权限（否则 403）。
 * 与"在归档的空间里新建"刻意不同：那是 403"空间已归档，只能查看"，这里是 409。
 */
function intoSpace(success: 200 | 201): Readonly<Record<TargetName, Row>> {
  return {
    personal: [success, 404, 404, 404, 404, 404],
    team: [404, success, success, 403, 404, 404],
    visible: [403, success, success, 403, 403, 403],
    archived: [404, 409, 409, 409, 404, 404],
    missing: [404, 404, 404, 404, 404, 404],
  }
}

const MATRIX: MatrixTable<Operation> = {
  // 改名与空间内移动：编辑者及以上（00 号计划书 §5.3 的"移动"补充说明）
  renameDocument: editorOrAbove(200),
  moveWithinSpace: editorOrAbove(200),
  // 删除本人创建的文档：编辑者及以上（查看者即使是创建人也不能，P4-S3 spec §2）
  deleteOwnDocument: editorOrAbove(204),
  // 删除别人创建的文档：只有空间管理员（编辑者仅本人创建的）
  deleteDocument: spaceAdminOnly(204),
  // 移出本空间：源空间的空间管理员（00 号计划书 §5.3）
  moveAcrossSpaces: spaceAdminOnly(200),
  // 复制：能读源文档就能复制（目标空间的新建权限另判，见 copyIntoSpace），所以这一行就是"能不能读这份文档"
  copyDocument: {
    personal: [201, 404, 404, 404, 404, 404],
    team: [404, 201, 201, 201, 404, 404],
    visible: [201, 201, 201, 201, 201, 201],
    // 归档的空间只能查看，但复制改的是目标空间，从归档的空间里复制出去照样可以
    archived: [404, 201, 201, 201, 404, 404],
    missing: [404, 404, 404, 404, 404, 404],
  },
  moveIntoSpace: intoSpace(200),
  copyIntoSpace: intoSpace(201),
}

let renames = 0

const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
  renameDocument: async (actor, target) => {
    renames += 1
    const document = await world.freshDocument(target)
    return asUser(app.baseUrl, actor.session, `/api/documents/${document.id}`, { method: 'PATCH', body: { title: `矩阵改名 ${renames}` } })
  },
  moveWithinSpace: async (actor, target) => {
    const document = await world.freshDocument(target)
    const folder = await world.freshFolder(target)
    return asUser(app.baseUrl, actor.session, `/api/documents/${document.id}`, { method: 'PATCH', body: { folderId: folder.id } })
  },
  deleteOwnDocument: async (actor, target) => {
    // 这一格的文档由发起请求的人创建："编辑者仅本人创建的"那一支
    const document = await world.freshDocument(target, actor.id)
    return asUser(app.baseUrl, actor.session, `/api/documents/${document.id}`, { method: 'DELETE' })
  },
  deleteDocument: async (actor, target) => {
    // 默认由这个空间的空间管理员创建：对编辑者来说是"别人创建的"
    const document = await world.freshDocument(target)
    return asUser(app.baseUrl, actor.session, `/api/documents/${document.id}`, { method: 'DELETE' })
  },
  moveAcrossSpaces: async (actor, target) => {
    const document = await world.freshDocument(target)
    return asUser(app.baseUrl, actor.session, `/api/documents/${document.id}/move`, { method: 'POST', body: { spaceId: world.crossSpace } })
  },
  copyDocument: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.documents[target].id}/copy`, {
    method: 'POST',
    body: { spaceId: world.crossSpace, requestId: randomUUID() },
  }),
  moveIntoSpace: async (actor, target) => {
    const document = await world.documentIn(world.crossSpace, actor.id)
    return asUser(app.baseUrl, actor.session, `/api/documents/${document.id}/move`, { method: 'POST', body: { spaceId: world.spaces[target] } })
  },
  copyIntoSpace: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${copySource.id}/copy`, {
    method: 'POST',
    body: { spaceId: world.spaces[target], requestId: randomUUID() },
  }),
}

const CELLS = cellsOf(MATRIX)

describe('US-M2-14 权限矩阵：文档的整理（改名、移动、复制、删除）', () => {
  it.each(CELLS)('US-M2-14 $operation：$actor 对 $target → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell)
  })
})
