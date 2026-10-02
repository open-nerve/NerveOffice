// 权限矩阵：文档的读写、按空间列出与在空间里新建（M2-P2 设计 §3.11，US-M2-14 的空间部分；A03 的首次验证）。
// 预期逐格写在表里（00 号计划书 §5.2、§5.3，M2-P2 设计 §3.4，M2-P5 设计 §3.4(1)），不调用生产代码的规则来算。
// 每个 404 的格子另与"同一个人对不存在的目标做同一个操作"比较：响应完全相同（看不到与不存在一致）。
// 按空间列出的成功格子另外核对列出来的东西：恰好是这个空间根目录下的文档，别处的一份也没有（M2-P6 复核 B 的 S-1）。
// 两个只凭授权的人（M2-P5 S4）：内容权限取空间角色与授权的较高者（读、保存看它），归档一律降到查看者；
// 空间的内容（按空间列出、在里面新建）只看空间角色——授权不给空间开口子；打开的详情只凭授权时不带文件夹。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { CellOptions, MatrixOperation, MatrixTable, MatrixWorld, Row, TargetName } from './matrix-world.ts'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { documentDetailSchema, documentListResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { asUser } from '../support/session-client.ts'
import { buildMatrixWorld, cellsOf, closeWorld, expectCell, expectDetailLocation, isArchived, snapshotOf } from './matrix-world.ts'

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

type Operation = 'readDocument' | 'readFolderDocument' | 'readContent' | 'saveContent' | 'listSpace' | 'createDocument'

/**
 * 能看就能读：个人空间只有所有者；团队空间是成员；全员可见的空间是所有人；归档的空间成员照样能读；
 * 归档且全员可见的空间所有人照样能读（归档不收回全员可见给的查看）。
 * 两个只凭授权的人（最后两列）在每一份文档上都有授权，所以哪里的都读得到——包括他们看不到的空间里的；不存在的除外
 */
const READ: Readonly<Record<TargetName, Row>> = {
  personal: [200, 404, 404, 404, 404, 404, 200, 200],
  team: [404, 200, 200, 200, 404, 404, 200, 200],
  visible: [200, 200, 200, 200, 200, 200, 200, 200],
  archived: [404, 200, 200, 200, 404, 404, 200, 200],
  archivedVisible: [200, 200, 200, 200, 200, 200, 200, 200],
  missing: [404, 404, 404, 404, 404, 404, 404, 404],
}

/**
 * 看空间的内容（按空间列出）：只看空间角色。与 READ 只差最后两列：只凭授权的人在个人空间、团队空间、归档的空间里没有空间角色，
 * 授权不给空间开口子（M2-P5 设计 §3.4(1) 的注意），与外人一样 404；全员可见的两个空间里他们是查看者，照样列得出
 */
const SPACE_CONTENT: Readonly<Record<TargetName, Row>> = {
  personal: [200, 404, 404, 404, 404, 404, 404, 404],
  team: [404, 200, 200, 200, 404, 404, 404, 404],
  visible: [200, 200, 200, 200, 200, 200, 200, 200],
  archived: [404, 200, 200, 200, 404, 404, 404, 404],
  archivedVisible: [200, 200, 200, 200, 200, 200, 200, 200],
  missing: [404, 404, 404, 404, 404, 404, 404, 404],
}

/** 看得到的人都不能改：归档的空间里所有人至多是查看者（全员可见、单独授权都不越过归档） */
const NOBODY_CHANGES: Row = [403, 403, 403, 403, 403, 403, 403, 403]

const MATRIX: MatrixTable<Operation> = {
  readDocument: READ,
  // 放在文件夹里的那一份：读的规则相同，另核对只凭授权时详情不带文件夹（根目录下的那一份挡不住"忘了去掉文件夹"）
  readFolderDocument: READ,
  readContent: READ,
  listSpace: SPACE_CONTENT,
  // 内容权限是编辑者及以上才能保存：空间角色与授权取较高者——只有编辑授权的人在个人空间、团队空间、全员可见的空间里能保存
  // （全员可见只给了他查看者，授权把内容权限抬到编辑者）；查看者（含全员可见的、只有查看授权的）看得到，不能保存；
  // 归档的空间里所有人至多是查看者，编辑授权同样降级
  saveContent: {
    personal: [200, 404, 404, 404, 404, 404, 403, 200],
    team: [404, 200, 200, 403, 404, 404, 403, 200],
    visible: [403, 200, 200, 403, 403, 403, 403, 200],
    archived: [404, 403, 403, 403, 404, 404, 403, 403],
    archivedVisible: NOBODY_CHANGES,
    missing: [404, 404, 404, 404, 404, 404, 404, 404],
  },
  // 新建要空间角色是编辑者及以上，空间没有归档；系统管理员没有加入就没有内容权限；
  // 授权只到文档一级，不给在空间里新建的权限：只凭授权的人在他看不到的空间里 404，全员可见的空间里只是查看者，403
  createDocument: {
    personal: [201, 404, 404, 404, 404, 404, 404, 404],
    team: [404, 201, 201, 403, 404, 404, 404, 404],
    visible: [403, 201, 201, 403, 403, 403, 403, 403],
    archived: [404, 403, 403, 403, 404, 404, 404, 404],
    archivedVisible: NOBODY_CHANGES,
    missing: [404, 404, 404, 404, 404, 404, 404, 404],
  },
}

const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
  readDocument: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.documents[target].id}`),
  readFolderDocument: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.folderDocuments[target].id}`),
  readContent: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.documents[target].id}/content`),
  saveContent: async (actor, target) => {
    // 每一格用自己的文档：成功的保存会改变修订号
    const document = await world.freshDocument(target)
    const query = new URLSearchParams({ baseRevision: '1', requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: '1' })
    return asUser(app.baseUrl, actor.session, `/api/documents/${document.id}/content?${query.toString()}`, {
      method: 'PUT',
      binary: { contentType: 'application/gzip', bytes: zlib.gzipSync(snapshotOf(document.unitId, '矩阵')) },
    })
  },
  listSpace: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents?spaceId=${world.spaces[target]}`),
  createDocument: async (actor, target) => asUser(app.baseUrl, actor.session, '/api/documents', {
    method: 'POST',
    body: { type: 'sheet', requestId: randomUUID(), spaceId: world.spaces[target] },
  }),
}

/** 成功的格子另外核对内容的操作 */
const VERIFY: Partial<Record<Operation, CellOptions['verify']>> = {
  // 打开的详情：途径是 ACCESS_VIA 的那一格（只凭授权的人在全员可见的空间里是 space）；这一份在根目录下
  readDocument: async (response, target, actor) => {
    const detail = parseExact(documentDetailSchema, await response.json())
    expect(detail.id).toBe(world.documents[target].id)
    expectDetailLocation(detail, actor, target, null)
  },
  // 文件夹里的那一份：有空间角色的人看到它所在的文件夹，只凭授权的人看到的文件夹为空（不给空间的目录结构）
  readFolderDocument: async (response, target, actor) => {
    const detail = parseExact(documentDetailSchema, await response.json())
    expect(detail.id).toBe(world.folderDocuments[target].id)
    expectDetailLocation(detail, actor, target, world.folders[target].id)
  },
  // 按空间列出（根目录）：恰好是这个空间根目录下正常状态的文档（查库得到），别的空间里的一份也没有；
  // 固定的文件夹里那一份不混进根目录（M2-P6 复验 R-G5：世界里的文件夹原来是空的，根目录不按目录过滤也查不出来）
  listSpace: async (response, target) => {
    const listed = parseExact(documentListResponseSchema, await response.json())
    expect(listed.nextCursor).toBeNull()
    const ids = listed.items.map(item => item.id)
    expect(ids.toSorted()).toEqual(await world.rootDocumentIds(target))
    expect(ids).toContain(world.documents[target].id)
    expect(ids).not.toContain(world.folderDocuments[target].id)
  },
}

/** 保存被拒的说明：归档的空间里与其他操作一样说"空间已归档"，别处是"只能查看"（M2-P6 复核 A 的 G3）；只凭查看授权的人同样 */
function saveDeniedMessage(target: TargetName): string {
  return isArchived(target) ? '空间已归档，只能查看' : '只能查看这份文档，不能保存'
}

const CELLS = cellsOf(MATRIX)

describe('US-M2-14 权限矩阵：文档与空间的内容', () => {
  it.each(CELLS)('US-M2-14 $operation：$actor 对 $target → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell, {
      verify: VERIFY[cell.operation],
      deniedMessage: cell.operation === 'saveContent' ? saveDeniedMessage(cell.target) : undefined,
    })
  })
})
