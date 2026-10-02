// 权限矩阵：文件夹（列出一层、新建、改名、空间内移动、跨空间移动、删除）——00 号计划书 §5.3 的
// "在空间内新建文档与文件夹""移出本空间"与"删除文件夹"那条补充说明，M2-P4 设计 §3.4 第 7 条，P4-S3 spec §2；
// A14 的文档管理部分（US-M2-14）。预期逐格写在表里，不调用生产代码的规则来算。
// 每个 404 的格子另与"同一个人对不存在的目标做同一个操作"比较：响应相同（看不到与不存在一致）。
//
// v0.1 的权限只到空间与文档两级，文件夹没有自己的权限，所以除了"删除"以外都只看空间角色。
// 删除分两行：空文件夹（只看角色）与"里面有别人创建的文档"（编辑者不能删，锁下用一条计数语句判断）。
// 跨空间同样拆成两行各固定一端，理由见 document-matrix.test.ts。
// 列出一层的成功格子另外核对列出来的东西：恰好是这个空间根目录下的文件夹，别处的一个也没有（M2-P6 复核 B 的 S-1）。
import type { ErrorCode } from '@nerve-office/contracts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { CellOptions, MatrixCell, MatrixOperation, MatrixTable, MatrixWorld, Row, TargetName } from './matrix-world.ts'
import { randomUUID } from 'node:crypto'
import { folderListResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
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

type Operation = 'listFolders' | 'createFolder' | 'renameFolder' | 'moveFolderWithinSpace'
  | 'deleteFolder' | 'deleteFolderHoldingOthers' | 'moveFolderAcrossSpaces' | 'moveFolderIntoSpace'

/** 归档且全员可见的空间：所有人看得到（查看者），谁都不能改 */
const NOBODY_CHANGES: Row = [403, 403, 403, 403, 403, 403]

/** 编辑者及以上能做；查看者 403；归档的空间里所有人至多是查看者，也 403；个人空间只有所有者看得到。 */
function editorOrAbove(success: 200 | 204): Readonly<Record<TargetName, Row>> {
  return {
    personal: [success, 404, 404, 404, 404, 404],
    team: [404, success, success, 403, 404, 404],
    visible: [403, success, success, 403, 403, 403],
    archived: [404, 403, 403, 403, 404, 404],
    archivedVisible: NOBODY_CHANGES,
    missing: [404, 404, 404, 404, 404, 404],
  }
}

/** 只有空间管理员（个人空间的所有者）能做；其他看得到的人 403。 */
function spaceAdminOnly(success: 200 | 204): Readonly<Record<TargetName, Row>> {
  return {
    personal: [success, 404, 404, 404, 404, 404],
    team: [404, success, 403, 403, 404, 404],
    visible: [403, success, 403, 403, 403, 403],
    archived: [404, 403, 403, 403, 404, 404],
    archivedVisible: NOBODY_CHANGES,
    missing: [404, 404, 404, 404, 404, 404],
  }
}

const MATRIX: MatrixTable<Operation> = {
  // 列出一层是看空间的内容：有空间角色就行（与按空间列出文档同一条规则）
  listFolders: {
    personal: [200, 404, 404, 404, 404, 404],
    team: [404, 200, 200, 200, 404, 404],
    visible: [200, 200, 200, 200, 200, 200],
    archived: [404, 200, 200, 200, 404, 404],
    archivedVisible: [200, 200, 200, 200, 200, 200],
    missing: [404, 404, 404, 404, 404, 404],
  },
  // 新建文件夹与新建文档同一条规则（00 号计划书 §5.3："在空间内新建文档与文件夹"）
  createFolder: {
    personal: [201, 404, 404, 404, 404, 404],
    team: [404, 201, 201, 403, 404, 404],
    visible: [403, 201, 201, 403, 403, 403],
    archived: [404, 403, 403, 403, 404, 404],
    archivedVisible: NOBODY_CHANGES,
    missing: [404, 404, 404, 404, 404, 404],
  },
  renameFolder: editorOrAbove(200),
  moveFolderWithinSpace: editorOrAbove(200),
  // 删除空文件夹：编辑者及以上（空文件夹满足"里面只有本人创建的文档"，P4-S3 spec §2）
  deleteFolder: editorOrAbove(204),
  // 删除里面有别人创建的文档的文件夹：只有空间管理员；编辑者看得到入口，锁下的计数把他挡在 403
  deleteFolderHoldingOthers: spaceAdminOnly(204),
  // 连同子树移出本空间：源空间的空间管理员（与移动文档同一条规则）
  moveFolderAcrossSpaces: spaceAdminOnly(200),
  // 目标空间那一维：看得到、没归档（409 SPACE_ARCHIVED）、有新建的权限
  moveFolderIntoSpace: {
    personal: [200, 404, 404, 404, 404, 404],
    team: [404, 200, 200, 403, 404, 404],
    visible: [403, 200, 200, 403, 403, 403],
    archived: [404, 409, 409, 409, 404, 404],
    archivedVisible: [409, 409, 409, 409, 409, 409],
    missing: [404, 404, 404, 404, 404, 404],
  },
}

let names = 0

function nextName(prefix: string): string {
  names += 1
  return `${prefix} ${names}`
}

const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
  listFolders: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/folders?spaceId=${world.spaces[target]}`),
  createFolder: async (actor, target) => asUser(app.baseUrl, actor.session, '/api/folders', {
    method: 'POST',
    body: { spaceId: world.spaces[target], name: nextName('矩阵新建目录'), requestId: randomUUID() },
  }),
  renameFolder: async (actor, target) => {
    const folder = await world.freshFolder(target)
    return asUser(app.baseUrl, actor.session, `/api/folders/${folder.id}`, { method: 'PATCH', body: { name: nextName('矩阵目录改名') } })
  },
  moveFolderWithinSpace: async (actor, target) => {
    const folder = await world.freshFolder(target)
    const parent = await world.freshFolder(target)
    return asUser(app.baseUrl, actor.session, `/api/folders/${folder.id}`, { method: 'PATCH', body: { parentId: parent.id } })
  },
  deleteFolder: async (actor, target) => {
    const folder = await world.freshFolder(target)
    return asUser(app.baseUrl, actor.session, `/api/folders/${folder.id}`, { method: 'DELETE' })
  },
  deleteFolderHoldingOthers: async (actor, target) => {
    // 里面的那份文档由一个与谁都无关的账户创建：对每个发起请求的人来说都是"别人创建的"
    const folder = await world.freshFolderHolding(target, await world.freshSubject(target, false))
    return asUser(app.baseUrl, actor.session, `/api/folders/${folder.id}`, { method: 'DELETE' })
  },
  moveFolderAcrossSpaces: async (actor, target) => {
    const folder = await world.freshFolder(target)
    return asUser(app.baseUrl, actor.session, `/api/folders/${folder.id}/move`, { method: 'POST', body: { spaceId: world.crossSpace } })
  },
  moveFolderIntoSpace: async (actor, target) => {
    const folder = await world.folderIn(world.crossSpace, actor.id)
    return asUser(app.baseUrl, actor.session, `/api/folders/${folder.id}/move`, { method: 'POST', body: { spaceId: world.spaces[target] } })
  },
}

/**
 * 这一格的 403 是哪个错误码（逐格钉住，M2-P6 复核 B 的 G-2）。只有删"里面有别人创建的文档"的文件夹这一行有两种：
 * 没有归档的空间里的编辑者能删文件夹、只是里面有别人的文档，是 FOLDER_HAS_OTHERS_DOCUMENTS（"换个人来删"）；
 * 查看者（含经全员可见看到的人）与归档的空间里的所有人本来就不能删，是 PERMISSION_DENIED——
 * 两种说法不同，界面按错误码取文案（审查 B2）
 */
function deniedCodeOf(cell: MatrixCell<Operation>): ErrorCode {
  const editorMayDelete = cell.actor === 'editor' && (cell.target === 'team' || cell.target === 'visible')
  return cell.operation === 'deleteFolderHoldingOthers' && editorMayDelete ? 'FOLDER_HAS_OTHERS_DOCUMENTS' : 'PERMISSION_DENIED'
}

/** 成功的格子另外核对内容的操作 */
const VERIFY: Partial<Record<Operation, CellOptions['verify']>> = {
  // 列出一层（根目录）：恰好是这个空间根目录下正常状态的文件夹（查库得到），别的空间里的一个也没有
  listFolders: async (response, target) => {
    const listed = parseExact(folderListResponseSchema, await response.json())
    expect(listed.truncated).toBe(false)
    const ids = listed.items.map(item => item.id)
    expect(ids.toSorted()).toEqual(await world.rootFolderIds(target))
    expect(ids).toContain(world.folders[target].id)
  },
}

const CELLS = cellsOf(MATRIX)

describe('US-M2-14 权限矩阵：文件夹', () => {
  it.each(CELLS)('US-M2-14 $operation：$actor 对 $target → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell, { deniedCode: deniedCodeOf(cell), verify: VERIFY[cell.operation] })
  })
})
