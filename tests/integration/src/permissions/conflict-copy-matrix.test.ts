// 权限矩阵：另存为副本（M3-P2 设计 §3.2，00 号计划书 §7.5）。预期逐格写在表里，不调用生产代码的规则来算：
// - 能不能做：只要求能读原文档——能读的 201，读不到的 404（与"同一个人对不存在的目标做同一个操作"比较，看不到与不存在一致；
//   语句序列由 hidden-missing-parity 核对）；
// - 放在哪里（成功的格子另外核对）：本人在原文档所在的空间有新建权限时放进原文档所在的文件夹（source），否则本人个人空间的根目录（personal）。
// 每一格用一份新文档，放在目标空间的一个新文件夹里（放进原文档所在的文件夹才分得出"放对了文件夹"与"放在了根目录"）；
// 世界里的每一份文档上都有两个只凭授权的人的授权（matrix-world.ts）。
import type { CreatedDocument } from '@nerve-office/contracts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { ActorName, CellOptions, MatrixOperation, MatrixTable, MatrixWorld, TargetName } from './matrix-world.ts'
import { createdDocumentSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { postConflictCopy } from '../support/conflict-copies.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { grantsOn } from '../support/grants.ts'
import { buildMatrixWorld, cellsOf, closeWorld, columnOf, expectCell } from './matrix-world.ts'

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

type Operation = 'conflictCopy'

/**
 * 能读就能另存（201）：个人空间只有所有者与被授权的人；团队空间与归档的空间是成员与被授权的人；全员可见的两个空间是所有人；
 * 不存在的一律 404。与读取同一行（content-matrix 的 READ），只是成功是 201
 */
const MATRIX: MatrixTable<Operation> = {
  conflictCopy: {
    personal: [201, 404, 404, 404, 404, 404, 201, 201],
    team: [404, 201, 201, 201, 404, 404, 201, 201],
    visible: [201, 201, 201, 201, 201, 201, 201, 201],
    archived: [404, 201, 201, 201, 404, 404, 201, 201],
    archivedVisible: [201, 201, 201, 201, 201, 201, 201, 201],
    missing: [404, 404, 404, 404, 404, 404, 404, 404],
  },
}

/** 成功的格子放在哪里：source 是原文档所在的文件夹，personal 是本人个人空间的根目录；读不到的格子是 null */
type Placement = 'source' | 'personal' | null

/**
 * 逐格按世界的摆法写出（00 号计划书 §7.5）：在原文档所在的空间有新建权限（空间角色是编辑者及以上，空间没有归档）的放进原文档所在的文件夹——
 * 个人空间的所有者、团队空间与全员可见的空间里的空间管理员与编辑者；其余读得到的（查看者、全员可见给的查看者、只凭授权的人、
 * 归档空间里的所有人）放进自己的个人空间。只凭编辑授权的人能编辑这份文档，但授权不给空间开口子，同样不能在那里新建
 */
const PLACEMENT: Readonly<Record<TargetName, readonly [Placement, Placement, Placement, Placement, Placement, Placement, Placement, Placement]>> = {
  personal: ['source', null, null, null, null, null, 'personal', 'personal'],
  team: [null, 'source', 'source', 'personal', null, null, 'personal', 'personal'],
  visible: ['personal', 'source', 'source', 'personal', 'personal', 'personal', 'personal', 'personal'],
  archived: [null, 'personal', 'personal', 'personal', null, null, 'personal', 'personal'],
  archivedVisible: ['personal', 'personal', 'personal', 'personal', 'personal', 'personal', 'personal', 'personal'],
  missing: [null, null, null, null, null, null, null, null],
}

/** 写的那一格：原文档与它所在的文件夹 */
let lastSource: { readonly documentId: string, readonly folderId: string } | undefined

const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
  conflictCopy: async (actor, target) => {
    const folder = await world.freshFolder(target)
    const document = await world.freshDocument(target, { folderId: target === 'missing' ? undefined : folder.id })
    lastSource = { documentId: document.id, folderId: folder.id }
    return postConflictCopy(app.baseUrl, actor.session, document.id, document.unitId)
  },
}

function placementOf(target: TargetName, actor: ActorName): Placement {
  const placement = PLACEMENT[target][columnOf(actor)]
  if (placement === undefined)
    throw new Error(`PLACEMENT 的 ${target} 一行少了 ${actor} 那一列`)
  return placement
}

/** 成功的格子：放在表里写的那个地方；副本是本人能编辑的一份新文档，不带原文档的授权（世界里每一份文档上都有两个人的授权） */
const VERIFY: Readonly<Record<Operation, CellOptions['verify']>> = {
  conflictCopy: async (response, target, actor) => {
    const copy: CreatedDocument = parseExact(createdDocumentSchema, await response.json())
    const source = lastSource
    if (source === undefined)
      throw new Error('没有记下写的那一格')
    const placement = placementOf(target, actor)
    const personalSpaceId = world.actors[actor].session.session.personalSpace.id
    const expected = placement === 'source' ? { spaceId: world.spaces[target], folderId: source.folderId } : { spaceId: personalSpaceId, folderId: null }
    expect({ spaceId: copy.spaceId, folderId: copy.folderId }, `${placement ?? '读不到'}`).toEqual(expected)
    expect([copy.replayed, copy.accessVia, copy.permissions.canEdit]).toEqual([false, 'space', true])
    expect(await grantsOn(database, [copy.id])).toEqual([])
  },
}

const CELLS = cellsOf(MATRIX)

describe('US-M3-12 权限矩阵：另存为副本（能读就能另存，放在哪里按本人在原文档所在空间的新建权限）', () => {
  it('预期的两张表一致：201 的格子都有放置，404 的格子都没有', () => {
    for (const cell of CELLS)
      expect(placementOf(cell.target, cell.actor) !== null, `${cell.target} ${cell.actor}`).toBe(cell.expected === 201)
  })

  it.each(CELLS)('US-M3-12 $operation：$actor 对 $target → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell, { verify: VERIFY[cell.operation] })
  })
})
