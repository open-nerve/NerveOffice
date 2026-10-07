// 编辑租约的服务（M3-P1 设计 §3.4.2、§3.4.3）：申请、心跳续租、释放与编辑状态的步骤、加锁的先后、每个分支写了什么没写什么、
// 日志。有效条件本身在 edit-lease-rules.test.ts；SQL、并发与真实的时间在集成测试（documents/edit-leases.test.ts）。
import type { ClientFormat, EditTakeoverMode } from '@nerve-office/contracts'
import type { AppError } from '../../shared/errors/app-error.ts'
import type { EditingActor } from './edit-lease.service.ts'
import type { EditLeaseRow } from './edit-leases.repository.ts'
import { Buffer } from 'node:buffer'
import { EDIT_LEASE_IDLE_RECLAIM_SECONDS, EDIT_LEASE_TTL_SECONDS, editLeaseTokenSchema } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { ALICE, BOB, clientFormatGate, CURRENT_CLIENT, FakeStore, HTTP_ORIGIN, TEAM_SPACE, TRANSACTION } from './documents.test-support.ts'
import { editLeaseTokenDigest } from './edit-lease-token.ts'
import { EditLeaseService } from './edit-lease.service.ts'

const CAROL = '0199a2c4-0000-7000-8000-00000000000c'
const ALICE_SESSION = '0199a2c4-0000-7000-8000-0000000000e1'
const ALICE_OTHER_SESSION = '0199a2c4-0000-7000-8000-0000000000e2'
const BOB_SESSION = '0199a2c4-0000-7000-8000-0000000000e3'
const TAB = '0199a2c4-0000-7000-8000-0000000000f1'
const OTHER_TAB = '0199a2c4-0000-7000-8000-0000000000f2'

const SECOND = 1000
const AMY: EditingActor = { userId: ALICE, sessionId: ALICE_SESSION }
const BEN: EditingActor = { userId: BOB, sessionId: BOB_SESSION }

/** 团队空间里的一份文档（修订号 3），艾米与本是编辑者，两人的登录都有效；日志收进内存（debug 级） */
function setup() {
  const store = new FakeStore()
  store.setMember(TEAM_SPACE, ALICE, 'editor')
  store.setMember(TEAM_SPACE, BOB, 'editor')
  for (const session of [ALICE_SESSION, ALICE_OTHER_SESSION, BOB_SESSION])
    store.activeSessions.add(session)
  const document = store.addDocument({ spaceId: TEAM_SPACE, revision: 3 })
  const lines: string[] = []
  const logger = new AppLogger(createRootLogger({ level: 'debug', destination: { write: (line: string) => void lines.push(line) } }), new RequestContextStore())
  const { documents, revisions, leases, policy, sessions, audit } = store.deps
  const service = new EditLeaseService(documents, revisions, leases, policy, sessions, store.clientFormats, audit, logger)
  return { store, service, document, logs: () => lines.map(line => JSON.parse(line) as Record<string, unknown>), logText: () => lines.join('') }
}

type Setup = ReturnType<typeof setup>

/**
 * 申请的请求：这个标签页，页面上报的是现在的构建与数据格式（M3-P3）；不是续上的申请不带空闲（0，M3-P5）；
 * 普通的申请不带接管方式（本人接管、强制接管，M3-P5）
 */
function leaseRequest(clientInstanceId: string, format: ClientFormat = CURRENT_CLIENT, idleSeconds = 0, takeover?: EditTakeoverMode) {
  return { clientInstanceId, takeover, idleSeconds, format }
}

/** 心跳的请求：多久没有操作，页面上报的是现在的构建与数据格式 */
function renewal(idleSeconds: number, format: ClientFormat = CURRENT_CLIENT) {
  return { idleSeconds, format }
}

/** 让"数据库时间"往后走 */
function later(store: FakeStore, milliseconds: number): void {
  store.databaseNow = new Date(store.databaseNow.getTime() + milliseconds)
}

/** 这份文档的租约最后一次操作在 seconds 秒之前（心跳还在：续租与到期不动） */
function idleFor(store: FakeStore, documentId: string, seconds: number): void {
  const row = store.leaseRecords.get(documentId)
  if (row === undefined)
    throw new Error(`${documentId} 没有租约`)
  store.leaseRecords.set(documentId, { ...row, lastActiveAt: new Date(store.databaseNow.getTime() - seconds * SECOND) })
}

/** 取得一代，返回令牌 */
async function acquired({ service, document }: Setup, actor: EditingActor = AMY, tab: string = TAB): Promise<string> {
  const outcome = await service.acquire(actor, document.id, leaseRequest(tab), HTTP_ORIGIN, TRANSACTION)
  if (outcome.kind !== 'acquired')
    throw new Error('期望取得编辑权')
  return outcome.token
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

describe('EditLeaseService.acquire', () => {
  it('没有租约：文档的代次加一，记下新的一代（持有者、登录、标签页、令牌的摘要、代次），返回令牌、代次、锁下的修订号与到期时间', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const outcome = await service.acquire(AMY, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION)
    expect(outcome).toMatchObject({ kind: 'acquired', writeEpoch: 1, revision: 3, expiresAt: new Date(store.databaseNow.getTime() + EDIT_LEASE_TTL_SECONDS * SECOND), interruption: undefined })
    if (outcome.kind !== 'acquired')
      return
    expect(editLeaseTokenSchema.safeParse(outcome.token).success).toBe(true)
    expect(store.documents.get(document.id)?.writeEpoch).toBe(1)
    const row = store.leaseRecords.get(document.id)
    expect(row).toMatchObject({ holderId: ALICE, sessionId: ALICE_SESSION, clientInstanceId: TAB, writeEpoch: 1, endedAt: null, endReason: null })
    // 库里只有摘要
    expect(row?.tokenDigest.equals(editLeaseTokenDigest(outcome.token))).toBe(true)
    // 先不加锁判断、再锁文档行、锁租约行，最后加代次、改写租约行（锁的顺序：文档行 → 租约行）
    const { documents } = store.repositories
    const steps = [orderOf(documents.findById), orderOf(documents.lockById), orderOf(store.leases.lockByDocument), orderOf(documents.advanceWriteEpoch), orderOf(store.leases.replace)]
    expect(steps).toEqual(steps.toSorted((a, b) => a - b))
    expect(documents.lockById).toHaveBeenCalledWith(document.id, TRANSACTION)
  })

  it('当前修订的来源：锁下的修订号那一条修订记录的标签页与本地序号（与修订号冲突的详情同一个取法）；新建出来的为 null', async () => {
    const created = setup()
    created.store.addRevision({ documentId: created.document.id, revision: 3, kind: 'created', requestId: 'request-created', payloadDigest: Buffer.alloc(32), source: null, savedBy: ALICE })
    expect(await created.service.acquire(AMY, created.document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'acquired', revision: 3, source: null })

    // 本人在另一个标签页保存的：照样给出（页面再按标签页比较）
    const saved = setup()
    for (const [revision, localSeq] of [[2, 4], [3, 7]] as const)
      saved.store.addRevision({ documentId: saved.document.id, revision, kind: 'saved', requestId: `request-${revision}`, payloadDigest: Buffer.alloc(32), source: { clientInstanceId: OTHER_TAB, localSeq }, savedBy: ALICE })
    expect(await saved.service.acquire(AMY, saved.document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'acquired', revision: 3, source: { clientInstanceId: OTHER_TAB, localSeq: 7 } })
    expect(saved.store.repositories.revisions.findByRevision).toHaveBeenCalledWith(saved.document.id, 3, TRANSACTION)
  })

  it('当前修订是别人保存的：来源为 null（只给保存它的人本人，M3-P1 复验 C4）——标签页标识是页面自报的，给了别人就能被照着伪造', async () => {
    const { store, service, document } = setup()
    store.addRevision({ documentId: document.id, revision: 3, kind: 'saved', requestId: 'request-3', payloadDigest: Buffer.alloc(32), source: { clientInstanceId: TAB, localSeq: 7 }, savedBy: BOB })
    expect(await service.acquire(AMY, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'acquired', revision: 3, source: null })
  })

  it('这次登录在两把锁之后再核对（M3-P1 审查 A1）：守卫之后被撤销（退出、签发重置、换令牌）时 401 SESSION_EXPIRED，什么也不写', async () => {
    const { store, service, document } = setup()
    store.activeSessions.delete(ALICE_SESSION)
    const error = await rejection(service.acquire(AMY, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION))
    expect([error.code, error.status]).toEqual(['SESSION_EXPIRED', 401])
    expect(store.leaseRecords.has(document.id)).toBe(false)
    expect(store.documents.get(document.id)?.writeEpoch).toBe(0)
    expect(store.sessions.isActive).toHaveBeenCalledWith(ALICE_SESSION, TRANSACTION)
    const steps = [orderOf(store.repositories.documents.lockById), orderOf(store.leases.lockByDocument), orderOf(store.sessions.isActive)]
    expect(steps).toEqual(steps.toSorted((a, b) => a - b))
  })

  it('看不到 404、只能查看 403：都在加锁之前，什么也不写', async () => {
    const { store, service, document } = setup()
    expect((await rejection(service.acquire({ userId: CAROL, sessionId: BOB_SESSION }, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION))).code).toBe('NOT_FOUND')
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect((await rejection(service.acquire(BEN, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION))).code).toBe('PERMISSION_DENIED')
    expect((await rejection(service.acquire(AMY, '0199a2c4-0000-7000-8000-0000000000ff', leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION))).code).toBe('NOT_FOUND')
    expect(store.repositories.documents.lockById).not.toHaveBeenCalled()
    expect(store.leases.lockByDocument).not.toHaveBeenCalled()
    expect(store.leaseRecords.size).toBe(0)
  })

  it('锁下再判断：不加锁时能编辑、拿到文档行的锁时已被降为查看者，403，不锁租约行、不写', async () => {
    const { store, service, document } = setup()
    store.repositories.documents.lockById.mockImplementationOnce(async (id: string) => {
      store.setMember(TEAM_SPACE, ALICE, 'viewer')
      return store.documents.get(id)
    })
    expect((await rejection(service.acquire(AMY, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION))).code).toBe('PERMISSION_DENIED')
    expect(store.leases.lockByDocument).not.toHaveBeenCalled()
    expect(store.documents.get(document.id)?.writeEpoch).toBe(0)
  })

  it('有效的租约在别人手里：被占用（持有者、最后活动时间、不是自己、不是这次登录、能不能强制接管），什么也不写', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    const before = store.leaseRecords.get(document.id)
    later(store, 5 * SECOND)
    expect(await service.acquire(BEN, document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)).toEqual({ kind: 'held', holderId: ALICE, lastActiveAt: before?.lastActiveAt, sameUser: false, sameSession: false, canTakeOver: false })
    expect(store.leaseRecords.get(document.id)).toEqual(before)
    expect(store.repositories.documents.advanceWriteEpoch).toHaveBeenCalledTimes(1)
    expect(store.documents.get(document.id)?.writeEpoch).toBe(1)
  })

  it('同一个人在另一个标签页、另一个登录（别的设备）：同样被占用，sameUser 为真；sameSession 只在同一个登录（同一个浏览器）时为真（M3-P5）', async () => {
    const setupResult = setup()
    const { service, document } = setupResult
    await acquired(setupResult)
    for (const [actor, tab, sameSession] of [[AMY, OTHER_TAB, true], [{ userId: ALICE, sessionId: ALICE_OTHER_SESSION }, TAB, false], [{ userId: ALICE, sessionId: ALICE_OTHER_SESSION }, OTHER_TAB, false]] as const)
      expect(await service.acquire(actor, document.id, leaseRequest(tab), HTTP_ORIGIN, TRANSACTION), `${actor.sessionId} ${tab}`).toMatchObject({ kind: 'held', holderId: ALICE, sameUser: true, sameSession })
  })

  it('M3-P5 被占用时带上调用者能不能强制接管：锁下判断权限时算出的那一位——空间管理员能，编辑者不能', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    expect(await service.acquire(BEN, document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'held', canTakeOver: false })
    store.setMember(TEAM_SPACE, BOB, 'admin')
    expect(await service.acquire(BEN, document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'held', canTakeOver: true })
    // 不加锁时还是空间管理员、拿到文档行的锁时已被降为编辑者：按锁下的那一次
    store.repositories.documents.lockById.mockImplementationOnce(async (id: string) => {
      store.setMember(TEAM_SPACE, BOB, 'editor')
      return store.documents.get(id)
    })
    expect(await service.acquire(BEN, document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'held', canTakeOver: false })
  })

  it('同一个登录、同一个标签页的有效租约：这个页面的重试（上次的回包丢了），发新的一代——代次再加一、换新的令牌，没有提醒', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const first = await acquired(setupResult)
    const retried = await service.acquire(AMY, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION)
    expect(retried).toMatchObject({ kind: 'acquired', writeEpoch: 2, interruption: undefined })
    if (retried.kind !== 'acquired')
      return
    expect(retried.token).not.toBe(first)
    expect(store.leaseRecords.get(document.id)?.tokenDigest.equals(editLeaseTokenDigest(retried.token))).toBe(true)
  })

  it('当前的租约无效（到期、空闲、登录失效、没了编辑权、已释放、代次过时而按时间已死）：都照样发新的一代', async () => {
    const cases: readonly (readonly [string, (s: Setup) => void | Promise<void>])[] = [
      ['到期', ({ store }) => later(store, EDIT_LEASE_TTL_SECONDS * SECOND)],
      ['空闲', ({ store, document }) => idleFor(store, document.id, EDIT_LEASE_IDLE_RECLAIM_SECONDS)],
      ['登录失效', ({ store }) => void store.activeSessions.delete(ALICE_SESSION)],
      ['没了编辑权', ({ store }) => store.setMember(TEAM_SPACE, ALICE, 'viewer')],
      ['已释放', async ({ store, document }) => void await store.leases.end(document.id, 'released')],
      ['代次过时、而且到期了', async ({ store, document }) => {
        await store.repositories.documents.advanceWriteEpoch(document.id)
        later(store, EDIT_LEASE_TTL_SECONDS * SECOND)
      }],
    ]
    for (const [name, invalidate] of cases) {
      const setupResult = setup()
      const { store, service, document } = setupResult
      await acquired(setupResult)
      await invalidate(setupResult)
      const epoch = store.documents.get(document.id)?.writeEpoch ?? 0
      expect(await service.acquire(BEN, document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION), name).toMatchObject({ kind: 'acquired', writeEpoch: epoch + 1 })
      expect(store.leaseRecords.get(document.id), name).toMatchObject({ holderId: BOB, sessionId: BOB_SESSION, clientInstanceId: OTHER_TAB, endedAt: null, endReason: null })
    }
  })

  it('M3-P5 R2（设计 §3.5）：代次过时（跨空间移动、转移之后）、而按时间、登录、编辑权都还活着——别人申请是被占用，什么也不写；持有者本人照样取得新的一代（续上），没有提醒', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    await store.repositories.documents.advanceWriteEpoch(document.id)
    const before = store.leaseRecords.get(document.id)
    expect(await service.acquire(BEN, document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)).toEqual({ kind: 'held', holderId: ALICE, lastActiveAt: before?.lastActiveAt, sameUser: false, sameSession: false, canTakeOver: false })
    expect(store.leaseRecords.get(document.id)).toEqual(before)
    expect(store.documents.get(document.id)?.writeEpoch).toBe(2)
    // 持有者本人（同一个页面续上，或者他在别的标签页、设备上）：普通的申请
    expect(await service.acquire({ userId: ALICE, sessionId: ALICE_OTHER_SESSION }, document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'acquired', writeEpoch: 3, interruption: undefined })
    expect(store.leaseRecords.get(document.id)).toMatchObject({ holderId: ALICE, sessionId: ALICE_OTHER_SESSION, writeEpoch: 3 })
  })

  it('M3-P5 R2 要"都还活着"：代次过时、持有者的登录已失效（有提醒）或已没了编辑权（没有提醒）——别人照样取得新的一代', async () => {
    for (const [name, invalidate, notice] of [
      ['登录失效', (store: FakeStore) => void store.activeSessions.delete(ALICE_SESSION), true],
      ['没了编辑权', (store: FakeStore) => store.setMember(TEAM_SPACE, ALICE, 'viewer'), false],
    ] as const) {
      const setupResult = setup()
      const { store, service, document } = setupResult
      await acquired(setupResult)
      const renewedAt = store.leaseRecords.get(document.id)?.renewedAt
      await store.repositories.documents.advanceWriteEpoch(document.id)
      invalidate(store)
      expect(await service.acquire(BEN, document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION), name).toMatchObject({ kind: 'acquired', interruption: notice ? { holderId: ALICE, endedAt: renewedAt, sameUser: false } : undefined })
    }
  })

  it('M3-P5 续上的页面带来的空闲（idleSeconds）交给仓储：新的一代的最后活动是 now 减去它（设计 §3.5，复验 P1-C5）', async () => {
    const { store, service, document } = setup()
    await service.acquire(AMY, document.id, leaseRequest(TAB, CURRENT_CLIENT, 300), HTTP_ORIGIN, TRANSACTION)
    expect(store.leases.replace).toHaveBeenCalledWith(expect.objectContaining({ documentId: document.id, idleSeconds: 300 }), TRANSACTION)
    expect(store.leaseRecords.get(document.id)).toMatchObject({ acquiredAt: store.databaseNow, lastActiveAt: new Date(store.databaseNow.getTime() - 300 * SECOND) })
  })

  it('M3-P5 持有者的登录与编辑权在一次申请里至多各查一次（有效条件、R2、异常结束共用）', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    await store.repositories.documents.advanceWriteEpoch(document.id)
    store.sessions.isActive.mockClear()
    store.spaces.accessFactsOf.mockClear()
    await service.acquire(BEN, document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)
    // 申请的人自己的登录（锁下核对）一次、持有者的登录一次
    expect(store.sessions.isActive.mock.calls.map(([sessionId]) => sessionId)).toEqual([BOB_SESSION, ALICE_SESSION])
    expect(store.spaces.accessFactsOf.mock.calls.map(([userId]) => userId)).toEqual([BOB, BOB, ALICE])
  })

  it('上一个租约异常结束（到期、空闲、登录失效）、在 30 分钟以内：给出提醒——上一位持有者与他最近一次续租的时间', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    const renewedAt = store.leaseRecords.get(document.id)?.renewedAt
    later(store, 20 * 60 * SECOND)
    expect(await service.acquire(BEN, document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)).toEqual(expect.objectContaining({ kind: 'acquired', interruption: { holderId: ALICE, endedAt: renewedAt, sameUser: false } }))
  })

  it('M3-P5 提醒带上上一位持有者是不是申请的人自己：自己的租约到期之后再申请，sameUser 为真', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    const renewedAt = store.leaseRecords.get(document.id)?.renewedAt
    later(store, EDIT_LEASE_TTL_SECONDS * SECOND)
    expect(await service.acquire({ userId: ALICE, sessionId: ALICE_OTHER_SESSION }, document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)).toEqual(expect.objectContaining({ kind: 'acquired', interruption: { holderId: ALICE, endedAt: renewedAt, sameUser: true } }))
  })

  it('M3-P5 先到期、后代次过时（跨空间移动、转移）：按事实仍是异常结束，照样提醒（设计 §3.5，P1 审查 A6 第 1 处）', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    const renewedAt = store.leaseRecords.get(document.id)?.renewedAt
    later(store, EDIT_LEASE_TTL_SECONDS * SECOND)
    await store.repositories.documents.advanceWriteEpoch(document.id)
    expect(await service.acquire(BEN, document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'acquired', interruption: { holderId: ALICE, endedAt: renewedAt, sameUser: false } })
  })

  it('不给提醒：明确释放的、没了编辑权的、超过 30 分钟的', async () => {
    const released = setup()
    await acquired(released)
    await released.store.leases.end(released.document.id, 'released')
    expect(await released.service.acquire(BEN, released.document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'acquired', interruption: undefined })

    const demoted = setup()
    await acquired(demoted)
    demoted.store.setMember(TEAM_SPACE, ALICE, 'viewer')
    expect(await demoted.service.acquire(BEN, demoted.document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'acquired', interruption: undefined })

    const old = setup()
    await acquired(old)
    later(old.store, 30 * 60 * SECOND + 1)
    expect(await old.service.acquire(BEN, old.document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'acquired', interruption: undefined })
  })

  it('第 6、7 条的事实在调用方的事务里查：持有者的登录（auth）与持有者对这份文档的编辑权（访问策略）', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    store.spaces.accessFactsOf.mockClear()
    await service.acquire(BEN, document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)
    expect(store.sessions.isActive).toHaveBeenCalledWith(ALICE_SESSION, TRANSACTION)
    // 访问策略判断了两个人：申请的人（不加锁、锁下各一次）与持有者
    expect(store.spaces.accessFactsOf.mock.calls.map(([userId]) => userId)).toEqual([BOB, BOB, ALICE])
  })

  it('日志：取得、被占用各一条 debug，带文档 id 与上一个租约的情形，不带令牌', async () => {
    const setupResult = setup()
    const { service, document, logs, logText } = setupResult
    const token = await acquired(setupResult)
    await service.acquire(BEN, document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)
    expect(logs().map(entry => [entry.level, entry.msg, entry.documentId, entry.previous ?? entry.sameUser])).toEqual([
      ['debug', '申请编辑权：取得新的一代', document.id, 'none'],
      ['debug', '申请编辑权：有效的租约在别人手里', document.id, false],
    ])
    expect(logText()).not.toContain(token)
  })
})

describe('M3-P5 EditLeaseService.acquire 的本人接管与强制接管（设计 §3.7、§3.8）', () => {
  /** 艾米在另一个设备上（另一次登录）：本人接管跨设备的情形 */
  const AMY_ELSEWHERE: EditingActor = { userId: ALICE, sessionId: ALICE_OTHER_SESSION }

  /** 以这个人、这个标签页、这种接管方式申请 */
  async function claim({ service, document }: Setup, actor: EditingActor, tab: string, takeover: EditTakeoverMode | undefined) {
    return service.acquire(actor, document.id, leaseRequest(tab, CURRENT_CLIENT, 0, takeover), HTTP_ORIGIN, TRANSACTION)
  }

  it('本人接管：占着的是自己在别的设备、同一个浏览器别的标签页上的有效租约——发新的一代（代次加一、换令牌），接管标记是被接管那一代的令牌摘要与 self；不写审计，没有提醒', async () => {
    for (const [actor, tab] of [[AMY_ELSEWHERE, TAB], [AMY, OTHER_TAB]] as const) {
      const setupResult = setup()
      const { store, document } = setupResult
      const taken = await acquired(setupResult)
      const outcome = await claim(setupResult, actor, tab, 'self')
      expect(outcome, actor.sessionId).toMatchObject({ kind: 'acquired', writeEpoch: 2, interruption: undefined })
      if (outcome.kind !== 'acquired')
        return
      expect(outcome.token).not.toBe(taken)
      expect(store.leaseRecords.get(document.id), actor.sessionId).toMatchObject({ holderId: ALICE, sessionId: actor.sessionId, clientInstanceId: tab, writeEpoch: 2, takenOverTokenDigest: editLeaseTokenDigest(taken), takeover: 'self' })
      expect(store.leases.replace).toHaveBeenLastCalledWith(expect.objectContaining({ takenOver: { tokenDigest: editLeaseTokenDigest(taken), takeover: 'self' } }), TRANSACTION)
      expect(store.documents.get(document.id)?.writeEpoch).toBe(2)
      expect(store.audits).toEqual([])
    }
  })

  it('本人接管遇到别人的租约不起作用：与普通的申请一样被占用（详情同样），什么也不写', async () => {
    const setupResult = setup()
    const { store, document } = setupResult
    await acquired(setupResult)
    const before = store.leaseRecords.get(document.id)
    expect(await claim(setupResult, BEN, OTHER_TAB, 'self')).toEqual({ kind: 'held', holderId: ALICE, lastActiveAt: before?.lastActiveAt, sameUser: false, sameSession: false, canTakeOver: false })
    expect(store.leaseRecords.get(document.id)).toEqual(before)
    expect(store.documents.get(document.id)?.writeEpoch).toBe(1)
  })

  it('强制接管别人的有效租约（空间管理员）：发新的一代，接管标记是被接管那一代的令牌摘要与 forced；同一个事务里写一条审计（操作者、文档、被接管的人、来源），排在改写租约行之后', async () => {
    const setupResult = setup()
    const { store, document } = setupResult
    const taken = await acquired(setupResult)
    store.setMember(TEAM_SPACE, BOB, 'admin')
    expect(await claim(setupResult, BEN, OTHER_TAB, 'force')).toMatchObject({ kind: 'acquired', writeEpoch: 2, interruption: undefined })
    expect(store.leaseRecords.get(document.id)).toMatchObject({ holderId: BOB, sessionId: BOB_SESSION, clientInstanceId: OTHER_TAB, takenOverTokenDigest: editLeaseTokenDigest(taken), takeover: 'forced' })
    expect(store.audits).toEqual([{ action: 'documents.edit_taken_over', actor: { type: 'user', id: BOB }, target: { type: 'document', id: document.id }, origin: HTTP_ORIGIN, details: { holderId: ALICE } }])
    expect(store.audit.record).toHaveBeenCalledWith(expect.anything(), { transaction: TRANSACTION })
    // 锁的顺序：文档行 → 租约行 → 审计
    const steps = [orderOf(store.repositories.documents.lockById, 1), orderOf(store.leases.lockByDocument, 1), orderOf(store.leases.replace, 1), orderOf(store.audit.record)]
    expect(steps).toEqual(steps.toSorted((a, b) => a - b))
  })

  it('强制接管 R2 的租约（代次过时、持有者按时间、登录、编辑权都还活着：被占用）：照样接管，审计里是那位持有者', async () => {
    const setupResult = setup()
    const { store, document } = setupResult
    const taken = await acquired(setupResult)
    await store.repositories.documents.advanceWriteEpoch(document.id)
    store.setMember(TEAM_SPACE, BOB, 'admin')
    expect(await claim(setupResult, BEN, OTHER_TAB, 'force')).toMatchObject({ kind: 'acquired', writeEpoch: 3 })
    expect(store.leaseRecords.get(document.id)).toMatchObject({ holderId: BOB, takenOverTokenDigest: editLeaseTokenDigest(taken), takeover: 'forced' })
    expect(store.audits.map(event => event.details)).toEqual([{ holderId: ALICE }])
  })

  it('强制接管遇到自己的租约（别的设备）：就是本人接管——接管标记 self，不写审计；没人占着：普通的申请——没有接管标记、不写审计，提醒照常', async () => {
    const own = setup()
    own.store.setMember(TEAM_SPACE, ALICE, 'admin')
    const taken = await acquired(own)
    expect(await claim(own, AMY_ELSEWHERE, OTHER_TAB, 'force')).toMatchObject({ kind: 'acquired', writeEpoch: 2 })
    expect(own.store.leaseRecords.get(own.document.id)).toMatchObject({ takenOverTokenDigest: editLeaseTokenDigest(taken), takeover: 'self' })
    expect(own.store.audits).toEqual([])

    const vacant = setup()
    vacant.store.setMember(TEAM_SPACE, BOB, 'admin')
    await acquired(vacant)
    const renewedAt = vacant.store.leaseRecords.get(vacant.document.id)?.renewedAt
    later(vacant.store, EDIT_LEASE_TTL_SECONDS * SECOND)
    expect(await claim(vacant, BEN, OTHER_TAB, 'force')).toMatchObject({ kind: 'acquired', writeEpoch: 2, interruption: { holderId: ALICE, endedAt: renewedAt, sameUser: false } })
    expect(vacant.store.leaseRecords.get(vacant.document.id)).toMatchObject({ holderId: BOB, takenOverTokenDigest: null, takeover: null })
    expect(vacant.store.leases.replace).toHaveBeenLastCalledWith(expect.objectContaining({ takenOver: undefined }), TRANSACTION)
    expect(vacant.store.audits).toEqual([])
  })

  it('页面自己的重试（同一个登录、同一个标签页）带着接管方式：照样是重试——不当成又一次接管：接管标记沿用上一代的（还是最初被接管的那一代），不再写审计', async () => {
    const setupResult = setup()
    const { store, document } = setupResult
    const taken = await acquired(setupResult)
    store.setMember(TEAM_SPACE, BOB, 'admin')
    await claim(setupResult, BEN, OTHER_TAB, 'force')
    for (const takeover of ['force', 'self', undefined] as const) {
      expect(await claim(setupResult, BEN, OTHER_TAB, takeover), String(takeover)).toMatchObject({ kind: 'acquired' })
      expect(store.leaseRecords.get(document.id), String(takeover)).toMatchObject({ holderId: BOB, takenOverTokenDigest: editLeaseTokenDigest(taken), takeover: 'forced' })
      expect(store.leases.replace, String(takeover)).toHaveBeenLastCalledWith(expect.objectContaining({ takenOver: undefined }), TRANSACTION)
    }
    expect(store.audits).toHaveLength(1)
  })

  it('强制接管要能编辑并能强制接管，不加锁判断一次：编辑者 403（只有空间管理员能…）、只凭编辑授权的人 403（他自己的说明）、查看者 403（只能查看），都在加锁之前，什么也不写', async () => {
    const setupResult = setup()
    const { store, document } = setupResult
    await acquired(setupResult)
    store.repositories.documents.lockById.mockClear()
    store.leases.lockByDocument.mockClear()
    expect(await rejection(claim(setupResult, BEN, OTHER_TAB, 'force'))).toMatchObject({ code: 'PERMISSION_DENIED', message: '只有空间管理员能强制接管这份文档的编辑' })
    store.setMember(TEAM_SPACE, BOB, undefined)
    store.setGrant(document.id, BOB, 'editor')
    expect(await rejection(claim(setupResult, BEN, OTHER_TAB, 'force'))).toMatchObject({ code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能强制接管编辑' })
    store.setGrant(document.id, BOB, undefined)
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect(await rejection(claim(setupResult, BEN, OTHER_TAB, 'force'))).toMatchObject({ code: 'PERMISSION_DENIED', message: '只能查看这份文档，不能编辑' })
    expect(store.repositories.documents.lockById).not.toHaveBeenCalled()
    expect(store.leases.lockByDocument).not.toHaveBeenCalled()
    expect(store.leaseRecords.get(document.id)).toMatchObject({ holderId: ALICE, takeover: null })
    expect(store.audits).toEqual([])
  })

  it('强制接管锁下再判断：不加锁时是空间管理员、拿到文档行的锁时已被降为编辑者——403（只有空间管理员能…），不锁租约行、什么也不写', async () => {
    const setupResult = setup()
    const { store, document } = setupResult
    await acquired(setupResult)
    store.setMember(TEAM_SPACE, BOB, 'admin')
    store.leases.lockByDocument.mockClear()
    store.repositories.documents.lockById.mockImplementationOnce(async (id: string) => {
      store.setMember(TEAM_SPACE, BOB, 'editor')
      return store.documents.get(id)
    })
    expect(await rejection(claim(setupResult, BEN, OTHER_TAB, 'force'))).toMatchObject({ code: 'PERMISSION_DENIED', message: '只有空间管理员能强制接管这份文档的编辑' })
    expect(store.leases.lockByDocument).not.toHaveBeenCalled()
    expect(store.leaseRecords.get(document.id)).toMatchObject({ holderId: ALICE, takeover: null })
    expect(store.documents.get(document.id)?.writeEpoch).toBe(1)
    expect(store.audits).toEqual([])
  })

  it('本人接管只要能编辑（不要求能强制接管）：编辑者照样本人接管自己的租约', async () => {
    const setupResult = setup()
    const { store, document } = setupResult
    const taken = await acquired(setupResult)
    expect(await claim(setupResult, AMY_ELSEWHERE, OTHER_TAB, 'self')).toMatchObject({ kind: 'acquired' })
    expect(store.leaseRecords.get(document.id)).toMatchObject({ takenOverTokenDigest: editLeaseTokenDigest(taken), takeover: 'self' })
  })

  it('日志：接管时一条 debug，上一代记 taken_over 与方式，不带令牌', async () => {
    const setupResult = setup()
    const { store, document, logs, logText } = setupResult
    const taken = await acquired(setupResult)
    store.setMember(TEAM_SPACE, BOB, 'admin')
    await claim(setupResult, BEN, OTHER_TAB, 'force')
    expect(logs().at(-1)).toMatchObject({ level: 'debug', msg: '申请编辑权：取得新的一代', documentId: document.id, writeEpoch: 2, previous: 'taken_over', takeover: 'forced' })
    expect(logText()).not.toContain(taken)
  })
})

describe('EditLeaseService.renew', () => {
  it('有效：续租（续租的时间是 now，到期往后推，最后活动按上报的空闲秒数）；先判断能编辑、再锁租约行、再读文档的代次', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const token = await acquired(setupResult)
    later(store, 60 * SECOND)
    const renewed = await service.renew(AMY, document.id, renewal(15), token, TRANSACTION)
    expect(renewed).toEqual({ expiresAt: new Date(store.databaseNow.getTime() + EDIT_LEASE_TTL_SECONDS * SECOND) })
    expect(store.leases.renew).toHaveBeenCalledWith(document.id, 15, TRANSACTION)
    expect(store.leaseRecords.get(document.id)).toMatchObject({ renewedAt: store.databaseNow, lastActiveAt: new Date(store.databaseNow.getTime() - 15 * SECOND) })
    // 这次续租的两次读文档（判断能编辑、锁住租约行之后读代次）夹着锁租约行与登录的核对（申请时已经各调过一次）
    const reads = store.repositories.documents.findById.mock.invocationCallOrder.slice(-2)
    const steps = [reads[0], orderOf(store.leases.lockByDocument, 1), store.sessions.isActive.mock.invocationCallOrder.at(-1), reads[1], orderOf(store.leases.renew)]
    expect(steps).toEqual(steps.toSorted((a, b) => (a ?? 0) - (b ?? 0)))
    // 心跳不锁文档行
    expect(store.repositories.documents.lockById).toHaveBeenCalledTimes(1)
  })

  it('看不到 404、只能查看 403：在锁租约行之前', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const token = await acquired(setupResult)
    store.leases.lockByDocument.mockClear()
    expect((await rejection(service.renew({ userId: CAROL, sessionId: BOB_SESSION }, document.id, renewal(0), token, TRANSACTION))).code).toBe('NOT_FOUND')
    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    expect((await rejection(service.renew(AMY, document.id, renewal(0), token, TRANSACTION))).code).toBe('PERMISSION_DENIED')
    expect(store.leases.lockByDocument).not.toHaveBeenCalled()
  })

  it('不再有效：EDIT_LEASE_LOST，details 带原因，不续租', async () => {
    const lostWith = async (prepare: (s: Setup, token: string) => Promise<{ actor?: EditingActor, token?: string | undefined }>): Promise<unknown> => {
      const setupResult = setup()
      const token = await acquired(setupResult)
      const request = await prepare(setupResult, token)
      const error = await rejection(setupResult.service.renew(request.actor ?? AMY, setupResult.document.id, renewal(0), 'token' in request ? request.token : token, TRANSACTION))
      expect(error.code).toBe('EDIT_LEASE_LOST')
      expect(setupResult.store.leases.renew).not.toHaveBeenCalled()
      return error.details
    }
    expect(await lostWith(async () => ({ token: undefined }))).toEqual({ reason: 'none' })
    expect(await lostWith(async ({ service, document }) => {
      await service.acquire(AMY, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION)
      return {}
    })).toEqual({ reason: 'replaced' })
    expect(await lostWith(async ({ store, document }) => {
      await store.leases.end(document.id, 'released')
      return {}
    })).toEqual({ reason: 'released' })
    expect(await lostWith(async ({ store, document }) => {
      await store.repositories.documents.advanceWriteEpoch(document.id)
      return {}
    })).toEqual({ reason: 'stale' })
    expect(await lostWith(async ({ store }) => {
      later(store, EDIT_LEASE_TTL_SECONDS * SECOND)
      return {}
    })).toEqual({ reason: 'expired' })
    expect(await lostWith(async () => ({ actor: { userId: ALICE, sessionId: ALICE_OTHER_SESSION } }))).toEqual({ reason: 'session' })
  })

  it('M3-P5 被接管的那一代：EDIT_LEASE_LOST 的详情是 taken_over 与方式（本人在别处接手 false、空间管理员强制接管 true），页面据此不续上；之后又换过一代的旧令牌是 replaced、不带方式；日志带方式', async () => {
    for (const [taker, takeover, forced] of [[{ userId: ALICE, sessionId: ALICE_OTHER_SESSION }, 'self', false], [BEN, 'force', true]] as const) {
      const setupResult = setup()
      const { store, service, document, logs } = setupResult
      store.setMember(TEAM_SPACE, BOB, 'admin')
      const taken = await acquired(setupResult)
      const outcome = await service.acquire(taker, document.id, leaseRequest(OTHER_TAB, CURRENT_CLIENT, 0, takeover), HTTP_ORIGIN, TRANSACTION)
      const error = await rejection(service.renew(AMY, document.id, renewal(0), taken, TRANSACTION))
      expect([error.code, error.details], takeover).toEqual(['EDIT_LEASE_LOST', { reason: 'taken_over', forced }])
      expect(logs().at(-1), takeover).toMatchObject({ msg: '续租失败：编辑权已失效', reason: 'taken_over', forced })
      expect(store.leases.renew, takeover).not.toHaveBeenCalled()
      // 接管者又换了一代（同一个人在别的标签页申请）：接管标记只记一层，最初那一代的令牌是 replaced
      if (outcome.kind !== 'acquired')
        throw new Error('期望接管成功')
      await service.release(taker, document.id, outcome.token, TRANSACTION)
      await service.acquire(taker, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION)
      expect((await rejection(service.renew(AMY, document.id, renewal(0), taken, TRANSACTION))).details, takeover).toEqual({ reason: 'replaced' })
    }
  })

  it('这次登录在锁住租约行之后再核对（M3-P1 审查 A1）：被撤销时 401 SESSION_EXPIRED，不续租', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const token = await acquired(setupResult)
    store.activeSessions.delete(ALICE_SESSION)
    const error = await rejection(service.renew(AMY, document.id, renewal(0), token, TRANSACTION))
    expect([error.code, error.status]).toEqual(['SESSION_EXPIRED', 401])
    expect(store.leases.renew).not.toHaveBeenCalled()
    expect(orderOf(store.leases.lockByDocument, 1)).toBeLessThan(store.sessions.isActive.mock.invocationCallOrder.at(-1) ?? 0)
  })

  it('失效时先再判断一次能编辑（M3-P1 审查 A2）：等租约行的锁期间被降为查看者、被移出（撤权结束了租约），回 403 / 404 而不是 revoked', async () => {
    for (const [role, code] of [['viewer', 'PERMISSION_DENIED'], [undefined, 'NOT_FOUND']] as const) {
      const setupResult = setup()
      const { store, service, document } = setupResult
      const token = await acquired(setupResult)
      store.leases.lockByDocument.mockImplementationOnce(async (documentId: string) => {
        // 撤权在这期间提交：成员的角色变了，租约记 revoked
        store.setMember(TEAM_SPACE, ALICE, role)
        await store.leases.end(documentId, 'revoked')
        const row = store.leaseRecords.get(documentId)
        return row === undefined ? undefined : { ...row, now: store.databaseNow }
      })
      expect((await rejection(service.renew(AMY, document.id, renewal(0), token, TRANSACTION))).code, String(role)).toBe(code)
      expect(store.leases.renew).not.toHaveBeenCalled()
    }
  })

  it('没有租约：none', async () => {
    const { service, document } = setup()
    const error = await rejection(service.renew(AMY, document.id, renewal(0), 'x'.repeat(43), TRANSACTION))
    expect([error.code, error.details]).toEqual(['EDIT_LEASE_LOST', { reason: 'none' }])
  })

  it('文档的代次在锁住租约行之后才读：等租约行的锁时别人收回了写入权、移动了文档（代次加一），按新的代次判断（stale）', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const token = await acquired(setupResult)
    store.leases.lockByDocument.mockImplementationOnce(async (documentId: string) => {
      await store.repositories.documents.advanceWriteEpoch(documentId)
      const row = store.leaseRecords.get(documentId)
      return row === undefined ? undefined : { ...row, now: store.databaseNow }
    })
    expect((await rejection(service.renew(AMY, document.id, renewal(0), token, TRANSACTION))).details).toEqual({ reason: 'stale' })
  })

  it('锁住租约行之后文档读不到了（删除）：NOT_FOUND', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const token = await acquired(setupResult)
    store.leases.lockByDocument.mockImplementationOnce(async (documentId: string) => {
      store.documentEntries.set(documentId, 'entry')
      const row = store.leaseRecords.get(documentId)
      return row === undefined ? undefined : { ...row, now: store.databaseNow }
    })
    expect((await rejection(service.renew(AMY, document.id, renewal(0), token, TRANSACTION))).code).toBe('NOT_FOUND')
  })

  it('日志：失效时一条 debug，带文档 id 与原因，不带令牌', async () => {
    const setupResult = setup()
    const { store, service, document, logs, logText } = setupResult
    const token = await acquired(setupResult)
    later(store, EDIT_LEASE_TTL_SECONDS * SECOND)
    await rejection(service.renew(AMY, document.id, renewal(0), token, TRANSACTION))
    expect(logs().at(-1)).toMatchObject({ level: 'debug', msg: '续租失败：编辑权已失效', documentId: document.id, reason: 'expired' })
    expect(logText()).not.toContain(token)
  })
})

describe('EditLeaseService.release', () => {
  it('令牌是当前这一行的、没有明确结束：记 released', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const token = await acquired(setupResult)
    await service.release(AMY, document.id, token, TRANSACTION)
    expect(store.leaseRecords.get(document.id)).toMatchObject({ endedAt: store.databaseNow, endReason: 'released' })
  })

  it('没带令牌、令牌不是这一行的、已经结束的、没有租约：什么也不做', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await service.release(AMY, document.id, 'x'.repeat(43), TRANSACTION)
    const token = await acquired(setupResult)
    await service.release(AMY, document.id, undefined, TRANSACTION)
    await service.release(AMY, document.id, 'y'.repeat(43), TRANSACTION)
    expect(store.leases.end).not.toHaveBeenCalled()
    await store.leases.end(document.id, 'revoked')
    store.leases.end.mockClear()
    await service.release(AMY, document.id, token, TRANSACTION)
    expect(store.leases.end).not.toHaveBeenCalled()
    expect(store.leaseRecords.get(document.id)?.endReason).toBe('revoked')
  })

  it('释放的人要是持有者（M3-P1 审查 A4）：别人拿到了令牌也不能结束这一代；同一个人换了登录照样能释放（续上之前先释放自己那一代）', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const token = await acquired(setupResult)
    await service.release(BEN, document.id, token, TRANSACTION)
    expect(store.leaseRecords.get(document.id)?.endReason).toBeNull()
    await service.release({ userId: ALICE, sessionId: ALICE_OTHER_SESSION }, document.id, token, TRANSACTION)
    expect(store.leaseRecords.get(document.id)?.endReason).toBe('released')
  })

  it('能读就行（读不到 404，在锁租约行之前）：持有者被降为查看者之后仍能释放；到期的也能释放（之后不再算异常结束）', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const token = await acquired(setupResult)
    expect((await rejection(service.release({ userId: CAROL, sessionId: BOB_SESSION }, document.id, token, TRANSACTION))).code).toBe('NOT_FOUND')
    expect(store.leases.lockByDocument).toHaveBeenCalledTimes(1)
    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    later(store, EDIT_LEASE_TTL_SECONDS * SECOND)
    await service.release(AMY, document.id, token, TRANSACTION)
    expect(store.leaseRecords.get(document.id)?.endReason).toBe('released')
  })
})

describe('EditLeaseService.status', () => {
  it('有效的租约：修订号与持有者、最后活动时间、是不是调用者自己、是不是调用者这次登录；能读就能看（查看者也看得到）', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    const lastActiveAt = store.leaseRecords.get(document.id)?.lastActiveAt
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect(await service.status(BEN, document.id, TRANSACTION)).toEqual({ revision: 3, editor: { holderId: ALICE, lastActiveAt, sameUser: false, sameSession: false }, canEdit: false, canTakeOver: false, formulasPending: false })
    expect(await service.status(AMY, document.id, TRANSACTION)).toEqual({ revision: 3, editor: { holderId: ALICE, lastActiveAt, sameUser: true, sameSession: true }, canEdit: true, canTakeOver: false, formulasPending: false })
    // 同一个人的另一个登录（别的设备）：是本人，不是这次登录
    expect((await service.status({ userId: ALICE, sessionId: ALICE_OTHER_SESSION }, document.id, TRANSACTION)).editor).toEqual({ holderId: ALICE, lastActiveAt, sameUser: true, sameSession: false })
    expect(store.leases.findByDocument).toHaveBeenCalledWith(document.id, TRANSACTION)
    expect(store.leases.lockByDocument).toHaveBeenCalledTimes(1)
  })

  it('没有租约、租约无效（到期、登录失效、没了编辑权）：editor 为空；异常结束的（到期、登录失效）带上提醒（M3-P5），没了编辑权的不带', async () => {
    const { service, document } = setup()
    expect(await service.status(BEN, document.id, TRANSACTION)).toStrictEqual({ revision: 3, editor: undefined, canEdit: true, canTakeOver: false, formulasPending: false, request: undefined, reservation: undefined, interruption: undefined })
    for (const [name, invalidate, notice] of [
      ['到期', ({ store }: Setup) => later(store, EDIT_LEASE_TTL_SECONDS * SECOND), true],
      ['登录失效', ({ store }: Setup) => void store.activeSessions.delete(ALICE_SESSION), true],
      ['没了编辑权', ({ store }: Setup) => store.setMember(TEAM_SPACE, ALICE, 'viewer'), false],
    ] as const) {
      const setupResult = setup()
      await acquired(setupResult)
      const renewedAt = setupResult.store.leaseRecords.get(setupResult.document.id)?.renewedAt
      invalidate(setupResult)
      expect(await setupResult.service.status(BEN, setupResult.document.id, TRANSACTION), name).toStrictEqual({ revision: 3, editor: undefined, canEdit: true, canTakeOver: false, formulasPending: false, request: undefined, reservation: undefined, interruption: notice ? { holderId: ALICE, endedAt: renewedAt, sameUser: false } : undefined })
    }
  })

  it('US-M3-10 编辑状态里的提醒与申请同一个算法（M3-P5 设计 §3.5）：有人在编辑时没有；没人在编辑、异常结束在 30 分钟以内时有，带上是不是调用者自己；超过 30 分钟、明确释放的没有', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    const renewedAt = store.leaseRecords.get(document.id)?.renewedAt
    expect((await service.status(BEN, document.id, TRANSACTION)).interruption).toBeUndefined()
    later(store, 30 * 60 * SECOND)
    expect((await service.status(BEN, document.id, TRANSACTION)).interruption).toEqual({ holderId: ALICE, endedAt: renewedAt, sameUser: false })
    expect((await service.status(AMY, document.id, TRANSACTION)).interruption).toEqual({ holderId: ALICE, endedAt: renewedAt, sameUser: true })
    later(store, 1)
    expect((await service.status(BEN, document.id, TRANSACTION)).interruption).toBeUndefined()

    const released = setup()
    const releasedToken = await acquired(released)
    await released.service.release(AMY, released.document.id, releasedToken, TRANSACTION)
    later(released.store, EDIT_LEASE_TTL_SECONDS * SECOND)
    expect((await released.service.status(BEN, released.document.id, TRANSACTION)).interruption).toBeUndefined()
  })

  it('M3-P5 R2：代次过时、而按时间、登录、编辑权都还活着——别人看到有人在编辑（与申请得到的被占用一致），持有者本人看是空着的；都没有提醒', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    const lastActiveAt = store.leaseRecords.get(document.id)?.lastActiveAt
    await store.repositories.documents.advanceWriteEpoch(document.id)
    expect(await service.status(BEN, document.id, TRANSACTION)).toMatchObject({ editor: { holderId: ALICE, lastActiveAt, sameUser: false, sameSession: false }, interruption: undefined })
    expect(await service.status(AMY, document.id, TRANSACTION)).toMatchObject({ editor: undefined, interruption: undefined })
    // 到期之后谁看都是空着的，提醒照样给（代次过时不遮住异常结束）
    later(store, EDIT_LEASE_TTL_SECONDS * SECOND)
    expect(await service.status(BEN, document.id, TRANSACTION)).toMatchObject({ editor: undefined, interruption: { holderId: ALICE, sameUser: false } })
  })

  it('US-M3-05 调用者能不能编辑（M3-P2 设计 §3.2）：与详情的 permissions.canEdit 同一个规则——编辑者能，查看者、归档空间里的空间管理员、只有查看授权的人不能，只有编辑授权的人能；不多查询', async () => {
    const { store, service, document } = setup()
    expect((await service.status(BEN, document.id, TRANSACTION)).canEdit).toBe(true)
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect((await service.status(BEN, document.id, TRANSACTION)).canEdit).toBe(false)
    // 只凭授权：查看授权不能、编辑授权能（内容权限取较高者）
    store.setMember(TEAM_SPACE, BOB, undefined)
    store.setGrant(document.id, BOB, 'viewer')
    expect((await service.status(BEN, document.id, TRANSACTION)).canEdit).toBe(false)
    store.setGrant(document.id, BOB, 'editor')
    expect((await service.status(BEN, document.id, TRANSACTION)).canEdit).toBe(true)
    // 归档的空间里所有人至多是查看者
    store.setMember(TEAM_SPACE, ALICE, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    expect((await service.status(AMY, document.id, TRANSACTION)).canEdit).toBe(false)
    expect((await service.status(BEN, document.id, TRANSACTION)).canEdit).toBe(false)
    // 与判断能读的那一次用同一份事实：空间事实与授权各查一次，没有另外的查询
    store.spaces.accessFactsOf.mockClear()
    store.grants.roleOf.mockClear()
    await service.status(BEN, document.id, TRANSACTION)
    expect([store.spaces.accessFactsOf.mock.calls.length, store.grants.roleOf.mock.calls.length]).toEqual([1, 1])
  })

  it('M3-P5 调用者能不能强制接管：与详情的 permissions.canTakeOver 同一个规则——空间管理员能，编辑者、只凭授权的编辑者、归档空间里的空间管理员不能；不多查询', async () => {
    const { store, service, document } = setup()
    expect((await service.status(BEN, document.id, TRANSACTION)).canTakeOver).toBe(false)
    store.setMember(TEAM_SPACE, BOB, 'admin')
    expect((await service.status(BEN, document.id, TRANSACTION)).canTakeOver).toBe(true)
    store.setMember(TEAM_SPACE, BOB, undefined)
    store.setGrant(document.id, BOB, 'editor')
    expect(await service.status(BEN, document.id, TRANSACTION)).toMatchObject({ canEdit: true, canTakeOver: false })
    store.setMember(TEAM_SPACE, ALICE, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    expect((await service.status(AMY, document.id, TRANSACTION)).canTakeOver).toBe(false)
    store.spaces.accessFactsOf.mockClear()
    store.grants.roleOf.mockClear()
    await service.status(BEN, document.id, TRANSACTION)
    expect([store.spaces.accessFactsOf.mock.calls.length, store.grants.roleOf.mock.calls.length]).toEqual([1, 1])
  })

  it('读不到：NOT_FOUND，不读租约', async () => {
    const { store, service, document } = setup()
    expect((await rejection(service.status({ userId: CAROL, sessionId: BOB_SESSION }, document.id, TRANSACTION))).code).toBe('NOT_FOUND')
    expect(store.leases.findByDocument).not.toHaveBeenCalled()
  })
})

describe('拦截旧客户端（M3-P3 设计 §3.5）：申请与心跳先核对页面的构建与数据格式，文档比服务端新时只能阅读', () => {
  /** 过旧的页面的几种上报：数据格式不同或没上报（format），构建没上报（build） */
  const OUTDATED = [
    ['Univer 版本不同', { ...CURRENT_CLIENT, univerVersion: '0.9.0' }, 'format'],
    ['插件档案不同', { ...CURRENT_CLIENT, profile: 'sheet@0' }, 'format'],
    ['平台格式版本不同', { ...CURRENT_CLIENT, formatVersion: 2 }, 'format'],
    ['P3 之前的页面（什么也没上报）', {}, 'format'],
    ['没上报构建', { univerVersion: CURRENT_CLIENT.univerVersion, profile: CURRENT_CLIENT.profile, formatVersion: CURRENT_CLIENT.formatVersion }, 'build'],
  ] as const

  it.each(OUTDATED)('申请：%s → 409 CLIENT_OUTDATED（原因 %s 见 details），在任何查询之前（看不到与不存在得到同样的回答），什么也不写', async (_case, format, reason) => {
    const { store, service, document } = setup()
    for (const target of [document.id, '0199a2c4-0000-7000-8000-0000000000ff']) {
      const error = await rejection(service.acquire(AMY, target, leaseRequest(TAB, format), HTTP_ORIGIN, TRANSACTION))
      expect([error.code, error.status, error.details]).toEqual(['CLIENT_OUTDATED', 409, { reason }])
    }
    expect(store.repositories.documents.findById).not.toHaveBeenCalled()
    expect(store.leaseRecords.size).toBe(0)
  })

  it.each(OUTDATED)('心跳：%s → 409 CLIENT_OUTDATED（原因 %s），在任何查询之前、不续租：服务端升级之后，正在编辑的页面一次心跳之内就停下', async (_case, format, reason) => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const token = await acquired(setupResult)
    store.repositories.documents.findById.mockClear()
    const error = await rejection(service.renew(AMY, document.id, renewal(0, format), token, TRANSACTION))
    expect([error.code, error.details]).toEqual(['CLIENT_OUTDATED', { reason }])
    expect(store.repositories.documents.findById).not.toHaveBeenCalled()
    expect(store.leases.renew).not.toHaveBeenCalled()
  })

  it('运维开关（NERVE_MIN_CLIENT_BUILD）：构建低于它 → CLIENT_OUTDATED（build）；等于、高于它照常（+ 之后的诊断信息不比较）', async () => {
    for (const [build, outcome] of [['0.1.9', 'CLIENT_OUTDATED'], ['0.2.0', 'acquired'], ['0.2.0+abc123', 'acquired'], ['1.0.0', 'acquired']] as const) {
      const { store, document } = setup()
      const { documents, revisions, leases, policy, sessions, audit } = store.deps
      const service = new EditLeaseService(documents, revisions, leases, policy, sessions, clientFormatGate('0.2.0'), audit, store.logger)
      const result = await service.acquire(AMY, document.id, leaseRequest(TAB, { ...CURRENT_CLIENT, clientBuild: build }), HTTP_ORIGIN, TRANSACTION).then(value => value.kind, (error: AppError) => `${error.code}:${String((error.details as { reason?: string } | undefined)?.reason)}`)
      expect(result, build).toBe(outcome === 'acquired' ? 'acquired' : 'CLIENT_OUTDATED:build')
    }
  })

  it('文档由比服务端新的版本写过（回滚之后，SDK 版本更高或认不出）：申请 409 DOCUMENT_TOO_NEW，在判断访问、编辑权与登录之后，不加代次、不写租约', async () => {
    for (const sdkVersion of ['99.0.0', 'not-a-version']) {
      const { store, service, document } = setup()
      store.documents.set(document.id, { ...document, sdkVersion })
      const error = await rejection(service.acquire(AMY, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION))
      expect([error.code, error.status]).toEqual(['DOCUMENT_TOO_NEW', 409])
      expect(store.leaseRecords.has(document.id)).toBe(false)
      expect(store.documents.get(document.id)?.writeEpoch).toBe(0)
      // 看不到的照样 404（不透露它比服务端新）；只能查看的照样 403
      expect((await rejection(service.acquire({ userId: CAROL, sessionId: BOB_SESSION }, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION))).code).toBe('NOT_FOUND')
      store.setMember(TEAM_SPACE, BOB, 'viewer')
      expect((await rejection(service.acquire(BEN, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION))).code).toBe('PERMISSION_DENIED')
    }
    // 比服务端旧的（升级之后）照常申请
    const older = setup()
    older.store.documents.set(older.document.id, { ...older.document, sdkVersion: '0.9.9' })
    expect((await older.service.acquire(AMY, older.document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION)).kind).toBe('acquired')
  })

  it('心跳时文档比服务端新：DOCUMENT_TOO_NEW，不续租', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const token = await acquired(setupResult)
    store.documents.set(document.id, { ...store.documents.get(document.id) ?? document, sdkVersion: '99.0.0' })
    expect((await rejection(service.renew(AMY, document.id, renewal(0), token, TRANSACTION))).code).toBe('DOCUMENT_TOO_NEW')
    expect(store.leases.renew).not.toHaveBeenCalled()
  })
})

describe('"公式待更新"（M3-P3 设计 §3.8）：申请的结果与编辑状态给出文档行上的标记', () => {
  it('有标记的文档：申请与编辑状态都给出 true；没有标记的给出 false', async () => {
    const { store, service, document } = setup()
    expect(await service.acquire(AMY, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'acquired', formulasPending: false })
    expect((await service.status(BEN, document.id, TRANSACTION)).formulasPending).toBe(false)
    store.documents.set(document.id, { ...store.documents.get(document.id) ?? document, formulasPending: true })
    expect(await service.acquire(AMY, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'acquired', formulasPending: true })
    expect((await service.status(BEN, document.id, TRANSACTION)).formulasPending).toBe(true)
  })
})

describe('M3-P5 请求编辑与交出之后的保留（设计 §3.3、§3.6）：申请判断保留，被占用的详情、心跳与编辑状态带上待回应的请求', () => {
  const CAROL_SESSION = '0199a2c4-0000-7000-8000-0000000000e4'
  const BOB_OTHER_SESSION = '0199a2c4-0000-7000-8000-0000000000e9'
  const CAT: EditingActor = { userId: CAROL, sessionId: CAROL_SESSION }
  const REQUEST = '0199a2c4-0000-7000-8000-0000000000aa'

  /** 艾米、本是编辑者（setup），卡萝尔另加为编辑者、登录有效 */
  function withCarol(): Setup {
    const setupResult = setup()
    setupResult.store.setMember(TEAM_SPACE, CAROL, 'editor')
    setupResult.store.activeSessions.add(CAROL_SESSION)
    return setupResult
  }

  /** 改这份文档的租约行（用例摆好的） */
  function patchLease({ store, document }: Setup, changes: Partial<EditLeaseRow>): void {
    const row = store.leaseRecords.get(document.id)
    if (row === undefined)
      throw new Error('没有租约')
    store.leaseRecords.set(document.id, { ...row, ...changes })
  }

  /** 槽里摆一个本的请求（一分钟前发出，还有 9 分钟有效），declined 时持有者已经谢绝 */
  function putRequest(setupResult: Setup, declined = false): void {
    const now = setupResult.store.databaseNow.getTime()
    patchLease(setupResult, { requestId: REQUEST, requestedBy: BOB, requestSessionId: BOB_SESSION, requestedAt: new Date(now - 60 * SECOND), requestExpiresAt: new Date(now + 540 * SECOND), requestDeclinedAt: declined ? new Date(now) : null })
  }

  /** 交出了：明确结束（handed_over），留给本到 until（默认 2 分钟之后） */
  function putReservation(setupResult: Setup, until: Date = new Date(setupResult.store.databaseNow.getTime() + 120 * SECOND)): void {
    patchLease(setupResult, { endedAt: setupResult.store.databaseNow, endReason: 'handed_over', reservedFor: BOB, reservedUntil: until })
  }

  it('保留期内别人申请：reserved（留给谁、到何时），什么也不写——代次不加、租约行不动；普通的申请、本人接管、强制接管、交出的人自己都一样', async () => {
    const setupResult = withCarol()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    putReservation(setupResult)
    const before = store.leaseRecords.get(document.id)
    store.setMember(TEAM_SPACE, CAROL, 'admin')
    for (const takeover of [undefined, 'self', 'force'] as const)
      expect(await service.acquire(CAT, document.id, leaseRequest(TAB, CURRENT_CLIENT, 0, takeover), HTTP_ORIGIN, TRANSACTION), String(takeover)).toEqual({ kind: 'reserved', reservedFor: BOB, reservedUntil: before?.reservedUntil })
    expect((await service.acquire(AMY, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION)).kind).toBe('reserved')
    expect(store.leaseRecords.get(document.id)).toEqual(before)
    expect(store.documents.get(document.id)?.writeEpoch).toBe(1)
    expect(store.repositories.documents.advanceWriteEpoch).toHaveBeenCalledTimes(1)
    expect(store.audits).toEqual([])
  })

  it('被保留的人申请：照常取得（用哪个登录、哪个标签页都行），新的一代清掉保留与交出', async () => {
    const setupResult = withCarol()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    putReservation(setupResult)
    store.activeSessions.add(BOB_OTHER_SESSION)
    const outcome = await service.acquire({ userId: BOB, sessionId: BOB_OTHER_SESSION }, document.id, leaseRequest(OTHER_TAB), HTTP_ORIGIN, TRANSACTION)
    expect(outcome).toMatchObject({ kind: 'acquired', writeEpoch: 2, interruption: undefined })
    expect(store.leaseRecords.get(document.id)).toMatchObject({ holderId: BOB, endReason: null, reservedFor: null, reservedUntil: null })
  })

  it('保留不算数了：恰好到期（与租约的到期同一个边界）、被保留的人没了编辑权——别人照常取得', async () => {
    for (const [name, spoil] of [
      ['恰好到期', (setupResult: Setup) => putReservation(setupResult, setupResult.store.databaseNow)],
      ['被保留的人没了编辑权', (setupResult: Setup) => {
        putReservation(setupResult)
        setupResult.store.setMember(TEAM_SPACE, BOB, 'viewer')
      }],
    ] as const) {
      const setupResult = withCarol()
      await acquired(setupResult)
      spoil(setupResult)
      expect((await setupResult.service.acquire(CAT, setupResult.document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION)).kind, name).toBe('acquired')
    }
  })

  it('被占用的详情带上待回应的请求（请求方、时刻、是不是调用者自己）；已谢绝的不带', async () => {
    const setupResult = withCarol()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    putRequest(setupResult)
    const requestedAt = store.leaseRecords.get(document.id)?.requestedAt
    expect(await service.acquire(CAT, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'held', holderId: ALICE, request: { requesterId: BOB, requestedAt, mine: false } })
    expect(await service.acquire(BEN, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'held', request: { requesterId: BOB, mine: true } })
    putRequest(setupResult, true)
    expect(await service.acquire(CAT, document.id, leaseRequest(TAB), HTTP_ORIGIN, TRANSACTION)).toMatchObject({ kind: 'held', request: undefined })
  })

  it('心跳带上待回应的请求（标识、请求方、发出的时刻）；没有请求、已谢绝、已过期、请求方的登录失效或没了编辑权时不带', async () => {
    const setupResult = withCarol()
    const { store, service, document } = setupResult
    const token = await acquired(setupResult)
    expect((await service.renew(AMY, document.id, renewal(0), token, TRANSACTION)).request).toBeUndefined()
    putRequest(setupResult)
    const requestedAt = store.leaseRecords.get(document.id)?.requestedAt
    expect((await service.renew(AMY, document.id, renewal(0), token, TRANSACTION)).request).toEqual({ id: REQUEST, requesterId: BOB, requestedAt })
    const spoilers: readonly (readonly [string, () => void])[] = [
      ['已谢绝', () => putRequest(setupResult, true)],
      ['已过期', () => {
        putRequest(setupResult)
        patchLease(setupResult, { requestExpiresAt: store.databaseNow })
      }],
      ['请求方的登录失效', () => {
        putRequest(setupResult)
        store.activeSessions.delete(BOB_SESSION)
      }],
      ['请求方没了编辑权', () => {
        store.activeSessions.add(BOB_SESSION)
        store.setMember(TEAM_SPACE, BOB, 'viewer')
      }],
    ]
    for (const [name, spoil] of spoilers) {
      spoil()
      expect((await service.renew(AMY, document.id, renewal(0), token, TRANSACTION)).request, name).toBeUndefined()
    }
  })

  it('编辑状态带上待回应的请求（所有能读的人都看得到，mine 只对请求方为真）；没人在编辑了而请求还在等时照样给出；已谢绝的不给', async () => {
    const setupResult = withCarol()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    putRequest(setupResult)
    const requestedAt = store.leaseRecords.get(document.id)?.requestedAt
    store.setMember(TEAM_SPACE, CAROL, 'viewer')
    expect((await service.status(CAT, document.id, TRANSACTION)).request).toEqual({ requesterId: BOB, requestedAt, mine: false })
    expect((await service.status(BEN, document.id, TRANSACTION)).request).toEqual({ requesterId: BOB, requestedAt, mine: true })
    expect((await service.status(AMY, document.id, TRANSACTION)).request).toEqual({ requesterId: BOB, requestedAt, mine: false })
    later(store, EDIT_LEASE_TTL_SECONDS * SECOND)
    expect(await service.status(CAT, document.id, TRANSACTION)).toMatchObject({ editor: undefined, request: { requesterId: BOB, mine: false } })
    putRequest(setupResult, true)
    expect((await service.status(CAT, document.id, TRANSACTION)).request).toBeUndefined()
  })

  it('编辑状态带上算数的保留（留给谁、到何时、mine 只对被保留的人为真）；被保留的人没了编辑权、过期时不给；交出不算异常结束，没有提醒', async () => {
    const setupResult = withCarol()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    putReservation(setupResult)
    const reservedUntil = store.leaseRecords.get(document.id)?.reservedUntil
    expect(await service.status(CAT, document.id, TRANSACTION)).toMatchObject({ editor: undefined, reservation: { reservedFor: BOB, reservedUntil, mine: false }, interruption: undefined })
    expect((await service.status(BEN, document.id, TRANSACTION)).reservation).toEqual({ reservedFor: BOB, reservedUntil, mine: true })
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect((await service.status(CAT, document.id, TRANSACTION)).reservation).toBeUndefined()
    store.setMember(TEAM_SPACE, BOB, 'editor')
    later(store, 120 * SECOND)
    expect((await service.status(CAT, document.id, TRANSACTION)).reservation).toBeUndefined()
  })
})
