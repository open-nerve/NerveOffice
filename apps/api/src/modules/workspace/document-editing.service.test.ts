// 编辑权的接口编排（M3-P1 设计 §3.1、§3.2）：写的三个各一个业务事务、编辑状态一个只读快照；持有者的人名在同一个事务里补上；
// "被占用"转成 EDIT_LEASE_HELD（details 带人名、最后活动时间、是不是自己、是不是这次登录与能不能强制接管）。
// 租约的规则与数据在 documents（edit-lease.service.test.ts）。编辑状态里的异常中断提醒（M3-P5 S2）补上人名；请求编辑与保留还没有接上（S4），一律 null。
import type { EditingActor, LeaseAcquisition, LeaseStatus } from '../documents/index.ts'
import type { User } from '../users/index.ts'
import { acquiredEditLeaseSchema, editLeaseHeldDetailsSchema, editStatusSchema, renewedEditLeaseSchema } from '@nerve-office/contracts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { DocumentEditingService } from './document-editing.service.ts'

const DOCUMENT = '0199a2c4-0000-7000-8000-0000000000d1'
const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'
const TAB = '0199a2c4-0000-7000-8000-0000000000f1'
const TOKEN = `${'a'.repeat(41)}-_`
const ACTOR: EditingActor = { userId: BEN, sessionId: '0199a2c4-0000-7000-8000-0000000000e1' }
const ACTIVE = new Date('2026-10-04T08:00:00.000Z')
const EXPIRES = new Date('2026-10-04T08:01:30.000Z')
/** 页面上报的构建与数据格式（M3-P3）：编排原样交给 documents 核对 */
const FORMAT = { clientBuild: '0.1.0', univerVersion: '1.0.1', profile: 'sheet@1', formatVersion: 1 }
const LEASE_REQUEST = { clientInstanceId: TAB, idleSeconds: 0, format: FORMAT }

function user(id: string): User {
  return { id, username: id === AMY ? 'amy' : 'ben', displayName: id === AMY ? '艾米' : '本', systemRole: 'member', status: 'active' }
}

/** 每一步记进 calls，核对顺序与"都在事务里" */
function setup(acquisition: LeaseAcquisition, status: LeaseStatus = { revision: 3, editor: undefined, canEdit: true, canTakeOver: false, formulasPending: false, interruption: undefined }) {
  const calls: string[] = []
  const transaction = { transaction: true }
  const leases = {
    acquire: vi.fn(async () => {
      calls.push('acquire')
      return acquisition
    }),
    renew: vi.fn(async () => {
      calls.push('renew')
      return { expiresAt: EXPIRES }
    }),
    release: vi.fn(async () => {
      calls.push('release')
    }),
    status: vi.fn(async () => {
      calls.push('status')
      return status
    }),
  }
  const users = {
    findByIds: vi.fn(async (ids: readonly string[]) => {
      calls.push('names')
      return new Map(ids.map(id => [id, user(id)]))
    }),
  }
  const transactions = {
    run: vi.fn(async <T>(work: (transaction: never) => Promise<T>) => {
      calls.push('begin')
      try {
        const result = await work(transaction as never)
        calls.push('commit')
        return result
      }
      catch (error) {
        calls.push('rollback')
        throw error
      }
    }),
    readSnapshot: vi.fn(async <T>(work: (transaction: never) => Promise<T>) => {
      calls.push('snapshot')
      const result = await work(transaction as never)
      calls.push('end snapshot')
      return result
    }),
  }
  const service = new DocumentEditingService(leases as never, users as never, transactions as never)
  return { service, calls, leases, users, transaction }
}

const ACQUIRED: LeaseAcquisition = { kind: 'acquired', token: TOKEN, writeEpoch: 4, revision: 3, source: null, expiresAt: EXPIRES, interruption: undefined, formulasPending: false }
/** 艾米正在编辑（别的登录）：documents 给出的正在编辑的人 */
const AMY_EDITING = { holderId: AMY, lastActiveAt: ACTIVE, sameUser: false, sameSession: false }
/** 补上人名之后 */
const AMY_EDITOR = { holder: { id: AMY, username: 'amy', displayName: '艾米' }, lastActiveAt: ACTIVE.toISOString(), sameUser: false, sameSession: false }
/** M3-P5：还没有接上的两项（S4），与没有异常中断的提醒 */
const NOT_YET = { request: null, reservation: null, interruption: null }

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

describe('DocumentEditingService.acquire', () => {
  it('取得新的一代：一个业务事务里申请，响应是令牌、代次、修订号与它的来源、到期时间（ISO），没有异常结束时提醒为 null', async () => {
    const { service, calls, leases, transaction } = setup(ACQUIRED)
    expect(await service.acquire(ACTOR, DOCUMENT, LEASE_REQUEST)).toEqual({ token: TOKEN, writeEpoch: 4, revision: 3, source: null, expiresAt: EXPIRES.toISOString(), interruption: null, formulasPending: false })
    expect(calls).toEqual(['begin', 'acquire', 'commit'])
    expect(leases.acquire).toHaveBeenCalledWith(ACTOR, DOCUMENT, LEASE_REQUEST, transaction)
  })

  it('"公式待更新"（M3-P3 设计 §3.8）：原样取 documents 读到的文档行上的标记', async () => {
    const { service } = setup({ ...ACQUIRED, formulasPending: true })
    expect((await service.acquire(ACTOR, DOCUMENT, LEASE_REQUEST)).formulasPending).toBe(true)
  })

  it('当前修订有来源（保存产生的）：原样放进响应，结构与修订号冲突的详情相同', async () => {
    const source = { clientInstanceId: TAB, localSeq: 9 }
    const { service } = setup({ ...ACQUIRED, source })
    const acquired = await service.acquire(ACTOR, DOCUMENT, LEASE_REQUEST)
    expect(acquired.source).toEqual(source)
    expect(acquiredEditLeaseSchema.parse(acquired)).toEqual(acquired)
  })

  it('上一个租约异常结束：提醒里补上上一位持有者的人名（同一个事务里），原样带上是不是自己（M3-P5）', async () => {
    for (const sameUser of [false, true]) {
      const { service, calls } = setup({ ...ACQUIRED, interruption: { holderId: AMY, endedAt: ACTIVE, sameUser } })
      const acquired = await service.acquire(ACTOR, DOCUMENT, LEASE_REQUEST)
      expect(acquired.interruption, String(sameUser)).toEqual({ holder: { id: AMY, username: 'amy', displayName: '艾米' }, endedAt: ACTIVE.toISOString(), sameUser })
      expect(acquiredEditLeaseSchema.parse(acquired)).toEqual(acquired)
      expect(calls).toEqual(['begin', 'acquire', 'names', 'commit'])
    }
  })

  it('被占用：409 EDIT_LEASE_HELD，details 带持有者的人名、最后活动时间、是不是自己、是不是这次登录与能不能强制接管（M3-P5），请求编辑还没有接上（null）；人名在事务里补，事务回滚', async () => {
    const { service, calls } = setup({ kind: 'held', ...AMY_EDITING, canTakeOver: false })
    const error = await rejection(service.acquire(ACTOR, DOCUMENT, LEASE_REQUEST))
    expect([error.code, error.status, error.message]).toEqual(['EDIT_LEASE_HELD', 409, '别人正在编辑这份文档'])
    expect(editLeaseHeldDetailsSchema.parse(error.details)).toEqual({ ...AMY_EDITOR, canTakeOver: false, request: null })
    expect(error.details).toEqual(editLeaseHeldDetailsSchema.parse(error.details))
    expect(calls).toEqual(['begin', 'acquire', 'names', 'rollback'])
  })

  it('M3-P5 被占用的详情原样取 documents 给出的 sameUser、sameSession 与 canTakeOver（各自独立，不互相推出）', async () => {
    for (const [sameUser, sameSession, canTakeOver] of [[true, true, false], [true, false, true], [false, false, true]] as const) {
      const { service } = setup({ kind: 'held', ...AMY_EDITING, sameUser, sameSession, canTakeOver })
      const error = await rejection(service.acquire(ACTOR, DOCUMENT, LEASE_REQUEST))
      expect(error.details, `${sameUser} ${sameSession} ${canTakeOver}`).toMatchObject({ sameUser, sameSession, canTakeOver, request: null })
    }
  })
})

describe('DocumentEditingService 的心跳、释放与编辑状态', () => {
  it('心跳：一个业务事务，带上令牌与空闲秒数，返回 ISO 的到期时间；待回应的请求编辑还没有接上（M3-P5 S1：null）', async () => {
    const { service, calls, leases, transaction } = setup(ACQUIRED)
    const renewed = await service.renew(ACTOR, DOCUMENT, { idleSeconds: 42, format: FORMAT }, TOKEN)
    expect(renewed).toEqual({ expiresAt: EXPIRES.toISOString(), request: null })
    expect(renewedEditLeaseSchema.parse(renewed)).toEqual(renewed)
    expect(leases.renew).toHaveBeenCalledWith(ACTOR, DOCUMENT, { idleSeconds: 42, format: FORMAT }, TOKEN, transaction)
    expect(calls).toEqual(['begin', 'renew', 'commit'])
  })

  it('释放：一个业务事务，没带令牌也照样交给 documents（由它什么也不做）', async () => {
    const { service, calls, leases, transaction } = setup(ACQUIRED)
    await service.release(ACTOR, DOCUMENT, undefined)
    expect(leases.release).toHaveBeenCalledWith(ACTOR, DOCUMENT, undefined, transaction)
    expect(calls).toEqual(['begin', 'release', 'commit'])
  })

  it('编辑状态：一个只读快照里判断、读租约、补人名；没人在编辑、也没有提醒时 editor 为 null、不查人名；请求编辑与保留还没有接上（M3-P5 S4：null）', async () => {
    const held = setup(ACQUIRED, { revision: 7, editor: AMY_EDITING, canEdit: true, canTakeOver: false, formulasPending: false, interruption: undefined })
    const status = await held.service.status(ACTOR, DOCUMENT)
    expect(status).toEqual({ revision: 7, editor: AMY_EDITOR, canEdit: true, canTakeOver: false, formulasPending: false, ...NOT_YET })
    expect(editStatusSchema.parse(status)).toEqual(status)
    expect(held.calls).toEqual(['snapshot', 'status', 'names', 'end snapshot'])
    const free = setup(ACQUIRED)
    expect(await free.service.status(ACTOR, DOCUMENT)).toEqual({ revision: 3, editor: null, canEdit: true, canTakeOver: false, formulasPending: false, ...NOT_YET })
    expect(free.calls).toEqual(['snapshot', 'status', 'end snapshot'])
  })

  it('US-M3-10 没人在编辑时的异常中断提醒（M3-P5 设计 §3.5）：补上上一位持有者的人名（同一个快照里），原样带上是不是自己', async () => {
    for (const sameUser of [false, true]) {
      const { service, calls } = setup(ACQUIRED, { revision: 7, editor: undefined, canEdit: true, canTakeOver: false, formulasPending: false, interruption: { holderId: AMY, endedAt: ACTIVE, sameUser } })
      const status = await service.status(ACTOR, DOCUMENT)
      expect(status, String(sameUser)).toEqual({ revision: 7, editor: null, canEdit: true, canTakeOver: false, formulasPending: false, request: null, reservation: null, interruption: { holder: { id: AMY, username: 'amy', displayName: '艾米' }, endedAt: ACTIVE.toISOString(), sameUser } })
      expect(editStatusSchema.parse(status)).toEqual(status)
      expect(calls).toEqual(['snapshot', 'status', 'names', 'end snapshot'])
    }
  })

  it('M3-P5 有人在编辑时提醒一律为 null（正在编辑的人与提醒至多有一个），人名只查正在编辑的人', async () => {
    const { service, calls, users } = setup(ACQUIRED, { revision: 7, editor: AMY_EDITING, canEdit: true, canTakeOver: false, formulasPending: false, interruption: { holderId: BEN, endedAt: ACTIVE, sameUser: true } })
    expect(await service.status(ACTOR, DOCUMENT)).toEqual({ revision: 7, editor: AMY_EDITOR, canEdit: true, canTakeOver: false, formulasPending: false, ...NOT_YET })
    expect(users.findByIds.mock.calls).toEqual([[[AMY], { transaction: true }]])
    expect(calls).toEqual(['snapshot', 'status', 'names', 'end snapshot'])
  })

  it('M3-P5 正在编辑的人原样带上是不是自己、是不是这次登录（documents 算出的两位，各自独立）', async () => {
    for (const [sameUser, sameSession] of [[true, true], [true, false]] as const) {
      const { service } = setup(ACQUIRED, { revision: 7, editor: { ...AMY_EDITING, sameUser, sameSession }, canEdit: true, canTakeOver: false, formulasPending: false, interruption: undefined })
      expect((await service.status(ACTOR, DOCUMENT)).editor, `${sameUser} ${sameSession}`).toEqual({ ...AMY_EDITOR, sameUser, sameSession })
    }
  })

  it('US-M3-05 编辑状态带上能不能编辑（M3-P2 设计 §3.2）、能不能强制接管（M3-P5）：原样取 documents 在同一个快照里算出的那两位，有人在编辑、没人在编辑都一样', async () => {
    const viewer = setup(ACQUIRED, { revision: 7, editor: AMY_EDITING, canEdit: false, canTakeOver: false, formulasPending: false, interruption: undefined })
    expect((await viewer.service.status(ACTOR, DOCUMENT)).canEdit).toBe(false)
    expect((await setup(ACQUIRED, { revision: 7, editor: undefined, canEdit: false, canTakeOver: false, formulasPending: false, interruption: undefined }).service.status(ACTOR, DOCUMENT)).canEdit).toBe(false)
    expect((await setup(ACQUIRED, { revision: 7, editor: undefined, canEdit: true, canTakeOver: false, formulasPending: false, interruption: undefined }).service.status(ACTOR, DOCUMENT)).canEdit).toBe(true)
    for (const editor of [AMY_EDITING, undefined])
      expect((await setup(ACQUIRED, { revision: 7, editor, canEdit: true, canTakeOver: true, formulasPending: false, interruption: undefined }).service.status(ACTOR, DOCUMENT)).canTakeOver, String(editor)).toBe(true)
  })

  it('编辑状态带上"公式待更新"（M3-P3 设计 §3.8）：原样取 documents 在同一个快照里读到的标记', async () => {
    expect((await setup(ACQUIRED, { revision: 7, editor: undefined, canEdit: true, canTakeOver: false, formulasPending: true, interruption: undefined }).service.status(ACTOR, DOCUMENT)).formulasPending).toBe(true)
    expect((await setup(ACQUIRED, { revision: 7, editor: AMY_EDITING, canEdit: true, canTakeOver: false, formulasPending: true, interruption: undefined }).service.status(ACTOR, DOCUMENT)).formulasPending).toBe(true)
  })
})
