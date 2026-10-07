// 编辑权的接口编排（M3-P1 设计 §3.1、§3.2）：写的几个各一个业务事务、编辑状态一个只读快照；持有者的人名在同一个事务里补上；
// "被占用"转成 EDIT_LEASE_HELD（details 带人名、最后活动时间、是不是自己、是不是这次登录、能不能强制接管与有没有人在请求编辑），
// 交出之后的保留挡住的申请转成 EDIT_LEASE_RESERVED（M3-P5 S4）。
// 租约的规则与数据在 documents（edit-lease.service.test.ts、edit-request.service.test.ts）。编辑状态里的异常中断提醒（M3-P5 S2）、
// 请求编辑与保留（S4）补上人名，一个响应要的人名一次查齐。本人接管与强制接管（M3-P5 S3）的判断与审计都在 documents，
// 这里只把接管方式与请求的来源原样交过去；请求编辑的发出、续期、取消、谢绝与交出（S4）同样只开事务、补人名、拼响应。
import type { EditingActor, LeaseAcquisition, LeaseRenewal, LeaseStatus, RequestOutcome } from '../documents/index.ts'
import type { User } from '../users/index.ts'
import { acquiredEditLeaseSchema, editLeaseHeldDetailsSchema, editLeaseReservedDetailsSchema, editRequestOutcomeSchema, editStatusSchema, handedOverEditLeaseSchema, renewedEditLeaseSchema } from '@nerve-office/contracts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { DocumentEditingService } from './document-editing.service.ts'

const DOCUMENT = '0199a2c4-0000-7000-8000-0000000000d1'
const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'
/** 第三个人（请求编辑的人） */
const CAT = '0199a2c4-0000-7000-8000-00000000000c'
const REQUEST = '0199a2c4-0000-7000-8000-0000000000aa'
const TAB = '0199a2c4-0000-7000-8000-0000000000f1'
const TOKEN = `${'a'.repeat(41)}-_`
const ACTOR: EditingActor = { userId: BEN, sessionId: '0199a2c4-0000-7000-8000-0000000000e1' }
const ACTIVE = new Date('2026-10-04T08:00:00.000Z')
const EXPIRES = new Date('2026-10-04T08:01:30.000Z')
/** 页面上报的构建与数据格式（M3-P3）：编排原样交给 documents 核对 */
const FORMAT = { clientBuild: '0.1.0', univerVersion: '1.0.1', profile: 'sheet@1', formatVersion: 1 }
const LEASE_REQUEST = { clientInstanceId: TAB, takeover: undefined, idleSeconds: 0, format: FORMAT }
/** 请求的来源（M3-P5：强制接管的审计由 documents 写，编排原样交过去） */
const ORIGIN = { source: 'http', requestId: 'req-1', clientIp: '127.0.0.1' } as const

const NAMES: Readonly<Record<string, readonly [string, string]>> = { [AMY]: ['amy', '艾米'], [BEN]: ['ben', '本'], [CAT]: ['cat', '凯特'] }

function user(id: string): User {
  const [username, displayName] = NAMES[id] ?? ['someone', '某人']
  return { id, username, displayName, systemRole: 'member', status: 'active' }
}

/** 补上人名之后的"人" */
function summary(id: string) {
  const { username, displayName } = user(id)
  return { id, username, displayName }
}

/** 每一步记进 calls，核对顺序与"都在事务里" */
function setup(acquisition: LeaseAcquisition, status: LeaseStatus = { revision: 3, editor: undefined, canEdit: true, canTakeOver: false, formulasPending: false, request: undefined, reservation: undefined, interruption: undefined }, outcome: RequestOutcome = { kind: 'free' }, renewal: LeaseRenewal = { expiresAt: EXPIRES, request: undefined }) {
  const calls: string[] = []
  const transaction = { transaction: true }
  const leases = {
    acquire: vi.fn(async () => {
      calls.push('acquire')
      return acquisition
    }),
    renew: vi.fn(async () => {
      calls.push('renew')
      return renewal
    }),
    release: vi.fn(async () => {
      calls.push('release')
    }),
    status: vi.fn(async () => {
      calls.push('status')
      return status
    }),
  }
  const requests = {
    send: vi.fn(async () => {
      calls.push('send')
      return outcome
    }),
    renew: vi.fn(async () => {
      calls.push('renew request')
      return outcome
    }),
    cancel: vi.fn(async () => {
      calls.push('cancel')
    }),
    decline: vi.fn(async () => {
      calls.push('decline')
    }),
    handOver: vi.fn(async () => {
      calls.push('hand over')
      return { reservedFor: CAT, reservedUntil: EXPIRES }
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
  const service = new DocumentEditingService(leases as never, requests as never, users as never, transactions as never)
  return { service, calls, leases, requests, users, transaction }
}

const ACQUIRED: LeaseAcquisition = { kind: 'acquired', token: TOKEN, writeEpoch: 4, revision: 3, source: null, expiresAt: EXPIRES, interruption: undefined, formulasPending: false }
/** 艾米正在编辑（别的登录）：documents 给出的正在编辑的人 */
const AMY_EDITING = { holderId: AMY, lastActiveAt: ACTIVE, sameUser: false, sameSession: false }
/** 补上人名之后 */
const AMY_EDITOR = { holder: { id: AMY, username: 'amy', displayName: '艾米' }, lastActiveAt: ACTIVE.toISOString(), sameUser: false, sameSession: false }
/** M3-P5：没有人在请求编辑、没有交出之后的保留、没有异常中断的提醒 */
const NOT_YET = { request: null, reservation: null, interruption: null }

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

describe('DocumentEditingService.acquire', () => {
  it('取得新的一代：一个业务事务里申请，响应是令牌、代次、修订号与它的来源、到期时间（ISO），没有异常结束时提醒为 null；请求（含接管方式）与请求的来源原样交给 documents（M3-P5：强制接管的审计用它）', async () => {
    const { service, calls, leases, transaction } = setup(ACQUIRED)
    expect(await service.acquire(ACTOR, DOCUMENT, LEASE_REQUEST, ORIGIN)).toEqual({ token: TOKEN, writeEpoch: 4, revision: 3, source: null, expiresAt: EXPIRES.toISOString(), interruption: null, formulasPending: false })
    expect(calls).toEqual(['begin', 'acquire', 'commit'])
    expect(leases.acquire).toHaveBeenCalledWith(ACTOR, DOCUMENT, LEASE_REQUEST, ORIGIN, transaction)
    const forcing = { ...LEASE_REQUEST, takeover: 'force' } as const
    await service.acquire(ACTOR, DOCUMENT, forcing, ORIGIN)
    expect(leases.acquire).toHaveBeenLastCalledWith(ACTOR, DOCUMENT, forcing, ORIGIN, transaction)
  })

  it('"公式待更新"（M3-P3 设计 §3.8）：原样取 documents 读到的文档行上的标记', async () => {
    const { service } = setup({ ...ACQUIRED, formulasPending: true })
    expect((await service.acquire(ACTOR, DOCUMENT, LEASE_REQUEST, ORIGIN)).formulasPending).toBe(true)
  })

  it('当前修订有来源（保存产生的）：原样放进响应，结构与修订号冲突的详情相同', async () => {
    const source = { clientInstanceId: TAB, localSeq: 9 }
    const { service } = setup({ ...ACQUIRED, source })
    const acquired = await service.acquire(ACTOR, DOCUMENT, LEASE_REQUEST, ORIGIN)
    expect(acquired.source).toEqual(source)
    expect(acquiredEditLeaseSchema.parse(acquired)).toEqual(acquired)
  })

  it('上一个租约异常结束：提醒里补上上一位持有者的人名（同一个事务里），原样带上是不是自己（M3-P5）与是不是这个页面自己的那一代（审查之后）', async () => {
    for (const [sameUser, samePage] of [[false, false], [true, false], [true, true]] as const) {
      const { service, calls } = setup({ ...ACQUIRED, interruption: { holderId: AMY, endedAt: ACTIVE, sameUser, samePage } })
      const acquired = await service.acquire(ACTOR, DOCUMENT, LEASE_REQUEST, ORIGIN)
      expect(acquired.interruption, `${sameUser} ${samePage}`).toEqual({ holder: { id: AMY, username: 'amy', displayName: '艾米' }, endedAt: ACTIVE.toISOString(), sameUser, samePage })
      expect(acquiredEditLeaseSchema.parse(acquired)).toEqual(acquired)
      expect(calls).toEqual(['begin', 'acquire', 'names', 'commit'])
    }
  })

  it('被占用：409 EDIT_LEASE_HELD，details 带持有者的人名、最后活动时间、是不是自己、是不是这次登录与能不能强制接管（M3-P5），没人在请求编辑时 request 为 null；人名在事务里补，事务回滚', async () => {
    const { service, calls } = setup({ kind: 'held', ...AMY_EDITING, canTakeOver: false, request: undefined })
    const error = await rejection(service.acquire(ACTOR, DOCUMENT, LEASE_REQUEST, ORIGIN))
    expect([error.code, error.status, error.message]).toEqual(['EDIT_LEASE_HELD', 409, '别人正在编辑这份文档'])
    expect(editLeaseHeldDetailsSchema.parse(error.details)).toEqual({ ...AMY_EDITOR, canTakeOver: false, request: null })
    expect(error.details).toEqual(editLeaseHeldDetailsSchema.parse(error.details))
    expect(calls).toEqual(['begin', 'acquire', 'names', 'rollback'])
  })

  it('US-M3-06 被占用时有人在请求编辑：details 的 request 补上请求方的人名、发出的时刻与是不是调用者自己——与持有者的人名一次查齐', async () => {
    for (const mine of [false, true]) {
      const { service, users } = setup({ kind: 'held', ...AMY_EDITING, canTakeOver: false, request: { requesterId: CAT, requestedAt: ACTIVE, mine } })
      const error = await rejection(service.acquire(ACTOR, DOCUMENT, LEASE_REQUEST, ORIGIN))
      expect(editLeaseHeldDetailsSchema.parse(error.details), String(mine)).toEqual({ ...AMY_EDITOR, canTakeOver: false, request: { requester: summary(CAT), requestedAt: ACTIVE.toISOString(), mine } })
      expect(users.findByIds.mock.calls).toEqual([[[AMY, CAT], { transaction: true }]])
    }
  })

  it('US-M3-06 编辑权刚交给了别人（保留期内）：409 EDIT_LEASE_RESERVED，details 是留给的人的人名与留到何时（契约逐字）；人名在事务里补，事务回滚', async () => {
    const { service, calls } = setup({ kind: 'reserved', reservedFor: CAT, reservedUntil: EXPIRES })
    const error = await rejection(service.acquire(ACTOR, DOCUMENT, LEASE_REQUEST, ORIGIN))
    expect([error.code, error.status, error.message]).toEqual(['EDIT_LEASE_RESERVED', 409, '编辑权刚交给了别人，请稍后再试'])
    expect(error.details).toEqual({ reservedFor: summary(CAT), reservedUntil: EXPIRES.toISOString() })
    expect(editLeaseReservedDetailsSchema.parse(error.details)).toEqual(error.details)
    expect(calls).toEqual(['begin', 'acquire', 'names', 'rollback'])
  })

  it('M3-P5 被占用的详情原样取 documents 给出的 sameUser、sameSession 与 canTakeOver（各自独立，不互相推出）', async () => {
    for (const [sameUser, sameSession, canTakeOver] of [[true, true, false], [true, false, true], [false, false, true]] as const) {
      const { service } = setup({ kind: 'held', ...AMY_EDITING, sameUser, sameSession, canTakeOver, request: undefined })
      const error = await rejection(service.acquire(ACTOR, DOCUMENT, LEASE_REQUEST, ORIGIN))
      expect(error.details, `${sameUser} ${sameSession} ${canTakeOver}`).toMatchObject({ sameUser, sameSession, canTakeOver, request: null })
    }
  })
})

describe('DocumentEditingService 的心跳、释放与编辑状态', () => {
  it('心跳：一个业务事务，带上令牌与空闲秒数，返回 ISO 的到期时间；没有待回应的请求编辑时 request 为 null、不查人名', async () => {
    const { service, calls, leases, transaction } = setup(ACQUIRED)
    const renewed = await service.renew(ACTOR, DOCUMENT, { idleSeconds: 42, format: FORMAT }, TOKEN)
    expect(renewed).toEqual({ expiresAt: EXPIRES.toISOString(), request: null })
    expect(renewedEditLeaseSchema.parse(renewed)).toEqual(renewed)
    expect(leases.renew).toHaveBeenCalledWith(ACTOR, DOCUMENT, { idleSeconds: 42, format: FORMAT }, TOKEN, transaction)
    expect(calls).toEqual(['begin', 'renew', 'commit'])
  })

  it('US-M3-06 心跳带上待回应的请求编辑（M3-P5 设计 §3.3）：标识、请求方的人名（同一个事务里补）、发出的时刻', async () => {
    const { service, calls } = setup(ACQUIRED, undefined, undefined, { expiresAt: EXPIRES, request: { id: REQUEST, requesterId: CAT, requestedAt: ACTIVE } })
    const renewed = await service.renew(ACTOR, DOCUMENT, { idleSeconds: 0, format: FORMAT }, TOKEN)
    expect(renewed).toEqual({ expiresAt: EXPIRES.toISOString(), request: { id: REQUEST, requester: summary(CAT), requestedAt: ACTIVE.toISOString() } })
    expect(renewedEditLeaseSchema.parse(renewed)).toEqual(renewed)
    expect(calls).toEqual(['begin', 'renew', 'names', 'commit'])
  })

  it('释放：一个业务事务，没带令牌也照样交给 documents（由它什么也不做）', async () => {
    const { service, calls, leases, transaction } = setup(ACQUIRED)
    await service.release(ACTOR, DOCUMENT, undefined)
    expect(leases.release).toHaveBeenCalledWith(ACTOR, DOCUMENT, undefined, transaction)
    expect(calls).toEqual(['begin', 'release', 'commit'])
  })

  it('编辑状态：一个只读快照里判断、读租约、补人名；没人在编辑、也没有提醒、请求与保留时 editor 为 null、不查人名', async () => {
    const held = setup(ACQUIRED, { revision: 7, editor: AMY_EDITING, canEdit: true, canTakeOver: false, formulasPending: false, request: undefined, reservation: undefined, interruption: undefined })
    const status = await held.service.status(ACTOR, DOCUMENT)
    expect(status).toEqual({ revision: 7, editor: AMY_EDITOR, canEdit: true, canTakeOver: false, formulasPending: false, ...NOT_YET })
    expect(editStatusSchema.parse(status)).toEqual(status)
    expect(held.calls).toEqual(['snapshot', 'status', 'names', 'end snapshot'])
    const free = setup(ACQUIRED)
    expect(await free.service.status(ACTOR, DOCUMENT)).toEqual({ revision: 3, editor: null, canEdit: true, canTakeOver: false, formulasPending: false, ...NOT_YET })
    expect(free.calls).toEqual(['snapshot', 'status', 'end snapshot'])
  })

  it('US-M3-10 没人在编辑时的异常中断提醒（M3-P5 设计 §3.5）：补上上一位持有者的人名（同一个快照里），原样带上是不是自己；不带 samePage（编辑状态没有页面）', async () => {
    for (const sameUser of [false, true]) {
      const { service, calls } = setup(ACQUIRED, { revision: 7, editor: undefined, canEdit: true, canTakeOver: false, formulasPending: false, request: undefined, reservation: undefined, interruption: { holderId: AMY, endedAt: ACTIVE, sameUser, samePage: false } })
      const status = await service.status(ACTOR, DOCUMENT)
      expect(status, String(sameUser)).toEqual({ revision: 7, editor: null, canEdit: true, canTakeOver: false, formulasPending: false, request: null, reservation: null, interruption: { holder: { id: AMY, username: 'amy', displayName: '艾米' }, endedAt: ACTIVE.toISOString(), sameUser } })
      expect(editStatusSchema.parse(status)).toEqual(status)
      expect(calls).toEqual(['snapshot', 'status', 'names', 'end snapshot'])
    }
  })

  it('M3-P5 有人在编辑时提醒一律为 null（正在编辑的人与提醒至多有一个），人名只查正在编辑的人', async () => {
    const { service, calls, users } = setup(ACQUIRED, { revision: 7, editor: AMY_EDITING, canEdit: true, canTakeOver: false, formulasPending: false, request: undefined, reservation: undefined, interruption: { holderId: BEN, endedAt: ACTIVE, sameUser: true, samePage: false } })
    expect(await service.status(ACTOR, DOCUMENT)).toEqual({ revision: 7, editor: AMY_EDITOR, canEdit: true, canTakeOver: false, formulasPending: false, ...NOT_YET })
    expect(users.findByIds.mock.calls).toEqual([[[AMY], { transaction: true }]])
    expect(calls).toEqual(['snapshot', 'status', 'names', 'end snapshot'])
  })

  it('M3-P5 正在编辑的人原样带上是不是自己、是不是这次登录（documents 算出的两位，各自独立）', async () => {
    for (const [sameUser, sameSession] of [[true, true], [true, false]] as const) {
      const { service } = setup(ACQUIRED, { revision: 7, editor: { ...AMY_EDITING, sameUser, sameSession }, canEdit: true, canTakeOver: false, formulasPending: false, request: undefined, reservation: undefined, interruption: undefined })
      expect((await service.status(ACTOR, DOCUMENT)).editor, `${sameUser} ${sameSession}`).toEqual({ ...AMY_EDITOR, sameUser, sameSession })
    }
  })

  it('US-M3-05 编辑状态带上能不能编辑（M3-P2 设计 §3.2）、能不能强制接管（M3-P5）：原样取 documents 在同一个快照里算出的那两位，有人在编辑、没人在编辑都一样', async () => {
    const viewer = setup(ACQUIRED, { revision: 7, editor: AMY_EDITING, canEdit: false, canTakeOver: false, formulasPending: false, request: undefined, reservation: undefined, interruption: undefined })
    expect((await viewer.service.status(ACTOR, DOCUMENT)).canEdit).toBe(false)
    expect((await setup(ACQUIRED, { revision: 7, editor: undefined, canEdit: false, canTakeOver: false, formulasPending: false, request: undefined, reservation: undefined, interruption: undefined }).service.status(ACTOR, DOCUMENT)).canEdit).toBe(false)
    expect((await setup(ACQUIRED, { revision: 7, editor: undefined, canEdit: true, canTakeOver: false, formulasPending: false, request: undefined, reservation: undefined, interruption: undefined }).service.status(ACTOR, DOCUMENT)).canEdit).toBe(true)
    for (const editor of [AMY_EDITING, undefined])
      expect((await setup(ACQUIRED, { revision: 7, editor, canEdit: true, canTakeOver: true, formulasPending: false, request: undefined, reservation: undefined, interruption: undefined }).service.status(ACTOR, DOCUMENT)).canTakeOver, String(editor)).toBe(true)
  })

  it('编辑状态带上"公式待更新"（M3-P3 设计 §3.8）：原样取 documents 在同一个快照里读到的标记', async () => {
    expect((await setup(ACQUIRED, { revision: 7, editor: undefined, canEdit: true, canTakeOver: false, formulasPending: true, request: undefined, reservation: undefined, interruption: undefined }).service.status(ACTOR, DOCUMENT)).formulasPending).toBe(true)
    expect((await setup(ACQUIRED, { revision: 7, editor: AMY_EDITING, canEdit: true, canTakeOver: false, formulasPending: true, request: undefined, reservation: undefined, interruption: undefined }).service.status(ACTOR, DOCUMENT)).formulasPending).toBe(true)
  })
})

describe('US-M3-06 编辑状态里的请求编辑与保留（M3-P5 设计 §3.3）', () => {
  it('有人在请求编辑：request 补上请求方的人名、发出的时刻与是不是调用者自己；与正在编辑的人的人名一次查齐（同一个快照里）', async () => {
    for (const mine of [false, true]) {
      const { service, calls, users } = setup(ACQUIRED, { revision: 7, editor: AMY_EDITING, canEdit: true, canTakeOver: false, formulasPending: false, request: { requesterId: CAT, requestedAt: ACTIVE, mine }, reservation: undefined, interruption: undefined })
      const status = await service.status(ACTOR, DOCUMENT)
      expect(status, String(mine)).toEqual({ revision: 7, editor: AMY_EDITOR, canEdit: true, canTakeOver: false, formulasPending: false, request: { requester: summary(CAT), requestedAt: ACTIVE.toISOString(), mine }, reservation: null, interruption: null })
      expect(editStatusSchema.parse(status)).toEqual(status)
      expect(users.findByIds.mock.calls).toEqual([[[AMY, CAT], { transaction: true }]])
      expect(calls).toEqual(['snapshot', 'status', 'names', 'end snapshot'])
    }
  })

  it('交出之后的保留：reservation 补上留给的人的人名、留到何时与是不是调用者自己；没人在编辑时与异常中断的提醒、请求方的人名一次查齐', async () => {
    const { service, users } = setup(ACQUIRED, { revision: 7, editor: undefined, canEdit: true, canTakeOver: false, formulasPending: false, request: { requesterId: BEN, requestedAt: ACTIVE, mine: true }, reservation: { reservedFor: CAT, reservedUntil: EXPIRES, mine: false }, interruption: { holderId: AMY, endedAt: ACTIVE, sameUser: false, samePage: false } })
    const status = await service.status(ACTOR, DOCUMENT)
    expect(status).toEqual({
      revision: 7,
      editor: null,
      canEdit: true,
      canTakeOver: false,
      formulasPending: false,
      request: { requester: summary(BEN), requestedAt: ACTIVE.toISOString(), mine: true },
      reservation: { reservedFor: summary(CAT), reservedUntil: EXPIRES.toISOString(), mine: false },
      interruption: { holder: summary(AMY), endedAt: ACTIVE.toISOString(), sameUser: false },
    })
    expect(editStatusSchema.parse(status)).toEqual(status)
    expect(users.findByIds.mock.calls).toEqual([[[BEN, CAT, AMY], { transaction: true }]])
  })
})

describe('US-M3-06 请求编辑与交出的编排（M3-P5 设计 §3.4、§3.6）', () => {
  /** documents 交回的每一种结果与补上人名之后的响应（契约逐字） */
  const OUTCOMES: readonly (readonly [RequestOutcome, unknown, readonly string[]])[] = [
    [{ kind: 'pending', id: REQUEST, requestedAt: ACTIVE, expiresAt: EXPIRES, holder: AMY_EDITING }, { kind: 'pending', id: REQUEST, requestedAt: ACTIVE.toISOString(), expiresAt: EXPIRES.toISOString(), holder: AMY_EDITOR }, [AMY]],
    [{ kind: 'declined', id: REQUEST, holder: AMY_EDITING }, { kind: 'declined', id: REQUEST, holder: AMY_EDITOR }, [AMY]],
    [{ kind: 'reserved', reservedUntil: EXPIRES }, { kind: 'reserved', reservedUntil: EXPIRES.toISOString() }, []],
    [{ kind: 'free' }, { kind: 'free' }, []],
    [{ kind: 'self', holder: { ...AMY_EDITING, sameUser: true } }, { kind: 'self', holder: { ...AMY_EDITOR, sameUser: true } }, [AMY]],
    [{ kind: 'occupied', requesterId: CAT, requestedAt: ACTIVE }, { kind: 'occupied', requester: summary(CAT), requestedAt: ACTIVE.toISOString() }, [CAT]],
    [{ kind: 'reservedForOther', reservedFor: CAT, reservedUntil: EXPIRES }, { kind: 'reservedForOther', reservedFor: summary(CAT), reservedUntil: EXPIRES.toISOString() }, [CAT]],
    [{ kind: 'gone', holder: AMY_EDITING }, { kind: 'gone', holder: AMY_EDITOR }, [AMY]],
    [{ kind: 'gone', holder: undefined }, { kind: 'gone', holder: null }, []],
  ]

  it.each(OUTCOMES)('发出与续期的结果 %o：一个业务事务里交给 documents，补上人名（要的人一次查齐，一个也不要时不查），按契约逐字', async (outcome, expected, people) => {
    for (const send of [true, false]) {
      const { service, calls, requests, users, transaction } = setup(ACQUIRED, undefined, outcome)
      const response = send ? await service.sendRequest(ACTOR, DOCUMENT, FORMAT) : await service.renewRequest(ACTOR, DOCUMENT)
      expect(response).toEqual(expected)
      expect(editRequestOutcomeSchema.parse(response)).toEqual(response)
      expect(users.findByIds.mock.calls).toEqual(people.length === 0 ? [] : [[people, transaction]])
      expect(calls).toEqual(['begin', send ? 'send' : 'renew request', ...(people.length === 0 ? [] : ['names']), 'commit'])
      if (send)
        expect(requests.send).toHaveBeenCalledWith(ACTOR, DOCUMENT, FORMAT, transaction)
      else
        expect(requests.renew).toHaveBeenCalledWith(ACTOR, DOCUMENT, transaction)
    }
  })

  it('取消、谢绝：各一个业务事务，原样交给 documents（谢绝带上请求的标识与令牌），不查人名', async () => {
    const { service, calls, requests, transaction } = setup(ACQUIRED)
    await service.cancelRequest(ACTOR, DOCUMENT)
    await service.declineRequest(ACTOR, DOCUMENT, REQUEST, TOKEN)
    expect(requests.cancel).toHaveBeenCalledWith(ACTOR, DOCUMENT, transaction)
    expect(requests.decline).toHaveBeenCalledWith(ACTOR, DOCUMENT, REQUEST, TOKEN, transaction)
    expect(calls).toEqual(['begin', 'cancel', 'commit', 'begin', 'decline', 'commit'])
  })

  it('交出：一个业务事务，带上请求的标识与令牌；响应是留给的人的人名（同一个事务里补）与留到何时，按契约逐字', async () => {
    const { service, calls, requests, transaction } = setup(ACQUIRED)
    const handed = await service.handOver(ACTOR, DOCUMENT, REQUEST, TOKEN)
    expect(handed).toEqual({ reservedFor: summary(CAT), reservedUntil: EXPIRES.toISOString() })
    expect(handedOverEditLeaseSchema.parse(handed)).toEqual(handed)
    expect(requests.handOver).toHaveBeenCalledWith(ACTOR, DOCUMENT, REQUEST, TOKEN, transaction)
    expect(calls).toEqual(['begin', 'hand over', 'names', 'commit'])
  })

  it('documents 抛出的错误（EDIT_REQUEST_GONE、EDIT_LEASE_LOST、CLIENT_OUTDATED……）原样交出去，事务回滚，不查人名', async () => {
    const { service, calls, requests, users } = setup(ACQUIRED)
    requests.handOver.mockRejectedValueOnce(new AppError('EDIT_REQUEST_GONE'))
    expect((await rejection(service.handOver(ACTOR, DOCUMENT, REQUEST, TOKEN))).code).toBe('EDIT_REQUEST_GONE')
    requests.send.mockRejectedValueOnce(new AppError('CLIENT_OUTDATED'))
    expect((await rejection(service.sendRequest(ACTOR, DOCUMENT, FORMAT))).code).toBe('CLIENT_OUTDATED')
    expect(users.findByIds).not.toHaveBeenCalled()
    expect(calls).toEqual(['begin', 'rollback', 'begin', 'rollback'])
  })
})
