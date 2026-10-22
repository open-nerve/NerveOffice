import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { MatrixDocument, MatrixOperation, MatrixTable, MatrixWorld, TargetName } from './matrix-world.ts'
import { randomUUID } from 'node:crypto'
import { createdDocumentSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { captureHistory } from '../support/document-history.ts'
import { asUser } from '../support/session-client.ts'
import { contentEditor, deniedMessageOf, intoSpace } from './document-rows.ts'
import { buildMatrixWorld, cellsOf, closeWorld, expectCell } from './matrix-world.ts'

let database: TestDatabase
let app: TestApp
let world: MatrixWorld
let accessible: MatrixDocument
let accessibleHistory: string
const histories = new Map<TargetName, string>()
beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  world = await buildMatrixWorld(database, app)
  for (const target of Object.keys(world.documents) as TargetName[])
    histories.set(target, target === 'missing' ? randomUUID() : await captureHistory(app, world.documents[target].id))
  accessible = await world.documentIn(world.crossSpace, world.actors.owner.id)
  accessibleHistory = await captureHistory(app, accessible.id)
})
afterAll(async () => {
  await closeWorld(world)
  await app.close()
  await database.drop()
})

type Operation = 'source' | 'target'
const MATRIX: MatrixTable<Operation> = { source: contentEditor(201), target: intoSpace(201) }
const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
  source: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${world.documents[target].id}/history/${histories.get(target)}/restore`, {
    method: 'POST',
    body: { requestId: randomUUID(), spaceId: world.crossSpace },
  }),
  target: async (actor, target) => asUser(app.baseUrl, actor.session, `/api/documents/${accessible.id}/history/${accessibleHistory}/restore`, {
    method: 'POST',
    body: { requestId: randomUUID(), spaceId: world.spaces[target], folderId: world.folders[target].id },
  }),
}

describe('US-M5-10 恢复矩阵：源历史编辑资格与目标创建资格分别核对', () => {
  it.each(cellsOf(MATRIX))('$operation：$actor 对 $target → $expected', async (cell) => {
    const messages = cell.operation === 'source'
      ? { usual: '只有编辑者能查看这份文档的历史' }
      : { usual: '没有在目标空间里新建的权限', aboutTarget: true }
    await expectCell(world, OPERATIONS[cell.operation], cell, {
      deniedMessage: deniedMessageOf(messages, cell.actor, cell.target),
      verify: async (response, target) => {
        const copy = parseExact(createdDocumentSchema, await response.json())
        const original = cell.operation === 'source' ? world.documents[target] : accessible
        expect(copy.id).not.toBe(original.id)
        expect(copy).toMatchObject({
          revision: 1,
          replayed: false,
          spaceId: cell.operation === 'source' ? world.crossSpace : world.spaces[target],
          folderId: cell.operation === 'source' ? null : world.folders[target].id,
        })
      },
    })
  })
})
