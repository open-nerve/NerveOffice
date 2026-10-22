import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { MatrixOperation, MatrixTable, MatrixWorld, TargetName } from './matrix-world.ts'
import { randomUUID } from 'node:crypto'
import { documentHistoryDetailSchema, documentHistoryListResponseSchema, sheetSnapshotFor } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { captureHistory } from '../support/document-history.ts'
import { asUser } from '../support/session-client.ts'
import { contentEditor, deniedMessageOf } from './document-rows.ts'
import { buildMatrixWorld, cellsOf, closeWorld, expectCell } from './matrix-world.ts'

let database: TestDatabase
let app: TestApp
let world: MatrixWorld
const histories = new Map<TargetName, string>()

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  world = await buildMatrixWorld(database, app)
  for (const target of Object.keys(world.documents) as TargetName[])
    histories.set(target, target === 'missing' ? randomUUID() : await captureHistory(app, world.documents[target].id))
})
afterAll(async () => {
  await closeWorld(world)
  await app.close()
  await database.drop()
})

type Operation = 'list' | 'detail' | 'content'
const MATRIX: MatrixTable<Operation> = { list: contentEditor(200), detail: contentEditor(200), content: contentEditor(200) }
const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
  list: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.documents[target].id}/history`),
  detail: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.documents[target].id}/history/${histories.get(target)}`),
  content: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.documents[target].id}/history/${histories.get(target)}/content`),
}

describe('US-M5-10 历史权限矩阵：所有读取入口独立要求当前有效编辑资格', () => {
  it.each(cellsOf(MATRIX))('$operation：$actor 对 $target → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell, {
      deniedMessage: deniedMessageOf({ usual: '只有编辑者能查看这份文档的历史' }, cell.actor, cell.target),
      verify: async (response, target) => {
        if (cell.operation === 'content') {
          expect(await response.text()).toBe(sheetSnapshotFor(world.documents[target].unitId))
          return
        }
        if (cell.operation === 'list') {
          const page = parseExact(documentHistoryListResponseSchema, await response.json())
          expect(page.items.map(item => item.id)).toEqual([histories.get(target)])
          expect(page.nextCursor).toBeNull()
          return
        }
        expect(parseExact(documentHistoryDetailSchema, await response.json()).id).toBe(histories.get(target))
      },
    })
  })
})
