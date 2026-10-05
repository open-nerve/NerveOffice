// 权限矩阵：打开自检失败的上报（M3-P4 设计 §3.13，US-M3-15）。预期逐格写在表里，不调用生产代码的规则来算：
// - 能读就能报：与读取同一行（content-matrix 的 READ），成功是 204；读不到的 404，与"同一个人对不存在的目标做同一个操作"的响应相同
//   （语句序列由 hidden-missing-parity 核对）；
// - 回收站里的文档对谁都不存在（trashed-matrix 的规则），连同在它上面有授权的两个人；
// - 成功的格子另外核对：响应没有正文，日志里恰好有这个人对这份文档的一条 open-check-failed。每个人报的失败各不相同（资源名带上角色），
//   去重不会把别人的格子挡掉；每个人至多报五份，碰不到按账户的限量
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { ActorName, CellOptions, MatrixOperation, MatrixTable, MatrixWorld, Row, TargetName } from './matrix-world.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { openCheckReport, postOpenCheckReport } from '../support/open-check.ts'
import { buildMatrixWorld, cellsOf, closeWorld, expectCell } from './matrix-world.ts'

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

type Operation = 'report' | 'reportTrashed'

/** 回收站里的文档：对谁、在哪个空间里，都是不存在 */
const GONE: Row = [404, 404, 404, 404, 404, 404, 404, 404]

const MATRIX: MatrixTable<Operation> = {
  // 能读就能报（与 content-matrix 的 READ 同一行，成功是 204）：个人空间只有所有者；团队空间是成员；全员可见的空间是所有人；
  // 归档的空间成员照样能读；两个只凭授权的人在每一份文档上都有授权，哪里的都能报；不存在的除外
  report: {
    personal: [204, 404, 404, 404, 404, 404, 204, 204],
    team: [404, 204, 204, 204, 404, 404, 204, 204],
    visible: [204, 204, 204, 204, 204, 204, 204, 204],
    archived: [404, 204, 204, 204, 404, 404, 204, 204],
    archivedVisible: [204, 204, 204, 204, 204, 204, 204, 204],
    missing: GONE,
  },
  reportTrashed: {
    personal: GONE,
    team: GONE,
    visible: GONE,
    archived: GONE,
    archivedVisible: GONE,
    missing: GONE,
  },
}

/** 每个人报的失败各不相同：资源名带上角色（SDK 资源名的写法） */
function reportOf(actor: ActorName): Record<string, unknown> {
  return openCheckReport({ failures: [{ kind: 'resource-missing', resource: `SHEET_${actor}_PLUGIN` }] })
}

const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
  report: async (actor, target) => postOpenCheckReport(app.baseUrl, actor.session, world.documents[target].id, reportOf(actorNameOf(actor.id))),
  reportTrashed: async (actor, target) => postOpenCheckReport(app.baseUrl, actor.session, world.trashedDocuments[target].id, reportOf(actorNameOf(actor.id))),
}

/** 角色的名字（按账户 id 找回来：操作只拿到账户） */
function actorNameOf(userId: string): ActorName {
  const entry = Object.entries(world.actors).find(([, actor]) => actor.id === userId)
  if (entry === undefined)
    throw new Error(`世界里没有这个账户：${userId}`)
  return entry[0] as ActorName
}

/** 成功的格子：没有正文；日志里恰好一条这个人对这份文档的 open-check-failed，带着他报的失败 */
const VERIFY: CellOptions['verify'] = async (response: Response, target: TargetName, actor: ActorName) => {
  expect(await response.text()).toBe('')
  const documentId = world.documents[target].id
  const logged = app.logs.entries().filter(entry => entry.event === 'open-check-failed' && entry.documentId === documentId && entry.userId === world.actors[actor].id)
  expect(logged).toHaveLength(1)
  expect(logged[0]?.failures).toEqual([{ kind: 'resource-missing', resource: `SHEET_${actor}_PLUGIN` }])
}

const CELLS = cellsOf(MATRIX)

describe('US-M3-15 权限矩阵：打开自检失败的上报（能读就能报，回收站里的不存在）', () => {
  it.each(CELLS)('US-M3-15 $operation：$actor 对 $target → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell, { verify: VERIFY })
  })
})
