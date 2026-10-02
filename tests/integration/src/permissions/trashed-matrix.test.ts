// 权限矩阵：新的目标态"已经在回收站里"（P4-S3 spec §5，M2-P4 设计 §3.5）——回收站里的文档与文件夹
// 对普通接口一律当作不存在：打不开、存不了、改不了名、移不动、复制不了、再删不了，文件夹也列不出来。
//
// 为什么另起一张表，不往 TARGETS 里加一个目标：TARGETS 那一维是**空间的状态**（个人、团队、全员可见、
// 归档、不存在），而"在回收站里"是**对象自己的状态**，与空间无关。把它塞进 TARGETS，两张已有的矩阵
// （内容 150 格、管理 330 格）就要各多出一整列与 team 一模一样的格子，目标轴的含义也被搅浑。
// 另起一张表则保留原来的目标轴（含义不变：这个在回收站里的对象在哪个空间里），
// 每一格都是 404，而且由 expectCell 逐格与"同一个人对不存在的对象做同一个操作"比对响应——
// 这正是这条规则要说的话：**在谁的眼里都与不存在一模一样**，包括空间管理员与创建人自己。
//
// 整张表只读不改（每一格都被拒），所以共用 world 里固定的那一批在回收站里的文档与文件夹。
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

type Operation = 'readDocument' | 'readContent' | 'saveContent' | 'renameDocument' | 'moveDocument'
  | 'copyDocument' | 'deleteDocument' | 'listFoldersUnder' | 'listDocumentsUnder' | 'renameFolder' | 'moveFolder' | 'deleteFolder'

/** 回收站里的对象：对谁、在哪个空间里，都是"不存在"。 */
const GONE: Readonly<Record<TargetName, Row>> = {
  personal: [404, 404, 404, 404, 404, 404],
  team: [404, 404, 404, 404, 404, 404],
  visible: [404, 404, 404, 404, 404, 404],
  archived: [404, 404, 404, 404, 404, 404],
  archivedVisible: [404, 404, 404, 404, 404, 404],
  missing: [404, 404, 404, 404, 404, 404],
}

const MATRIX: MatrixTable<Operation> = {
  readDocument: GONE,
  readContent: GONE,
  saveContent: GONE,
  renameDocument: GONE,
  moveDocument: GONE,
  copyDocument: GONE,
  deleteDocument: GONE,
  listFoldersUnder: GONE,
  listDocumentsUnder: GONE,
  renameFolder: GONE,
  moveFolder: GONE,
  deleteFolder: GONE,
}

const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
  readDocument: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.trashedDocuments[target].id}`),
  readContent: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.trashedDocuments[target].id}/content`),
  saveContent: async (actor, target) => {
    const document = world.trashedDocuments[target]
    const query = new URLSearchParams({ baseRevision: '1', requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: '1' })
    return asUser(app.baseUrl, actor.session, `/api/documents/${document.id}/content?${query.toString()}`, {
      method: 'PUT',
      binary: { contentType: 'application/gzip', bytes: zlib.gzipSync(snapshotOf(document.unitId, '矩阵')) },
    })
  },
  renameDocument: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.trashedDocuments[target].id}`, {
    method: 'PATCH',
    body: { title: '矩阵：回收站里改名' },
  }),
  moveDocument: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.trashedDocuments[target].id}/move`, {
    method: 'POST',
    body: { spaceId: world.crossSpace },
  }),
  copyDocument: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.trashedDocuments[target].id}/copy`, {
    method: 'POST',
    body: { spaceId: world.crossSpace, requestId: randomUUID() },
  }),
  deleteDocument: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.trashedDocuments[target].id}`, { method: 'DELETE' }),
  // 列出回收站里那个文件夹底下的一层：空间看得到的人也只会看到"这个文件夹不存在"
  listFoldersUnder: async (actor, target) => asUser(
    app.baseUrl,
    actor.session,
    `/api/folders?spaceId=${world.spaces[target]}&parentId=${world.trashedFolders[target].id}`,
  ),
  listDocumentsUnder: async (actor, target) => asUser(
    app.baseUrl,
    actor.session,
    `/api/documents?spaceId=${world.spaces[target]}&folderId=${world.trashedFolders[target].id}`,
  ),
  renameFolder: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/folders/${world.trashedFolders[target].id}`, {
    method: 'PATCH',
    body: { name: '矩阵：回收站里改名' },
  }),
  moveFolder: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/folders/${world.trashedFolders[target].id}/move`, {
    method: 'POST',
    body: { spaceId: world.crossSpace },
  }),
  deleteFolder: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/folders/${world.trashedFolders[target].id}`, { method: 'DELETE' }),
}

const CELLS = cellsOf(MATRIX)

describe('US-M2-14 权限矩阵：回收站里的文档与文件夹对普通接口一律不存在', () => {
  it.each(CELLS)('US-M2-14 $operation：$actor 对 $target 里在回收站的对象 → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell)
  })
})
