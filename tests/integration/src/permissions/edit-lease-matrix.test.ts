// 权限矩阵：编辑权（M3-P1 设计 §3.2）——编辑状态、申请、心跳续租、释放。预期逐格写在表里（00 号计划书 §5.3、§6，P1 设计 §3.2），
// 不调用生产代码的规则来算。每个 404 的格子另与"同一个人对不存在的目标做同一个操作"比较（看不到与不存在一致，语句序列由
// hidden-missing-parity 核对）。
// - 编辑状态与释放：能读就行（释放没有租约、令牌不对时什么也不做，照样 204）；
// - 申请与心跳：要能编辑——内容权限是编辑者及以上（空间角色与单独授权取较高者），归档的空间里所有人至多是查看者；
//   失去访问与失去编辑权先于租约判断，所以不能编辑的人发心跳得到的是 403 / 404，不是 EDIT_LEASE_LOST。
// 写的格子各用一份新文档（申请会改租约与代次）：心跳与释放先以这个人申请一次，申请得到的令牌拿来续租、释放；申请不了的人带一个
// 格式合法、谁的也不是的令牌——判断访问在租约之前，令牌对不对与这一格的结果无关。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { CellOptions, MatrixActor, MatrixCell, MatrixOperation, MatrixTable, MatrixWorld, Row, TargetName } from './matrix-world.ts'
import { randomUUID } from 'node:crypto'
import { acquiredEditLeaseSchema, EDIT_LEASE_HEADER, editStatusSchema, renewedEditLeaseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { asUser } from '../support/session-client.ts'
import { buildMatrixWorld, cellsOf, closeWorld, expectCell, isArchived } from './matrix-world.ts'

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

type Operation = 'editStatus' | 'acquireLease' | 'renewLease' | 'releaseLease'

/**
 * 能读就行（编辑状态 200、释放 204）：个人空间只有所有者与被授权的人；团队空间与归档的空间是成员与被授权的人；
 * 全员可见的两个空间是所有人；不存在的一律 404。两个只凭授权的人在每一份文档上都有授权
 */
function readers(success: 200 | 204): Readonly<Record<TargetName, Row>> {
  return {
    personal: [success, 404, 404, 404, 404, 404, success, success],
    team: [404, success, success, success, 404, 404, success, success],
    visible: [success, success, success, success, success, success, success, success],
    archived: [404, success, success, success, 404, 404, success, success],
    archivedVisible: [success, success, success, success, success, success, success, success],
    missing: [404, 404, 404, 404, 404, 404, 404, 404],
  }
}

/**
 * 要能编辑（申请 201、续租 200）：内容权限是编辑者及以上。查看者（含全员可见给的、只有查看授权的）看得到不能编辑，403；
 * 只有编辑授权的人在个人空间、团队空间、全员可见的空间里能编辑；归档的空间里所有人至多是查看者，403；看不到的 404
 */
function editors(success: 200 | 201): Readonly<Record<TargetName, Row>> {
  return {
    personal: [success, 404, 404, 404, 404, 404, 403, success],
    team: [404, success, success, 403, 404, 404, 403, success],
    visible: [403, success, success, 403, 403, 403, 403, success],
    archived: [404, 403, 403, 403, 404, 404, 403, 403],
    archivedVisible: [403, 403, 403, 403, 403, 403, 403, 403],
    missing: [404, 404, 404, 404, 404, 404, 404, 404],
  }
}

const MATRIX: MatrixTable<Operation> = {
  editStatus: readers(200),
  acquireLease: editors(201),
  renewLease: editors(200),
  releaseLease: readers(204),
}

/** 格式合法、谁的也不是的令牌 */
const STRAY_TOKEN = `${'s'.repeat(41)}-_`

/** 写的那一格：文档与这个人申请到的令牌（申请不了时为 undefined），verify 据此核对 */
let lastWrite: { readonly documentId: string, readonly token: string | undefined } | undefined

function leasePath(documentId: string): string {
  return `/api/documents/${documentId}/edit-lease`
}

/** 以这个人申请一次：申请得到的令牌；申请不了（看不到、不能编辑）时为 undefined */
async function tokenOf(actor: MatrixActor, documentId: string): Promise<string | undefined> {
  const response = await asUser(app.baseUrl, actor.session, leasePath(documentId), { method: 'POST', body: { clientInstanceId: randomUUID() } })
  return response.status === 201 ? parseExact(acquiredEditLeaseSchema, await response.json()).token : undefined
}

const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
  editStatus: async (actor, target) => asUser(app.baseUrl, actor.session, leasePath(world.documents[target].id)),
  acquireLease: async (actor, target) => {
    const document = await world.freshDocument(target)
    lastWrite = { documentId: document.id, token: undefined }
    return asUser(app.baseUrl, actor.session, leasePath(document.id), { method: 'POST', body: { clientInstanceId: randomUUID() } })
  },
  renewLease: async (actor, target) => {
    const document = await world.freshDocument(target)
    const token = await tokenOf(actor, document.id)
    lastWrite = { documentId: document.id, token }
    return asUser(app.baseUrl, actor.session, leasePath(document.id), { method: 'PUT', body: { idleSeconds: 0 }, headers: { [EDIT_LEASE_HEADER]: token ?? STRAY_TOKEN } })
  },
  releaseLease: async (actor, target) => {
    const document = await world.freshDocument(target)
    const token = await tokenOf(actor, document.id)
    lastWrite = { documentId: document.id, token }
    return asUser(app.baseUrl, actor.session, leasePath(document.id), { method: 'DELETE', headers: { [EDIT_LEASE_HEADER]: token ?? STRAY_TOKEN } })
  },
}

/** 这份文档的租约行：持有者与明确结束的原因，没有时为 undefined（直接查库） */
async function leaseOf(documentId: string): Promise<{ readonly holder_id: string, readonly end_reason: string | null } | undefined> {
  return database.query(async client => (await client.query<{ holder_id: string, end_reason: string | null }>(
    'SELECT holder_id, end_reason FROM document_edit_leases WHERE document_id = $1',
    [documentId],
  )).rows[0])
}

function written(): { readonly documentId: string, readonly token: string | undefined } {
  if (lastWrite === undefined)
    throw new Error('没有记下写的那一格')
  return lastWrite
}

/** 成功的格子另外核对内容 */
const VERIFY: Readonly<Record<Operation, CellOptions['verify']>> = {
  // 固定的文档上没有人在编辑（写的格子都用新文档）：修订号 1、没有正在编辑的人
  editStatus: async (response) => {
    expect(parseExact(editStatusSchema, await response.json())).toEqual({ revision: 1, editor: null })
  },
  // 申请：第一代（新文档的代次是 0），租约在这个人手里
  acquireLease: async (response, _target, actor) => {
    const lease = parseExact(acquiredEditLeaseSchema, await response.json())
    expect(lease).toMatchObject({ writeEpoch: 1, revision: 1, interruption: null })
    expect(await leaseOf(written().documentId)).toEqual({ holder_id: world.actors[actor].id, end_reason: null })
  },
  renewLease: async (response, _target, actor) => {
    parseExact(renewedEditLeaseSchema, await response.json())
    expect(await leaseOf(written().documentId)).toEqual({ holder_id: world.actors[actor].id, end_reason: null })
  },
  // 释放：申请到了的人释放掉自己的租约；能读不能编辑的人没有租约，什么也没写
  releaseLease: async (response, _target, actor) => {
    expect(await response.text()).toBe('')
    const { documentId, token } = written()
    expect(await leaseOf(documentId)).toEqual(token === undefined ? undefined : { holder_id: world.actors[actor].id, end_reason: 'released' })
  },
}

/** 申请与心跳被拒的说明：与保存同一条规则（edit），归档的空间里说"空间已归档"，别处是"只能查看" */
function deniedMessageOf(cell: MatrixCell<Operation>): string {
  return isArchived(cell.target) ? '空间已归档，只能查看' : '只能查看这份文档，不能保存'
}

const CELLS = cellsOf(MATRIX)

describe('US-M3-04 权限矩阵：编辑权（编辑状态、申请、心跳续租、释放）', () => {
  it.each(CELLS)('US-M2-14 $operation：$actor 对 $target → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell, { verify: VERIFY[cell.operation], deniedMessage: deniedMessageOf(cell) })
  })
})
