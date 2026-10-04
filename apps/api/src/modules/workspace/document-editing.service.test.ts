// 编辑权的接口编排（M3-P1 设计 §3.1、§3.2）：写的三个各一个业务事务、编辑状态一个只读快照；持有者的人名在同一个事务里补上；
// "被占用"转成 EDIT_LEASE_HELD（details 带人名、最后活动时间与是不是自己）。租约的规则与数据在 documents（edit-lease.service.test.ts）。
import type { EditingActor, LeaseAcquisition, LeaseStatus } from '../documents/index.ts'
import type { User } from '../users/index.ts'
import { acquiredEditLeaseSchema, editLeaseHeldDetailsSchema } from '@nerve-office/contracts'
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

function user(id: string): User {
  return { id, username: id === AMY ? 'amy' : 'ben', displayName: id === AMY ? '艾米' : '本', systemRole: 'member', status: 'active' }
}

/** 每一步记进 calls，核对顺序与"都在事务里" */
function setup(acquisition: LeaseAcquisition, status: LeaseStatus = { revision: 3, editor: undefined, canEdit: true }) {
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

const ACQUIRED: LeaseAcquisition = { kind: 'acquired', token: TOKEN, writeEpoch: 4, revision: 3, source: null, expiresAt: EXPIRES, interruption: undefined }

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

describe('DocumentEditingService.acquire', () => {
  it('取得新的一代：一个业务事务里申请，响应是令牌、代次、修订号与它的来源、到期时间（ISO），没有异常结束时提醒为 null', async () => {
    const { service, calls, leases, transaction } = setup(ACQUIRED)
    expect(await service.acquire(ACTOR, DOCUMENT, TAB)).toEqual({ token: TOKEN, writeEpoch: 4, revision: 3, source: null, expiresAt: EXPIRES.toISOString(), interruption: null })
    expect(calls).toEqual(['begin', 'acquire', 'commit'])
    expect(leases.acquire).toHaveBeenCalledWith(ACTOR, DOCUMENT, TAB, transaction)
  })

  it('当前修订有来源（保存产生的）：原样放进响应，结构与修订号冲突的详情相同', async () => {
    const source = { clientInstanceId: TAB, localSeq: 9 }
    const { service } = setup({ ...ACQUIRED, source })
    const acquired = await service.acquire(ACTOR, DOCUMENT, TAB)
    expect(acquired.source).toEqual(source)
    expect(acquiredEditLeaseSchema.parse(acquired)).toEqual(acquired)
  })

  it('上一个租约异常结束：提醒里补上上一位持有者的人名（同一个事务里）', async () => {
    const { service, calls } = setup({ ...ACQUIRED, interruption: { holderId: AMY, endedAt: ACTIVE } })
    expect((await service.acquire(ACTOR, DOCUMENT, TAB)).interruption).toEqual({ holder: { id: AMY, username: 'amy', displayName: '艾米' }, endedAt: ACTIVE.toISOString() })
    expect(calls).toEqual(['begin', 'acquire', 'names', 'commit'])
  })

  it('被占用：409 EDIT_LEASE_HELD，details 带持有者的人名、最后活动时间与是不是自己；人名在事务里补，事务回滚', async () => {
    const { service, calls } = setup({ kind: 'held', holderId: AMY, lastActiveAt: ACTIVE, sameUser: false })
    const error = await rejection(service.acquire(ACTOR, DOCUMENT, TAB))
    expect([error.code, error.status, error.message]).toEqual(['EDIT_LEASE_HELD', 409, '别人正在编辑这份文档'])
    expect(editLeaseHeldDetailsSchema.parse(error.details)).toEqual({ holder: { id: AMY, username: 'amy', displayName: '艾米' }, lastActiveAt: ACTIVE.toISOString(), sameUser: false })
    expect(error.details).toEqual(editLeaseHeldDetailsSchema.parse(error.details))
    expect(calls).toEqual(['begin', 'acquire', 'names', 'rollback'])
  })
})

describe('DocumentEditingService 的心跳、释放与编辑状态', () => {
  it('心跳：一个业务事务，带上令牌与空闲秒数，返回 ISO 的到期时间', async () => {
    const { service, calls, leases, transaction } = setup(ACQUIRED)
    expect(await service.renew(ACTOR, DOCUMENT, 42, TOKEN)).toEqual({ expiresAt: EXPIRES.toISOString() })
    expect(leases.renew).toHaveBeenCalledWith(ACTOR, DOCUMENT, 42, TOKEN, transaction)
    expect(calls).toEqual(['begin', 'renew', 'commit'])
  })

  it('释放：一个业务事务，没带令牌也照样交给 documents（由它什么也不做）', async () => {
    const { service, calls, leases, transaction } = setup(ACQUIRED)
    await service.release(ACTOR, DOCUMENT, undefined)
    expect(leases.release).toHaveBeenCalledWith(ACTOR, DOCUMENT, undefined, transaction)
    expect(calls).toEqual(['begin', 'release', 'commit'])
  })

  it('编辑状态：一个只读快照里判断、读租约、补人名；没有有效的租约时 editor 为 null、不查人名', async () => {
    const held = setup(ACQUIRED, { revision: 7, editor: { holderId: AMY, lastActiveAt: ACTIVE, sameUser: false }, canEdit: true })
    expect(await held.service.status(ACTOR, DOCUMENT)).toEqual({ revision: 7, editor: { holder: { id: AMY, username: 'amy', displayName: '艾米' }, lastActiveAt: ACTIVE.toISOString(), sameUser: false }, canEdit: true })
    expect(held.calls).toEqual(['snapshot', 'status', 'names', 'end snapshot'])
    const free = setup(ACQUIRED)
    expect(await free.service.status(ACTOR, DOCUMENT)).toEqual({ revision: 3, editor: null, canEdit: true })
    expect(free.calls).toEqual(['snapshot', 'status', 'end snapshot'])
  })

  it('US-M3-05 编辑状态带上能不能编辑（M3-P2 设计 §3.2）：原样取 documents 在同一个快照里算出的那一位，有人在编辑、没人在编辑都一样', async () => {
    const viewer = setup(ACQUIRED, { revision: 7, editor: { holderId: AMY, lastActiveAt: ACTIVE, sameUser: false }, canEdit: false })
    expect((await viewer.service.status(ACTOR, DOCUMENT)).canEdit).toBe(false)
    expect((await setup(ACQUIRED, { revision: 7, editor: undefined, canEdit: false }).service.status(ACTOR, DOCUMENT)).canEdit).toBe(false)
    expect((await setup(ACQUIRED, { revision: 7, editor: undefined, canEdit: true }).service.status(ACTOR, DOCUMENT)).canEdit).toBe(true)
  })
})
