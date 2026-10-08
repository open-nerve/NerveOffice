// 请求编辑与交出的服务（M3-P5 设计 §3.4、§3.6）：发出、续期、取消、谢绝与交出的步骤、加锁的先后、每个分支写了什么没写什么、日志。
// 规则本身在 edit-request-rules.test.ts 与 edit-lease-rules.test.ts；SQL、并发与真实的时间在集成测试
// （documents/lease-requests.test.ts、lease-request-locks.test.ts）。
import type { ClientFormat } from '@nerve-office/contracts'
import type { AppError } from '../../shared/errors/app-error.ts'
import type { EditingActor } from './edit-lease.service.ts'
import { EDIT_HANDOVER_RESERVE_SECONDS, EDIT_LEASE_TTL_SECONDS, EDIT_REQUEST_TTL_SECONDS } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { ALICE, BOB, CURRENT_CLIENT, FakeStore, HTTP_ORIGIN, TEAM_SPACE, TRANSACTION } from './documents.test-support.ts'
import { EditLeaseService } from './edit-lease.service.ts'
import { EditRequestService } from './edit-request.service.ts'

const CAROL = '0199a2c4-0000-7000-8000-00000000000c'
const DAVE = '0199a2c4-0000-7000-8000-00000000000d'
const ALICE_SESSION = '0199a2c4-0000-7000-8000-0000000000e1'
const ALICE_OTHER_SESSION = '0199a2c4-0000-7000-8000-0000000000e2'
const BOB_SESSION = '0199a2c4-0000-7000-8000-0000000000e3'
const CAROL_SESSION = '0199a2c4-0000-7000-8000-0000000000e4'
const TAB = '0199a2c4-0000-7000-8000-0000000000f1'
/** 槽里没有的请求标识 */
const STRAY_REQUEST = '0199a2c4-0000-7000-8000-0000000000ff'
const MISSING_DOCUMENT = '0199a2c4-0000-7000-8000-0000000000fe'

const SECOND = 1000
/** 艾米（持有者）、本（请求方）、卡萝尔（第三人） */
const AMY: EditingActor = { userId: ALICE, sessionId: ALICE_SESSION }
const BEN: EditingActor = { userId: BOB, sessionId: BOB_SESSION }
const CAT: EditingActor = { userId: CAROL, sessionId: CAROL_SESSION }

/** 团队空间里的一份文档，艾米、本、卡萝尔都是编辑者，登录都有效；日志收进内存（debug 级） */
function setup() {
  const store = new FakeStore()
  for (const person of [ALICE, BOB, CAROL])
    store.setMember(TEAM_SPACE, person, 'editor')
  for (const session of [ALICE_SESSION, ALICE_OTHER_SESSION, BOB_SESSION, CAROL_SESSION])
    store.activeSessions.add(session)
  const document = store.addDocument({ spaceId: TEAM_SPACE, revision: 3 })
  const lines: string[] = []
  const logger = new AppLogger(createRootLogger({ level: 'debug', destination: { write: (line: string) => void lines.push(line) } }), new RequestContextStore())
  const { documents, revisions, leases, policy, sessions, audit } = store.deps
  const service = new EditRequestService(documents, leases, policy, sessions, store.clientFormats, logger)
  const leaseService = new EditLeaseService(documents, revisions, leases, policy, sessions, store.clientFormats, audit, logger)
  return { store, service, leaseService, document, logs: () => lines.map(line => JSON.parse(line) as Record<string, unknown>), logText: () => lines.join('') }
}

type Setup = ReturnType<typeof setup>

/** 取得一代，返回令牌 */
async function acquired({ leaseService, document }: Setup, actor: EditingActor = AMY): Promise<string> {
  const outcome = await leaseService.acquire(actor, document.id, { clientInstanceId: TAB, takeover: undefined, idleSeconds: 0, format: CURRENT_CLIENT }, HTTP_ORIGIN, TRANSACTION)
  if (outcome.kind !== 'acquired')
    throw new Error('期望取得编辑权')
  return outcome.token
}

/** 让"数据库时间"往后走 */
function later(store: FakeStore, milliseconds: number): void {
  store.databaseNow = new Date(store.databaseNow.getTime() + milliseconds)
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof Error) || !('code' in error))
    throw new Error('期望抛出 AppError', { cause: error })
  return error as AppError
}

/** 一个 vi.fn 第一次被调用时在全部调用里的先后 */
function orderOf(fn: { mock: { invocationCallOrder: number[] } }, index = 0): number {
  return fn.mock.invocationCallOrder[index] ?? Number.POSITIVE_INFINITY
}

/** 艾米在编辑、本发出了请求：返回艾米的令牌与本的请求标识 */
async function requested(setupResult: Setup): Promise<{ readonly token: string, readonly requestId: string }> {
  const token = await acquired(setupResult)
  const outcome = await setupResult.service.send(BEN, setupResult.document.id, CURRENT_CLIENT, TRANSACTION)
  if (outcome.kind !== 'pending')
    throw new Error('期望请求在等待')
  return { token, requestId: outcome.id }
}

/** 这份文档的租约行（用例摆好的） */
function rowOf({ store, document }: Setup) {
  const row = store.leaseRecords.get(document.id)
  if (row === undefined)
    throw new Error('没有租约行')
  return row
}

describe('EditRequestService.send', () => {
  it('别人在编辑、槽空着：写下新的请求（数据库生成的标识、请求方与他这次登录、发出是 now、有效期 now 加 10 分钟），pending 带上正在编辑的人', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    const lease = rowOf(setupResult)
    const outcome = await service.send(BEN, document.id, CURRENT_CLIENT, TRANSACTION)
    const expiresAt = new Date(store.databaseNow.getTime() + EDIT_REQUEST_TTL_SECONDS * SECOND)
    expect(outcome).toEqual({ kind: 'pending', id: rowOf(setupResult).requestId, requestedAt: store.databaseNow, expiresAt, holder: { holderId: ALICE, lastActiveAt: lease.lastActiveAt, sameUser: false, sameSession: false } })
    expect(rowOf(setupResult)).toMatchObject({ requestedBy: BOB, requestSessionId: BOB_SESSION, requestedAt: store.databaseNow, requestExpiresAt: expiresAt, requestDeclinedAt: null })
    expect(store.leases.putRequest).toHaveBeenCalledWith(document.id, BEN, TRANSACTION)
    expect(store.leases.extendRequest).not.toHaveBeenCalled()
  })

  it('先拦旧页面（CLIENT_OUTDATED）：在任何查询之前，看不到、不存在的文档得到同样的回答，什么也不写', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    store.repositories.documents.findById.mockClear()
    for (const documentId of [document.id, MISSING_DOCUMENT]) {
      const error = await rejection(service.send(BEN, documentId, {} satisfies ClientFormat, TRANSACTION))
      expect([error.code, error.details], documentId).toEqual(['CLIENT_OUTDATED', { reason: 'format' }])
    }
    expect(store.repositories.documents.findById).not.toHaveBeenCalled()
    expect(store.leases.lockByDocument).not.toHaveBeenCalled()
    expect(rowOf(setupResult).requestId).toBeNull()
  })

  it('看不到 404、只能查看 403：都在锁租约行之前，什么也不写', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    store.leases.lockByDocument.mockClear()
    expect((await rejection(service.send({ userId: DAVE, sessionId: BOB_SESSION }, document.id, CURRENT_CLIENT, TRANSACTION))).code).toBe('NOT_FOUND')
    expect((await rejection(service.send(BEN, MISSING_DOCUMENT, CURRENT_CLIENT, TRANSACTION))).code).toBe('NOT_FOUND')
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect((await rejection(service.send(BEN, document.id, CURRENT_CLIENT, TRANSACTION))).code).toBe('PERMISSION_DENIED')
    expect(store.leases.lockByDocument).not.toHaveBeenCalled()
    expect(rowOf(setupResult).requestId).toBeNull()
  })

  it('先不加锁判断，再锁租约行，锁下核对这次登录（失效 401，什么也不写），再读文档的代次；不锁文档行', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    store.repositories.documents.lockById.mockClear()
    store.repositories.documents.findById.mockClear()
    store.activeSessions.delete(BOB_SESSION)
    const error = await rejection(service.send(BEN, document.id, CURRENT_CLIENT, TRANSACTION))
    expect([error.code, error.status]).toEqual(['SESSION_EXPIRED', 401])
    expect(rowOf(setupResult).requestId).toBeNull()
    store.activeSessions.add(BOB_SESSION)
    store.sessions.isActive.mockClear()
    store.repositories.documents.findById.mockClear()
    store.leases.lockByDocument.mockClear()
    await service.send(BEN, document.id, CURRENT_CLIENT, TRANSACTION)
    const { findById } = store.repositories.documents
    const steps = [orderOf(findById, 0), orderOf(store.leases.lockByDocument), orderOf(store.sessions.isActive), orderOf(findById, 1), orderOf(store.leases.putRequest)]
    expect(steps).toEqual(steps.toSorted((a, b) => a - b))
    expect(store.sessions.isActive).toHaveBeenNthCalledWith(1, BOB_SESSION, TRANSACTION)
    expect(store.repositories.documents.lockById).not.toHaveBeenCalled()
  })

  it('锁住租约行之前文档被删（进了回收站）：按读不到回答（NOT_FOUND），什么也不写', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    store.leases.lockByDocument.mockImplementationOnce(async (id: string) => {
      const lease = store.leaseRecords.get(id)
      store.documentEntries.set(id, 'trash-entry-1')
      return lease === undefined ? undefined : { ...lease, now: store.databaseNow }
    })
    expect((await rejection(service.send(BEN, document.id, CURRENT_CLIENT, TRANSACTION))).code).toBe('NOT_FOUND')
    expect(store.leases.putRequest).not.toHaveBeenCalled()
  })

  it('槽里本来就是调用者待回应的请求：只续期（标识与发出的时刻不变，有效期往后推），不换新的', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { requestId } = await requested(setupResult)
    const requestedAt = rowOf(setupResult).requestedAt
    later(store, 60 * SECOND)
    const outcome = await service.send(BEN, document.id, CURRENT_CLIENT, TRANSACTION)
    expect(outcome).toMatchObject({ kind: 'pending', id: requestId, requestedAt, expiresAt: new Date(store.databaseNow.getTime() + EDIT_REQUEST_TTL_SECONDS * SECOND) })
    expect(store.leases.putRequest).toHaveBeenCalledTimes(1)
    expect(store.leases.extendRequest).toHaveBeenCalledTimes(1)
  })

  it('被谢绝之后显式再点一次：换成一个新的请求（新的标识，谢绝清掉）', async () => {
    const setupResult = setup()
    const { service, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    await service.decline(AMY, document.id, requestId, token, TRANSACTION)
    const outcome = await service.send(BEN, document.id, CURRENT_CLIENT, TRANSACTION)
    expect(outcome.kind).toBe('pending')
    expect(outcome.kind === 'pending' && outcome.id).not.toBe(requestId)
    expect(rowOf(setupResult)).toMatchObject({ requestedBy: BOB, requestDeclinedAt: null })
  })

  it('槽里是别人待回应的请求：occupied（先请求的人与时刻），不写', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await requested(setupResult)
    const before = rowOf(setupResult)
    expect(await service.send(CAT, document.id, CURRENT_CLIENT, TRANSACTION)).toEqual({ kind: 'occupied', requesterId: BOB, requestedAt: before.requestedAt })
    expect(rowOf(setupResult)).toEqual(before)
    expect(store.leases.putRequest).toHaveBeenCalledTimes(1)
  })

  it('占着的是调用者自己（别的标签页或设备）：self（正在编辑的人，sameUser 为真），不写', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    expect(await service.send({ userId: ALICE, sessionId: ALICE_OTHER_SESSION }, document.id, CURRENT_CLIENT, TRANSACTION)).toMatchObject({ kind: 'self', holder: { holderId: ALICE, sameUser: true, sameSession: false } })
    expect(store.leases.putRequest).not.toHaveBeenCalled()
  })

  it('没人在编辑：free，不写（没有租约行、租约到期都一样）', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    expect(await service.send(BEN, document.id, CURRENT_CLIENT, TRANSACTION)).toEqual({ kind: 'free' })
    await acquired(setupResult)
    later(store, EDIT_LEASE_TTL_SECONDS * SECOND)
    expect(await service.send(BEN, document.id, CURRENT_CLIENT, TRANSACTION)).toEqual({ kind: 'free' })
    expect(store.leases.putRequest).not.toHaveBeenCalled()
  })

  it('交出之后的保留：留给调用者——reserved（留到何时）；留给别人——reservedForOther（留给谁、到何时）。都不写', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    await service.handOver(AMY, document.id, requestId, token, TRANSACTION)
    const reservedUntil = new Date(store.databaseNow.getTime() + EDIT_HANDOVER_RESERVE_SECONDS * SECOND)
    expect(await service.send(BEN, document.id, CURRENT_CLIENT, TRANSACTION)).toEqual({ kind: 'reserved', reservedUntil })
    expect(await service.send(CAT, document.id, CURRENT_CLIENT, TRANSACTION)).toEqual({ kind: 'reservedForOther', reservedFor: BOB, reservedUntil })
    expect(store.leases.putRequest).toHaveBeenCalledTimes(1)
  })

  it('日志：发出的结果与写法（新的、续期），不记令牌', async () => {
    const setupResult = setup()
    const { service, document, logs } = setupResult
    await acquired(setupResult)
    await service.send(BEN, document.id, CURRENT_CLIENT, TRANSACTION)
    await service.send(BEN, document.id, CURRENT_CLIENT, TRANSACTION)
    await service.send(CAT, document.id, CURRENT_CLIENT, TRANSACTION)
    expect(logs().filter(entry => entry.msg === '请求编辑：发出').map(entry => [entry.outcome, entry.write])).toEqual([['pending', 'new'], ['pending', 'extend'], ['occupied', undefined]])
  })
})

describe('EditRequestService.renew', () => {
  it('槽里是调用者待回应的请求、别人在编辑：pending，有效期推到 now 加 10 分钟（标识与发出的时刻不变）', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { requestId } = await requested(setupResult)
    const requestedAt = rowOf(setupResult).requestedAt
    later(store, 5 * SECOND)
    const outcome = await service.renew(BEN, document.id, TRANSACTION)
    const expiresAt = new Date(store.databaseNow.getTime() + EDIT_REQUEST_TTL_SECONDS * SECOND)
    expect(outcome).toMatchObject({ kind: 'pending', id: requestId, requestedAt, expiresAt, holder: { holderId: ALICE, sameUser: false } })
    expect(rowOf(setupResult).requestExpiresAt).toEqual(expiresAt)
  })

  it('没人在编辑了（持有者的租约到期、释放了）：free，照样续期', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await requested(setupResult)
    later(store, EDIT_LEASE_TTL_SECONDS * SECOND)
    expect(await service.renew(BEN, document.id, TRANSACTION)).toEqual({ kind: 'free' })
    expect(rowOf(setupResult).requestExpiresAt).toEqual(new Date(store.databaseNow.getTime() + EDIT_REQUEST_TTL_SECONDS * SECOND))
  })

  it('交出给了调用者：reserved（留到何时），不续期（请求已经转成保留）', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    await service.handOver(AMY, document.id, requestId, token, TRANSACTION)
    store.leases.extendRequest.mockClear()
    expect(await service.renew(BEN, document.id, TRANSACTION)).toEqual({ kind: 'reserved', reservedUntil: new Date(store.databaseNow.getTime() + EDIT_HANDOVER_RESERVE_SECONDS * SECOND) })
    expect(store.leases.extendRequest).not.toHaveBeenCalled()
  })

  it('持有者谢绝了：declined（请求的标识与谢绝的人），不续期', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    await service.decline(AMY, document.id, requestId, token, TRANSACTION)
    const before = rowOf(setupResult)
    expect(await service.renew(BEN, document.id, TRANSACTION)).toMatchObject({ kind: 'declined', id: requestId, holder: { holderId: ALICE } })
    expect(rowOf(setupResult)).toEqual(before)
    expect(store.leases.extendRequest).not.toHaveBeenCalled()
  })

  it('槽里不是调用者的请求或它已失效：gone（现在正在编辑的人，没人在编辑时没有），不续期', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    expect(await service.renew(BEN, document.id, TRANSACTION)).toEqual({ kind: 'gone', holder: undefined })
    await requested(setupResult)
    expect(await service.renew(CAT, document.id, TRANSACTION)).toMatchObject({ kind: 'gone', holder: { holderId: ALICE } })
    later(store, EDIT_REQUEST_TTL_SECONDS * SECOND)
    expect(await service.renew(BEN, document.id, TRANSACTION)).toEqual({ kind: 'gone', holder: undefined })
    expect(store.leases.extendRequest).not.toHaveBeenCalled()
  })

  it('要能编辑（404 / 403 在锁租约行之前）；锁下核对这次登录；不拦页面的格式（后台请求不带它）', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await requested(setupResult)
    store.leases.lockByDocument.mockClear()
    expect((await rejection(service.renew({ userId: DAVE, sessionId: BOB_SESSION }, document.id, TRANSACTION))).code).toBe('NOT_FOUND')
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect((await rejection(service.renew(BEN, document.id, TRANSACTION))).code).toBe('PERMISSION_DENIED')
    expect(store.leases.lockByDocument).not.toHaveBeenCalled()
    store.setMember(TEAM_SPACE, BOB, 'editor')
    store.activeSessions.delete(BOB_SESSION)
    expect((await rejection(service.renew(BEN, document.id, TRANSACTION))).code).toBe('SESSION_EXPIRED')
    expect(store.leases.extendRequest).not.toHaveBeenCalled()
  })
})

describe('EditRequestService.cancel', () => {
  it('槽里是调用者的请求：清掉（待回应的、已谢绝的都算）；别人的请求不动', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    await service.cancel(CAT, document.id, TRANSACTION)
    expect(rowOf(setupResult).requestedBy).toBe(BOB)
    expect(store.leases.clearRequest).not.toHaveBeenCalled()
    await service.decline(AMY, document.id, requestId, token, TRANSACTION)
    await service.cancel(BEN, document.id, TRANSACTION)
    expect(rowOf(setupResult)).toMatchObject({ requestId: null, requestedBy: null, requestDeclinedAt: null })
  })

  it('交出之后留给了调用者：清掉保留，交出的记录（handed_over）留着；没有请求也没有保留时什么也不做', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    await service.handOver(AMY, document.id, requestId, token, TRANSACTION)
    await service.cancel(CAT, document.id, TRANSACTION)
    expect(rowOf(setupResult).reservedFor).toBe(BOB)
    await service.cancel(BEN, document.id, TRANSACTION)
    expect(rowOf(setupResult)).toMatchObject({ endReason: 'handed_over', reservedFor: null, reservedUntil: null })
    expect(store.leases.clearRequest).not.toHaveBeenCalled()
    expect(store.leases.clearReservation).toHaveBeenCalledTimes(1)
  })

  it('能读就行：没了编辑权的请求方照样能撤回自己的请求；看不到 404（锁租约行之前）；不核对这次登录（同释放，页面关闭时 keepalive 发的）', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await requested(setupResult)
    store.leases.lockByDocument.mockClear()
    expect((await rejection(service.cancel({ userId: DAVE, sessionId: BOB_SESSION }, document.id, TRANSACTION))).code).toBe('NOT_FOUND')
    expect(store.leases.lockByDocument).not.toHaveBeenCalled()
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    store.activeSessions.delete(BOB_SESSION)
    store.sessions.isActive.mockClear()
    await service.cancel(BEN, document.id, TRANSACTION)
    expect(rowOf(setupResult).requestId).toBeNull()
    expect(store.sessions.isActive).not.toHaveBeenCalled()
  })
})

describe('EditRequestService.decline', () => {
  it('持有者带令牌、标识对得上：记下谢绝的时刻（now）；请求方下一次续期得到 declined，心跳不再带', async () => {
    const setupResult = setup()
    const { store, service, leaseService, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    await service.decline(AMY, document.id, requestId, token, TRANSACTION)
    expect(rowOf(setupResult).requestDeclinedAt).toEqual(store.databaseNow)
    expect((await leaseService.renew(AMY, document.id, { idleSeconds: 0, format: CURRENT_CLIENT }, token, TRANSACTION)).request).toBeUndefined()
  })

  it('标识对不上、已经谢绝过：什么也不做（重试安全）；锁、登录与令牌照样核对', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    await service.decline(AMY, document.id, STRAY_REQUEST, token, TRANSACTION)
    expect(rowOf(setupResult).requestDeclinedAt).toBeNull()
    await service.decline(AMY, document.id, requestId, token, TRANSACTION)
    const declinedAt = rowOf(setupResult).requestDeclinedAt
    later(store, SECOND)
    await service.decline(AMY, document.id, requestId, token, TRANSACTION)
    expect(rowOf(setupResult).requestDeclinedAt).toEqual(declinedAt)
    expect(store.leases.declineRequest).toHaveBeenCalledTimes(1)
  })

  it('持有者的那一代已失效：EDIT_LEASE_LOST，原因与心跳相同（到期 expired、令牌不对 replaced、被接管 taken_over 带 forced），什么也不写', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    const error = await rejection(service.decline(AMY, document.id, requestId, `${'z'.repeat(41)}-_`, TRANSACTION))
    expect([error.code, error.details]).toEqual(['EDIT_LEASE_LOST', { reason: 'replaced' }])
    later(store, EDIT_LEASE_TTL_SECONDS * SECOND)
    expect((await rejection(service.decline(AMY, document.id, requestId, token, TRANSACTION))).details).toEqual({ reason: 'expired' })
    expect((await rejection(service.decline(AMY, document.id, requestId, undefined, TRANSACTION))).details).toEqual({ reason: 'none' })
    expect(store.leases.declineRequest).not.toHaveBeenCalled()
  })

  it('被强制接管的那一代：EDIT_LEASE_LOST，taken_over 与 forced（共用 editLeaseLost）', async () => {
    const setupResult = setup()
    const { store, service, leaseService, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    store.setMember(TEAM_SPACE, CAROL, 'admin')
    const forced = await leaseService.acquire(CAT, document.id, { clientInstanceId: TAB, takeover: 'force', idleSeconds: 0, format: CURRENT_CLIENT }, HTTP_ORIGIN, TRANSACTION)
    expect(forced.kind).toBe('acquired')
    expect((await rejection(service.decline(AMY, document.id, requestId, token, TRANSACTION))).details).toEqual({ reason: 'taken_over', forced: true })
    expect((await rejection(service.handOver(AMY, document.id, requestId, token, TRANSACTION))).details).toEqual({ reason: 'taken_over', forced: true })
  })

  it('失去编辑权先于租约（M3-P1 审查 A2）：不加锁时能编辑、锁下已被降为查看者——403，不是 EDIT_LEASE_LOST', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { requestId } = await requested(setupResult)
    store.leases.lockByDocument.mockImplementationOnce(async (id: string) => {
      store.setMember(TEAM_SPACE, ALICE, 'viewer')
      const lease = store.leaseRecords.get(id)
      return lease === undefined ? undefined : { ...lease, now: store.databaseNow }
    })
    expect((await rejection(service.decline(AMY, document.id, requestId, `${'z'.repeat(41)}-_`, TRANSACTION))).code).toBe('PERMISSION_DENIED')
  })
})

describe('EditRequestService.handOver', () => {
  it('持有者带令牌、请求待回应、标识对得上：一条语句记下 handed_over、保留给请求方 2 分钟、清掉请求；返回保留', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    const reservedUntil = new Date(store.databaseNow.getTime() + EDIT_HANDOVER_RESERVE_SECONDS * SECOND)
    expect(await service.handOver(AMY, document.id, requestId, token, TRANSACTION)).toEqual({ reservedFor: BOB, reservedUntil })
    expect(rowOf(setupResult)).toMatchObject({ endedAt: store.databaseNow, endReason: 'handed_over', reservedFor: BOB, reservedUntil, requestId: null, requestedBy: null })
    expect(store.leases.handOver).toHaveBeenCalledWith(expect.objectContaining({ documentId: document.id }), TRANSACTION)
    expect(store.audits).toEqual([])
  })

  it('先不加锁判断能编辑，再锁文档行、在它的锁下锁租约行（与申请同一个顺序，Codex 评审 CX1：交出是明确结束，与在途的保存互斥），锁下核对这次登录；交出凭的是锁下的那一行，不用只锁租约行的 lockByDocument', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    const { documents } = store.repositories
    for (const fn of [documents.findById, documents.lockById, store.leases.lockByDocument, store.leases.lockUnder, store.sessions.isActive])
      fn.mockClear()
    await service.handOver(AMY, document.id, requestId, token, TRANSACTION)
    const steps = [orderOf(documents.findById), orderOf(documents.lockById), orderOf(store.leases.lockUnder), orderOf(store.sessions.isActive), orderOf(store.leases.handOver)]
    expect(steps).toEqual(steps.toSorted((a, b) => a - b))
    expect(store.sessions.isActive).toHaveBeenNthCalledWith(1, ALICE_SESSION, TRANSACTION)
    const locked: unknown = await documents.lockById.mock.results[0]?.value
    expect(store.leases.lockUnder.mock.calls).toEqual([[locked, TRANSACTION]])
    expect(store.leases.handOver.mock.calls).toEqual([[await store.leases.lockUnder.mock.results[0]?.value, TRANSACTION]])
    expect(store.leases.lockByDocument).not.toHaveBeenCalled()
    // 锁下读到的文档行就是最终的：不再读一次
    expect(documents.findById).toHaveBeenCalledTimes(1)
  })

  it('看不到 404、只能查看 403：都在取任何锁之前，什么也不写', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    store.repositories.documents.lockById.mockClear()
    store.leases.lockUnder.mockClear()
    expect((await rejection(service.handOver({ userId: DAVE, sessionId: BOB_SESSION }, document.id, requestId, token, TRANSACTION))).code).toBe('NOT_FOUND')
    expect((await rejection(service.handOver(AMY, MISSING_DOCUMENT, requestId, token, TRANSACTION))).code).toBe('NOT_FOUND')
    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    expect((await rejection(service.handOver(AMY, document.id, requestId, token, TRANSACTION))).code).toBe('PERMISSION_DENIED')
    expect(store.repositories.documents.lockById).not.toHaveBeenCalled()
    expect(store.leases.lockUnder).not.toHaveBeenCalled()
    expect(store.leases.handOver).not.toHaveBeenCalled()
  })

  it('等文档行的锁期间文档进了回收站：按读不到回答（NOT_FOUND），不锁租约行、什么也不写', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    store.leases.lockUnder.mockClear()
    store.repositories.documents.lockById.mockImplementationOnce(async (id: string) => {
      store.documentEntries.set(id, 'trash-entry-1')
      return undefined
    })
    expect((await rejection(service.handOver(AMY, document.id, requestId, token, TRANSACTION))).code).toBe('NOT_FOUND')
    expect(store.leases.lockUnder).not.toHaveBeenCalled()
    expect(store.leases.handOver).not.toHaveBeenCalled()
  })

  it('失去编辑权先于租约（M3-P1 审查 A2）：不加锁时能编辑、锁下已被降为查看者——403，不是 EDIT_LEASE_LOST，不交出', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { requestId } = await requested(setupResult)
    store.leases.lockUnder.mockImplementationOnce(async (locked) => {
      store.setMember(TEAM_SPACE, ALICE, 'viewer')
      return store.lockedLease(locked.id)
    })
    expect((await rejection(service.handOver(AMY, document.id, requestId, `${'z'.repeat(41)}-_`, TRANSACTION))).code).toBe('PERMISSION_DENIED')
    expect(store.leases.handOver).not.toHaveBeenCalled()
  })

  it('这次登录在两把锁之后再核对（M3-P1 审查 A1）：被撤销时 401 SESSION_EXPIRED，不交出', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    store.activeSessions.delete(ALICE_SESSION)
    const error = await rejection(service.handOver(AMY, document.id, requestId, token, TRANSACTION))
    expect([error.code, error.status]).toEqual(['SESSION_EXPIRED', 401])
    expect(store.leases.handOver).not.toHaveBeenCalled()
    expect(rowOf(setupResult)).toMatchObject({ endReason: null, requestedBy: BOB })
  })

  it('请求已不在：标识对不上、请求方取消了、谢绝了、过期了、请求方的登录失效、请求方没了编辑权——EDIT_REQUEST_GONE，租约不动', async () => {
    const cases: readonly (readonly [string, (setupResult: Setup, request: { readonly token: string, readonly requestId: string }) => Promise<string>])[] = [
      ['标识对不上', async () => STRAY_REQUEST],
      ['请求方取消了', async ({ service, document }, { requestId }) => {
        await service.cancel(BEN, document.id, TRANSACTION)
        return requestId
      }],
      ['谢绝了', async ({ service, document }, { token, requestId }) => {
        await service.decline(AMY, document.id, requestId, token, TRANSACTION)
        return requestId
      }],
      ['过期了', async ({ store, document }, { requestId }) => {
        const row = store.leaseRecords.get(document.id)
        if (row !== undefined)
          store.leaseRecords.set(document.id, { ...row, requestExpiresAt: store.databaseNow })
        return requestId
      }],
      ['请求方的登录失效', async ({ store }, { requestId }) => {
        store.activeSessions.delete(BOB_SESSION)
        return requestId
      }],
      ['请求方没了编辑权', async ({ store }, { requestId }) => {
        store.setMember(TEAM_SPACE, BOB, 'viewer')
        return requestId
      }],
    ]
    for (const [name, prepare] of cases) {
      const setupResult = setup()
      const { store, service, document } = setupResult
      const request = await requested(setupResult)
      const requestId = await prepare(setupResult, request)
      const before = rowOf(setupResult)
      const error = await rejection(service.handOver(AMY, document.id, requestId, request.token, TRANSACTION))
      expect([error.code, error.status], name).toEqual(['EDIT_REQUEST_GONE', 409])
      expect(rowOf(setupResult), name).toEqual(before)
      expect(store.leases.handOver, name).not.toHaveBeenCalled()
    }
  })

  it('标识对不上时不问请求方的事实（登录、编辑权）', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { token } = await requested(setupResult)
    store.sessions.isActive.mockClear()
    await rejection(service.handOver(AMY, document.id, STRAY_REQUEST, token, TRANSACTION))
    // 只查了持有者自己这次登录（requireActiveLogin）
    expect(store.sessions.isActive.mock.calls).toEqual([[ALICE_SESSION, TRANSACTION]])
  })

  it('回包丢了再交出：这一代已经明确结束——EDIT_LEASE_LOST（handed_over），保留不变', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    await service.handOver(AMY, document.id, requestId, token, TRANSACTION)
    const after = rowOf(setupResult)
    later(store, SECOND)
    const error = await rejection(service.handOver(AMY, document.id, requestId, token, TRANSACTION))
    expect([error.code, error.details]).toEqual(['EDIT_LEASE_LOST', { reason: 'handed_over' }])
    expect(rowOf(setupResult)).toEqual(after)
  })

  it('交出不写审计、不是异常结束：之后申请的人没有提醒；持有者的心跳得到 handed_over', async () => {
    const setupResult = setup()
    const { store, service, leaseService, document } = setupResult
    const { token, requestId } = await requested(setupResult)
    await service.handOver(AMY, document.id, requestId, token, TRANSACTION)
    expect((await rejection(leaseService.renew(AMY, document.id, { idleSeconds: 0, format: CURRENT_CLIENT }, token, TRANSACTION))).details).toEqual({ reason: 'handed_over' })
    const next = await leaseService.acquire(BEN, document.id, { clientInstanceId: TAB, takeover: undefined, idleSeconds: 0, format: CURRENT_CLIENT }, HTTP_ORIGIN, TRANSACTION)
    expect(next).toMatchObject({ kind: 'acquired', interruption: undefined })
    expect(store.audits).toEqual([])
  })

  it('日志：交出与请求已不在各一条 debug，不记令牌', async () => {
    const setupResult = setup()
    const { service, document, logs, logText } = setupResult
    const { token, requestId } = await requested(setupResult)
    await rejection(service.handOver(AMY, document.id, STRAY_REQUEST, token, TRANSACTION))
    await service.handOver(AMY, document.id, requestId, token, TRANSACTION)
    expect(logs().filter(entry => String(entry.msg).startsWith('交出')).map(entry => entry.msg)).toEqual(['交出：请求已不在', '交出：编辑权留给了请求方'])
    expect(logText()).not.toContain(token)
  })
})
