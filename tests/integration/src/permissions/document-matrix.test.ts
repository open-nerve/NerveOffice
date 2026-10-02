// 权限矩阵：文档的整理之一——空间内的改名、移动与删除（00 号计划书 §5.3 的"删除文档"与补充说明里的"移动"，
// M2-P4 设计 §3.4 第 7 条，P4-S3 spec §2；A14 的文档管理部分，US-M2-14）。跨空间的移动与复制在 document-cross-space-matrix.test.ts
// （M2-P5 S4 扩到八列之后一个文件跑到十秒以上，拆成两个文件并行）；两边共用的推法在 document-rows.ts。
// 预期逐格写在表里，不调用生产代码的规则来算。每个 404 的格子另与"同一个人对不存在的目标做同一个操作"比较：
// 响应相同（看不到与不存在一致）。
//
// 两个只凭授权的人（M2-P5 设计 §3.4(1)，S4）：改名是内容的操作，看内容权限——空间角色与授权取较高者，归档降到查看者；
// 空间内移动（PATCH {folderId} 与 POST /move 到同一个空间）与删除是结构性的操作，只看空间角色——只凭授权的人一律 403，
// 说明是他自己的那一句（"这份文档是单独分享给你的，不能移动 / 不能删除"）。403 的说明逐格钉住。
// 改名的响应是文档详情：只凭授权时不带文件夹（文档放在一个文件夹里，这一条才有意义）。
//
// 会改数据的格子各用各的：改名、移动、删除各用一份新文档（删除另分"本人创建的"与"别人创建的"两行）。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { DeniedMessages } from './document-rows.ts'
import type { CellOptions, MatrixOperation, MatrixTable, MatrixWorld } from './matrix-world.ts'
import { documentDetailSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { asUser } from '../support/session-client.ts'
import { contentEditor, deniedMessageOf, SHARED_ONLY_DELETE, SHARED_ONLY_MOVE, spaceAdminOnly, structureEditor } from './document-rows.ts'
import { buildMatrixWorld, cellsOf, closeWorld, expectCell, expectDetailLocation, GRANTEE_ACTORS } from './matrix-world.ts'

let database: TestDatabase
let app: TestApp
let world: MatrixWorld

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  world = await buildMatrixWorld(database, app)
})

afterAll(async () => {
  await closeWorld(world)
  await app.close()
  await database.drop()
})

type Operation = 'renameDocument' | 'moveWithinSpace' | 'moveToSameSpace' | 'deleteOwnDocument' | 'deleteDocument'

const MATRIX: MatrixTable<Operation> = {
  // 改名是内容的操作（M2-P5 设计 §3.4(1)）：看内容权限
  renameDocument: contentEditor(200),
  // 空间内移动是结构性的操作（00 号计划书 §5.3 的"移动"补充说明）：两种写法同一条规则——
  // PATCH {folderId} 与 POST /move 到它现在所在的空间
  moveWithinSpace: structureEditor(200),
  moveToSameSpace: structureEditor(200),
  // 删除本人创建的文档：空间角色是编辑者及以上（查看者即使是创建人也不能，P4-S3 spec §2；只凭授权的人是创建人也不能，需求方 2026-10-01 确认）
  deleteOwnDocument: structureEditor(204),
  // 删除别人创建的文档：只有空间管理员（编辑者仅本人创建的）
  deleteDocument: spaceAdminOnly(204),
}

/** 每一行 403 的说明（M2-P5 S1 定的两句，S4 逐格钉住；推法见 document-rows.ts 的 deniedMessageOf） */
const DENIED: Readonly<Record<Operation, DeniedMessages>> = {
  renameDocument: { usual: '没有给这份文档改名的权限' },
  moveWithinSpace: { usual: '没有移动这份文档的权限', grantOnly: SHARED_ONLY_MOVE },
  moveToSameSpace: { usual: '没有移动这份文档的权限', grantOnly: SHARED_ONLY_MOVE },
  deleteOwnDocument: { usual: '编辑者只能删除自己创建的文档', grantOnly: SHARED_ONLY_DELETE },
  deleteDocument: { usual: '编辑者只能删除自己创建的文档', grantOnly: SHARED_ONLY_DELETE },
}

let renames = 0
/** 改名的那一格的文档在哪个文件夹里（文档 id → 文件夹 id） */
const renamed = new Map<string, string>()

const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
  renameDocument: async (actor, target) => {
    renames += 1
    // 放在一个文件夹里：响应的详情据此核对只凭授权时不带文件夹（见 VERIFY）
    const folder = await world.freshFolder(target)
    const document = await world.freshDocument(target, { folderId: folder.id })
    renamed.set(document.id, folder.id)
    return asUser(app.baseUrl, actor.session, `/api/documents/${document.id}`, { method: 'PATCH', body: { title: `矩阵改名 ${renames}` } })
  },
  moveWithinSpace: async (actor, target) => {
    const document = await world.freshDocument(target)
    const folder = await world.freshFolder(target)
    return asUser(app.baseUrl, actor.session, `/api/documents/${document.id}`, { method: 'PATCH', body: { folderId: folder.id } })
  },
  moveToSameSpace: async (actor, target) => {
    const document = await world.freshDocument(target)
    const folder = await world.freshFolder(target)
    return asUser(app.baseUrl, actor.session, `/api/documents/${document.id}/move`, { method: 'POST', body: { spaceId: world.spaces[target], folderId: folder.id } })
  },
  deleteOwnDocument: async (actor, target) => {
    // 这一格的文档由发起请求的人创建："编辑者仅本人创建的"那一支（只凭授权的人是创建人也不能删）
    const document = await world.freshDocument(target, { createdBy: actor.id })
    return asUser(app.baseUrl, actor.session, `/api/documents/${document.id}`, { method: 'DELETE' })
  },
  deleteDocument: async (actor, target) => {
    // 默认由这个空间的空间管理员创建：对编辑者来说是"别人创建的"
    const document = await world.freshDocument(target)
    return asUser(app.baseUrl, actor.session, `/api/documents/${document.id}`, { method: 'DELETE' })
  },
}

/** 成功的格子另外核对内容的操作 */
const VERIFY: Partial<Record<Operation, CellOptions['verify']>> = {
  // 改名的响应是文档详情：只凭授权时不带它所在的文件夹（只在 toDetail 一处，M2-P5 设计 §3.4(1)），有空间角色的照常带
  renameDocument: async (response, target, actor) => {
    const detail = parseExact(documentDetailSchema, await response.json())
    expect(detail.title).toBe(`矩阵改名 ${renames}`)
    expectDetailLocation(detail, actor, target, renamed.get(detail.id) ?? '没有记下的文档')
  },
}

const CELLS = cellsOf(MATRIX)

describe('US-M2-14 权限矩阵：文档的整理（空间内的改名、移动、删除）', () => {
  it.each(CELLS)('US-M2-14 $operation：$actor 对 $target → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell, {
      deniedMessage: deniedMessageOf(DENIED[cell.operation], cell.actor, cell.target),
      verify: VERIFY[cell.operation],
    })
  })
})

describe('US-M2-14 权限矩阵的前提：每一格另建的文档上，只凭授权的人的授权确实生效', () => {
  // 结构性操作的那几格是 403 而不是 404，前提是他们看得到那份文档；授权没建上时那几格会变成 404，
  // 矩阵照样能发现，这里把原因直接说出来
  it.each(GRANTEE_ACTORS)('%s 打得开团队空间里另建的文档，途径是 grant、不带文件夹', async (name) => {
    const folder = await world.freshFolder('team')
    const document = await world.freshDocument('team', { folderId: folder.id })
    const response = await asUser(app.baseUrl, world.actors[name].session, `/api/documents/${document.id}`)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(parseExact(documentDetailSchema, await response.json())).toMatchObject({ accessVia: 'grant', folderId: null })
  })
})
