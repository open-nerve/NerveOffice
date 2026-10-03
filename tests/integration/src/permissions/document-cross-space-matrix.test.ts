// 权限矩阵：文档的整理之二——跨空间的移动与复制（00 号计划书 §5.3 的"移出本空间"与补充说明里的"复制"，
// M2-P4 设计 §3.4 第 7 条；A14 的文档管理部分，US-M2-14）。空间内的改名、移动、删除在 document-matrix.test.ts
// （M2-P5 S4 扩到八列之后一个文件跑到十秒以上，拆成两个文件并行）；两边共用的推法在 document-rows.ts。
// 预期逐格写在表里，不调用生产代码的规则来算。每个 404 的格子另与"同一个人对不存在的目标做同一个操作"比较。
//
// 跨空间的操作牵涉两个空间，矩阵的一行只放得下一个目标，所以拆成两行，各固定一端（固定的那一端是 world.crossSpace，
// 八个人在那里都是空间管理员，所以它那一端对谁都成立）：
// - moveAcrossSpaces、copyDocument：目标固定，目标轴上变的是**源空间**，考核"源空间的规则"；
// - moveIntoSpace、copyIntoSpace：来源固定，目标轴上变的是**目标空间**，考核"目标空间有新建权限"。
//
// 两个只凭授权的人（M2-P5 设计 §3.4(1)，S4）：移出本空间是结构性的操作，只看来源空间的空间角色——他们在目标（crossSpace）是
// 空间管理员，被拒只因为在来源空间只凭授权，说明"这份文档是单独分享给你的，不能移动"；复制是内容的操作，能读就能复制，
// 副本不带原文档的授权（§3.4(6)）。403 的说明逐格钉住。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { DeniedMessages } from './document-rows.ts'
import type { CellOptions, MatrixDocument, MatrixOperation, MatrixTable, MatrixWorld } from './matrix-world.ts'
import { randomUUID } from 'node:crypto'
import { createdDocumentSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { grantsOn } from '../support/grants.ts'
import { asUser } from '../support/session-client.ts'
import { deniedMessageOf, intoSpace, SHARED_ONLY_MOVE, spaceAdminOnly } from './document-rows.ts'
import { buildMatrixWorld, cellsOf, closeWorld, expectCell } from './matrix-world.ts'

let database: TestDatabase
let app: TestApp
let world: MatrixWorld
/** 复制那一行的源文档：放在固定的跨空间里，八个人都读得到，复制也不会改到它 */
let copySource: MatrixDocument

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  world = await buildMatrixWorld(database, app)
  copySource = await world.documentIn(world.crossSpace, world.actors.spaceAdmin.id)
})

afterAll(async () => {
  await closeWorld(world)
  await app.close()
  await database.drop()
})

type Operation = 'moveAcrossSpaces' | 'copyDocument' | 'moveIntoSpace' | 'copyIntoSpace'

const MATRIX: MatrixTable<Operation> = {
  // 移出本空间：源空间的空间管理员（00 号计划书 §5.3）
  moveAcrossSpaces: spaceAdminOnly(200),
  // 复制：能读源文档就能复制（目标空间的新建权限另判，见 copyIntoSpace），所以这一行就是"能不能读这份文档"——
  // 只凭授权的人哪里的都读得到（复制是内容的操作，00 号计划书 §5.3 补充说明）
  copyDocument: {
    personal: [201, 404, 404, 404, 404, 404, 201, 201],
    team: [404, 201, 201, 201, 404, 404, 201, 201],
    visible: [201, 201, 201, 201, 201, 201, 201, 201],
    // 归档的空间只能查看，但复制改的是目标空间，从归档的空间里复制出去照样可以
    archived: [404, 201, 201, 201, 404, 404, 201, 201],
    archivedVisible: [201, 201, 201, 201, 201, 201, 201, 201],
    missing: [404, 404, 404, 404, 404, 404, 404, 404],
  },
  moveIntoSpace: intoSpace(200),
  copyIntoSpace: intoSpace(201),
}

/** 每一行 403 的说明（推法见 document-rows.ts 的 deniedMessageOf）；复制本身不会 403（能读就能复制），目标那一维说的是目标空间 */
const DENIED: Readonly<Record<Operation, DeniedMessages>> = {
  moveAcrossSpaces: { usual: '只有空间管理员能把文档移出这个空间', grantOnly: SHARED_ONLY_MOVE },
  copyDocument: { usual: '没有复制这份文档的权限' },
  moveIntoSpace: { usual: '没有在目标空间里新建的权限', aboutTarget: true },
  copyIntoSpace: { usual: '没有在目标空间里新建的权限', aboutTarget: true },
}

const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
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

/**
 * 复制出来的副本：在目标空间里（调用者在那里有空间角色，途径是 space、照常给文件夹——这里是根目录），
 * **不带原文档的授权**（M2-P5 设计 §3.4(6)，US-M2-08）：源文档上有两个只凭授权的人的授权，副本上一条也没有
 */
async function expectCopyIn(response: Response, spaceId: string): Promise<void> {
  const copy = parseExact(createdDocumentSchema, await response.json())
  expect(copy).toMatchObject({ spaceId, folderId: null, accessVia: 'space', replayed: false })
  expect(await grantsOn(database, [copy.id])).toEqual([])
}

/** 成功的格子另外核对内容的操作 */
const VERIFY: Partial<Record<Operation, CellOptions['verify']>> = {
  copyDocument: async response => expectCopyIn(response, world.crossSpace),
  copyIntoSpace: async (response, target) => expectCopyIn(response, world.spaces[target]),
}

const CELLS = cellsOf(MATRIX)

describe('US-M2-14 权限矩阵：文档的整理（跨空间的移动与复制）', () => {
  it.each(CELLS)('US-M2-14 $operation：$actor 对 $target → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell, {
      deniedMessage: deniedMessageOf(DENIED[cell.operation], cell.actor, cell.target),
      verify: VERIFY[cell.operation],
    })
  })
})
