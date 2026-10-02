// 权限矩阵：文档的读写、按空间列出与在空间里新建（M2-P2 设计 §3.11，US-M2-14 的空间部分；A03 的首次验证）。
// 预期逐格写在表里（00 号计划书 §5.2、§5.3，M2-P2 设计 §3.4），不调用生产代码的规则来算。
// 每个 404 的格子另与"同一个人对不存在的目标做同一个操作"比较：响应完全相同（看不到与不存在一致）。
// 按空间列出的成功格子另外核对列出来的东西：恰好是这个空间根目录下的文档，别处的一份也没有（M2-P6 复核 B 的 S-1）。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { CellOptions, MatrixOperation, MatrixTable, MatrixWorld, Row, TargetName } from './matrix-world.ts'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { documentListResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { asUser } from '../support/session-client.ts'
import { buildMatrixWorld, cellsOf, expectCell, snapshotOf } from './matrix-world.ts'

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

type Operation = 'readDocument' | 'readContent' | 'saveContent' | 'listSpace' | 'createDocument'

/**
 * 能看就能读：个人空间只有所有者；团队空间是成员；全员可见的空间是所有人；归档的空间成员照样能读；
 * 归档且全员可见的空间所有人照样能读（归档不收回全员可见给的查看）
 */
const READ: Readonly<Record<TargetName, Row>> = {
  personal: [200, 404, 404, 404, 404, 404],
  team: [404, 200, 200, 200, 404, 404],
  visible: [200, 200, 200, 200, 200, 200],
  archived: [404, 200, 200, 200, 404, 404],
  archivedVisible: [200, 200, 200, 200, 200, 200],
  missing: [404, 404, 404, 404, 404, 404],
}

/** 看得到的人都不能改：归档的空间里所有人至多是查看者（全员可见也不越过归档） */
const NOBODY_CHANGES: Row = [403, 403, 403, 403, 403, 403]

const MATRIX: MatrixTable<Operation> = {
  readDocument: READ,
  readContent: READ,
  listSpace: READ,
  // 编辑者及以上能保存；查看者（含全员可见的查看者）与归档的空间里所有人：看得到，不能保存
  saveContent: {
    personal: [200, 404, 404, 404, 404, 404],
    team: [404, 200, 200, 403, 404, 404],
    visible: [403, 200, 200, 403, 403, 403],
    archived: [404, 403, 403, 403, 404, 404],
    archivedVisible: NOBODY_CHANGES,
    missing: [404, 404, 404, 404, 404, 404],
  },
  // 新建要空间角色是编辑者及以上，空间没有归档；系统管理员没有加入就没有内容权限
  createDocument: {
    personal: [201, 404, 404, 404, 404, 404],
    team: [404, 201, 201, 403, 404, 404],
    visible: [403, 201, 201, 403, 403, 403],
    archived: [404, 403, 403, 403, 404, 404],
    archivedVisible: NOBODY_CHANGES,
    missing: [404, 404, 404, 404, 404, 404],
  },
}

const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
  readDocument: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.documents[target].id}`),
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

/** 保存被拒的说明：归档的空间里与其他操作一样说"空间已归档"，别处是"只能查看"（M2-P6 复核 A 的 G3） */
function saveDeniedMessage(target: TargetName): string {
  return target === 'archived' || target === 'archivedVisible' ? '空间已归档，只能查看' : '只能查看这份文档，不能保存'
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
