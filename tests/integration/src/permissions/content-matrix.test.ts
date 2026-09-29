// 权限矩阵：文档的读写、按空间列出与在空间里新建（M2-P2 设计 §3.11，US-M2-14 的空间部分；A03 的首次验证）。
// 预期逐格写在表里（00 号计划书 §5.2、§5.3，M2-P2 设计 §3.4），不调用生产代码的规则来算。
// 每个 404 的格子另与"同一个人对不存在的目标做同一个操作"比较：响应相同（看不到与不存在一致）。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { MatrixOperation, MatrixTable, MatrixWorld, Row, TargetName } from './matrix-world.ts'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
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

/** 能看就能读：个人空间只有所有者；团队空间是成员；全员可见的空间是所有人；归档的空间成员照样能读 */
const READ: Readonly<Record<TargetName, Row>> = {
  personal: [200, 404, 404, 404, 404, 404],
  team: [404, 200, 200, 200, 404, 404],
  visible: [200, 200, 200, 200, 200, 200],
  archived: [404, 200, 200, 200, 404, 404],
  missing: [404, 404, 404, 404, 404, 404],
}

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
    missing: [404, 404, 404, 404, 404, 404],
  },
  // 新建要空间角色是编辑者及以上，空间没有归档；系统管理员没有加入就没有内容权限
  createDocument: {
    personal: [201, 404, 404, 404, 404, 404],
    team: [404, 201, 201, 403, 404, 404],
    visible: [403, 201, 201, 403, 403, 403],
    archived: [404, 403, 403, 403, 404, 404],
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

const CELLS = cellsOf(MATRIX)

describe('US-M2-14 权限矩阵：文档与空间的内容', () => {
  it.each(CELLS)('US-M2-14 $operation：$actor 对 $target → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell)
  })
})
