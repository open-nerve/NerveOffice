// 权限矩阵：编辑权（M3-P1 设计 §3.2）——编辑状态、申请、心跳续租、释放，以及本人接管与强制接管（M3-P5 设计 §3.7、§3.8）。
// 预期逐格写在表里（00 号计划书 §5.3、§6，P1 设计 §3.2），不调用生产代码的规则来算。每个 404 的格子另与"同一个人对不存在的目标做同一个操作"
// 比较（看不到与不存在一致，语句序列由 hidden-missing-parity 核对）。
// - 编辑状态与释放：能读就行（释放没有租约、令牌不对时什么也不做，照样 204）；
// - 申请、心跳与本人接管：要能编辑——内容权限是编辑者及以上（空间角色与单独授权取较高者），归档的空间里所有人至多是查看者；
//   失去访问与失去编辑权先于租约判断，所以不能编辑的人发心跳得到的是 403 / 404，不是 EDIT_LEASE_LOST；
// - 强制接管：另要能强制接管——空间管理员，个人空间是所有者；只凭授权的人、编辑者、查看者都不能，归档的空间里没有人能。
// 写的格子各用一份新文档（申请会改租约与代次）：心跳与释放先以这个人申请一次，申请得到的令牌拿来续租、释放；申请不了的人带一个
// 格式合法、谁的也不是的令牌——判断访问在租约之前，令牌对不对与这一格的结果无关。本人接管先以这个人在另一个标签页申请一次，
// 强制接管先由只有编辑授权的人申请一次：成功的格子接管的就是那一代（接管标记、审计逐格核对）；申请不了时文档空着，同样与结果无关。
import type { Buffer } from 'node:buffer'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { CellOptions, MatrixActor, MatrixCell, MatrixOperation, MatrixTable, MatrixWorld, Row, TargetName } from './matrix-world.ts'
import { createHash, randomUUID } from 'node:crypto'
import { acquiredEditLeaseSchema, EDIT_LEASE_HEADER, editStatusSchema, renewedEditLeaseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { acquireBody, renewBody } from '../support/client-format.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { asUser } from '../support/session-client.ts'
import { accessViaOf, ACTORS, buildMatrixWorld, cellsOf, closeWorld, columnOf, expectCell, isArchived, TARGETS } from './matrix-world.ts'

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

type Operation = 'editStatus' | 'acquireLease' | 'renewLease' | 'releaseLease' | 'selfTakeover' | 'forceTakeover'

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

/**
 * 强制接管（M3-P5 设计 §3.8）：要能编辑并能强制接管——个人空间只有所有者；团队空间、全员可见的空间只有空间管理员；
 * 编辑者、查看者、两个只凭授权的人（只有编辑授权的人能编辑，也不能接管）都 403；归档的空间里没有人能（看得到的 403、看不到的 404）；
 * 看不到的、不存在的一律 404
 */
const FORCE_TAKEOVER: Readonly<Record<TargetName, Row>> = {
  personal: [201, 404, 404, 404, 404, 404, 403, 403],
  team: [404, 201, 403, 403, 404, 404, 403, 403],
  visible: [403, 201, 403, 403, 403, 403, 403, 403],
  archived: [404, 403, 403, 403, 404, 404, 403, 403],
  archivedVisible: [403, 403, 403, 403, 403, 403, 403, 403],
  missing: [404, 404, 404, 404, 404, 404, 404, 404],
}

const MATRIX: MatrixTable<Operation> = {
  editStatus: readers(200),
  acquireLease: editors(201),
  renewLease: editors(200),
  releaseLease: readers(204),
  // 本人接管（M3-P5 设计 §3.7）只要能编辑：与申请同一个判断
  selfTakeover: editors(201),
  forceTakeover: FORCE_TAKEOVER,
}

/**
 * 能不能强制接管（M3-P5 设计 §3.8，编辑状态的 canTakeOver）：空间管理员——个人空间是所有者，三个团队空间里的 spaceAdmin；
 * 归档的空间里没有人能（所有人至多是查看者），只凭授权的人、编辑者、查看者、外人、没加入的系统管理员都不能。逐格手写，顺序同 ACTORS；
 * 看不到的格子（404）不核对
 */
const TAKE_OVER: Readonly<Record<TargetName, readonly boolean[]>> = {
  personal: [true, false, false, false, false, false, false, false],
  team: [false, true, false, false, false, false, false, false],
  visible: [false, true, false, false, false, false, false, false],
  archived: [false, false, false, false, false, false, false, false],
  archivedVisible: [false, false, false, false, false, false, false, false],
  missing: [false, false, false, false, false, false, false, false],
}

/** 格式合法、谁的也不是的令牌 */
const STRAY_TOKEN = `${'s'.repeat(41)}-_`

/** 写的那一格：文档与先申请到的令牌（申请不了时为 undefined；接管的两行是被接管的那一代的），verify 据此核对 */
let lastWrite: { readonly documentId: string, readonly token: string | undefined } | undefined

function leasePath(documentId: string): string {
  return `/api/documents/${documentId}/edit-lease`
}

/** 以这个人申请一次：申请得到的令牌；申请不了（看不到、不能编辑）时为 undefined */
async function tokenOf(actor: MatrixActor, documentId: string): Promise<string | undefined> {
  const response = await asUser(app.baseUrl, actor.session, leasePath(documentId), { method: 'POST', body: acquireBody(randomUUID()) })
  return response.status === 201 ? parseExact(acquiredEditLeaseSchema, await response.json()).token : undefined
}

const OPERATIONS: Readonly<Record<Operation, MatrixOperation>> = {
  editStatus: async (actor, target) => asUser(app.baseUrl, actor.session, leasePath(world.documents[target].id)),
  acquireLease: async (actor, target) => {
    const document = await world.freshDocument(target)
    lastWrite = { documentId: document.id, token: undefined }
    return asUser(app.baseUrl, actor.session, leasePath(document.id), { method: 'POST', body: acquireBody(randomUUID()) })
  },
  renewLease: async (actor, target) => {
    const document = await world.freshDocument(target)
    const token = await tokenOf(actor, document.id)
    lastWrite = { documentId: document.id, token }
    return asUser(app.baseUrl, actor.session, leasePath(document.id), { method: 'PUT', body: renewBody(0), headers: { [EDIT_LEASE_HEADER]: token ?? STRAY_TOKEN } })
  },
  releaseLease: async (actor, target) => {
    const document = await world.freshDocument(target)
    const token = await tokenOf(actor, document.id)
    lastWrite = { documentId: document.id, token }
    return asUser(app.baseUrl, actor.session, leasePath(document.id), { method: 'DELETE', headers: { [EDIT_LEASE_HEADER]: token ?? STRAY_TOKEN } })
  },
  // 本人接管：这个人先在另一个标签页申请到一代，再从新的标签页以本人接管申请
  selfTakeover: async (actor, target) => {
    const document = await world.freshDocument(target)
    lastWrite = { documentId: document.id, token: await tokenOf(actor, document.id) }
    return asUser(app.baseUrl, actor.session, leasePath(document.id), { method: 'POST', body: { ...acquireBody(randomUUID()), takeover: 'self' } })
  },
  // 强制接管：只有编辑授权的人先申请到一代（他在个人空间、团队空间、全员可见的空间里都能编辑），这个人再强制接管
  forceTakeover: async (actor, target) => {
    const document = await world.freshDocument(target)
    lastWrite = { documentId: document.id, token: await tokenOf(world.actors.grantEditor, document.id) }
    return asUser(app.baseUrl, actor.session, leasePath(document.id), { method: 'POST', body: { ...acquireBody(randomUUID()), takeover: 'force' } })
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

/** 接管的那一格：租约行的持有者、接管方式、接管标记是不是被接管那一代的令牌摘要，以及这份文档上强制接管的审计（操作者与被接管的人） */
async function takeoverOf(documentId: string, takenToken: string | undefined): Promise<{ readonly holderId: string | undefined, readonly takeover: string | null | undefined, readonly marksTaken: boolean, readonly audits: { readonly actorId: string, readonly holderId: string }[] }> {
  return database.query(async (client) => {
    const row = (await client.query<{ holder_id: string, takeover: string | null, taken_over_token_digest: Buffer | null }>(
      'SELECT holder_id, takeover, taken_over_token_digest FROM document_edit_leases WHERE document_id = $1',
      [documentId],
    )).rows[0]
    const audits = (await client.query<{ actorId: string, holderId: string }>(
      `SELECT actor_id AS "actorId", details->>'holderId' AS "holderId" FROM audit_events WHERE action = 'documents.edit_taken_over' AND target_id = $1`,
      [documentId],
    )).rows
    const digest = takenToken === undefined ? undefined : createHash('sha256').update(takenToken, 'utf8').digest()
    return { holderId: row?.holder_id, takeover: row?.takeover, marksTaken: digest !== undefined && row?.taken_over_token_digest?.equals(digest) === true, audits }
  })
}

/** 成功的格子另外核对内容 */
const VERIFY: Readonly<Record<Operation, CellOptions['verify']>> = {
  // 固定的文档上没有人在编辑（写的格子都用新文档）：修订号 1、没有正在编辑的人；能不能编辑（M3-P2）与这个人能不能申请同一格——
  // 取表里申请那一行的预期（MATRIX.acquireLease，逐格手写），不调用生产代码的规则；能不能强制接管取 TAKE_OVER（M3-P5）。
  // 固定的文档上从没有过租约：没有异常中断的提醒（M3-P5 S2）；请求编辑与保留在 S4 接上之前一律 null
  editStatus: async (response, target, actor) => {
    const canEdit = MATRIX.acquireLease[target][columnOf(actor)] === 201
    const canTakeOver = TAKE_OVER[target][columnOf(actor)]
    expect(parseExact(editStatusSchema, await response.json())).toEqual({ revision: 1, editor: null, canEdit, canTakeOver, formulasPending: false, request: null, reservation: null, interruption: null })
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
  // 本人接管：接管了自己在另一个标签页的那一代（第二代，接管标记 self），不写审计
  selfTakeover: async (response, _target, actor) => {
    expect(parseExact(acquiredEditLeaseSchema, await response.json())).toMatchObject({ writeEpoch: 2, revision: 1, interruption: null })
    const { documentId, token } = written()
    expect(await takeoverOf(documentId, token)).toEqual({ holderId: world.actors[actor].id, takeover: 'self', marksTaken: true, audits: [] })
  },
  // 强制接管：接管了只有编辑授权的人那一代（第二代，接管标记 forced），一条审计记着操作者与被接管的人
  forceTakeover: async (response, _target, actor) => {
    expect(parseExact(acquiredEditLeaseSchema, await response.json())).toMatchObject({ writeEpoch: 2, revision: 1, interruption: null })
    const { documentId, token } = written()
    const { id } = world.actors[actor]
    expect(await takeoverOf(documentId, token)).toEqual({ holderId: id, takeover: 'forced', marksTaken: true, audits: [{ actorId: id, holderId: world.actors.grantEditor.id }] })
  },
}

/**
 * 被拒的说明：申请、心跳与本人接管与保存同一条规则（edit），归档的空间里说"空间已归档"，别处是"只能查看"；强制接管先判断能编辑
 * （说法同上），能编辑（申请那一行是 201）却不能强制接管时，只凭授权的人是他自己的说法，别人是"只有空间管理员能"（途径取 ACCESS_VIA，逐格手写）
 */
function deniedMessageOf(cell: MatrixCell<Operation>): string {
  if (isArchived(cell.target))
    return '空间已归档，只能查看'
  if (cell.operation !== 'forceTakeover' || MATRIX.acquireLease[cell.target][columnOf(cell.actor)] !== 201)
    return '只能查看这份文档，不能编辑'
  return accessViaOf(cell.actor, cell.target) === 'grant' ? '这份文档是单独分享给你的，不能强制接管编辑' : '只有空间管理员能强制接管这份文档的编辑'
}

const CELLS = cellsOf(MATRIX)

describe('US-M3-04 权限矩阵：编辑权（编辑状态、申请、心跳续租、释放、本人接管、强制接管）', () => {
  it.each(CELLS)('US-M2-14 $operation：$actor 对 $target → $expected', async (cell) => {
    await expectCell(world, OPERATIONS[cell.operation], cell, { verify: VERIFY[cell.operation], deniedMessage: deniedMessageOf(cell) })
  })

  it('M3-P5 两张手写的表彼此一致：强制接管成功的格子，恰好是编辑状态说能强制接管（canTakeOver）的格子', () => {
    for (const target of TARGETS) {
      for (const actor of ACTORS)
        expect(FORCE_TAKEOVER[target][columnOf(actor)] === 201, `${target} ${actor}`).toBe(TAKE_OVER[target][columnOf(actor)])
    }
  })
})
