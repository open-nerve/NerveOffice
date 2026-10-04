// 编辑租约的服务（M3-P1 设计 §3.4.2、§3.4.3）：申请、心跳续租、释放与编辑状态的步骤、加锁的先后、每个分支写了什么没写什么、
// 日志。有效条件本身在 edit-lease-rules.test.ts；SQL、并发与真实的时间在集成测试（documents/edit-leases.test.ts）。
import type { AppError } from '../../shared/errors/app-error.ts'
import type { EditingActor } from './edit-lease.service.ts'
import { Buffer } from 'node:buffer'
import { EDIT_LEASE_IDLE_RECLAIM_SECONDS, EDIT_LEASE_TTL_SECONDS, editLeaseTokenSchema } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { ALICE, BOB, FakeStore, TEAM_SPACE, TRANSACTION } from './documents.test-support.ts'
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
  const { documents, revisions, leases, policy, sessions } = store.deps
  const service = new EditLeaseService(documents, revisions, leases, policy, sessions, logger)
  return { store, service, document, logs: () => lines.map(line => JSON.parse(line) as Record<string, unknown>), logText: () => lines.join('') }
}

type Setup = ReturnType<typeof setup>

/** 让"数据库时间"往后走 */
function later(store: FakeStore, milliseconds: number): void {
  store.databaseNow = new Date(store.databaseNow.getTime() + milliseconds)
}

/** 取得一代，返回令牌 */
async function acquired({ service, document }: Setup, actor: EditingActor = AMY, tab: string = TAB): Promise<string> {
  const outcome = await service.acquire(actor, document.id, tab, TRANSACTION)
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
    const outcome = await service.acquire(AMY, document.id, TAB, TRANSACTION)
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
    expect(await created.service.acquire(AMY, created.document.id, TAB, TRANSACTION)).toMatchObject({ kind: 'acquired', revision: 3, source: null })

    // 本人在另一个标签页保存的：照样给出（页面再按标签页比较）
    const saved = setup()
    for (const [revision, localSeq] of [[2, 4], [3, 7]] as const)
      saved.store.addRevision({ documentId: saved.document.id, revision, kind: 'saved', requestId: `request-${revision}`, payloadDigest: Buffer.alloc(32), source: { clientInstanceId: OTHER_TAB, localSeq }, savedBy: ALICE })
    expect(await saved.service.acquire(AMY, saved.document.id, TAB, TRANSACTION)).toMatchObject({ kind: 'acquired', revision: 3, source: { clientInstanceId: OTHER_TAB, localSeq: 7 } })
    expect(saved.store.repositories.revisions.findByRevision).toHaveBeenCalledWith(saved.document.id, 3, TRANSACTION)
  })

  it('当前修订是别人保存的：来源为 null（只给保存它的人本人，M3-P1 复验 C4）——标签页标识是页面自报的，给了别人就能被照着伪造', async () => {
    const { store, service, document } = setup()
    store.addRevision({ documentId: document.id, revision: 3, kind: 'saved', requestId: 'request-3', payloadDigest: Buffer.alloc(32), source: { clientInstanceId: TAB, localSeq: 7 }, savedBy: BOB })
    expect(await service.acquire(AMY, document.id, TAB, TRANSACTION)).toMatchObject({ kind: 'acquired', revision: 3, source: null })
  })

  it('这次登录在两把锁之后再核对（M3-P1 审查 A1）：守卫之后被撤销（退出、签发重置、换令牌）时 401 SESSION_EXPIRED，什么也不写', async () => {
    const { store, service, document } = setup()
    store.activeSessions.delete(ALICE_SESSION)
    const error = await rejection(service.acquire(AMY, document.id, TAB, TRANSACTION))
    expect([error.code, error.status]).toEqual(['SESSION_EXPIRED', 401])
    expect(store.leaseRecords.has(document.id)).toBe(false)
    expect(store.documents.get(document.id)?.writeEpoch).toBe(0)
    expect(store.sessions.isActive).toHaveBeenCalledWith(ALICE_SESSION, TRANSACTION)
    const steps = [orderOf(store.repositories.documents.lockById), orderOf(store.leases.lockByDocument), orderOf(store.sessions.isActive)]
    expect(steps).toEqual(steps.toSorted((a, b) => a - b))
  })

  it('看不到 404、只能查看 403：都在加锁之前，什么也不写', async () => {
    const { store, service, document } = setup()
    expect((await rejection(service.acquire({ userId: CAROL, sessionId: BOB_SESSION }, document.id, TAB, TRANSACTION))).code).toBe('NOT_FOUND')
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect((await rejection(service.acquire(BEN, document.id, TAB, TRANSACTION))).code).toBe('PERMISSION_DENIED')
    expect((await rejection(service.acquire(AMY, '0199a2c4-0000-7000-8000-0000000000ff', TAB, TRANSACTION))).code).toBe('NOT_FOUND')
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
    expect((await rejection(service.acquire(AMY, document.id, TAB, TRANSACTION))).code).toBe('PERMISSION_DENIED')
    expect(store.leases.lockByDocument).not.toHaveBeenCalled()
    expect(store.documents.get(document.id)?.writeEpoch).toBe(0)
  })

  it('有效的租约在别人手里：被占用（持有者、最后活动时间、不是自己），什么也不写', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    const before = store.leaseRecords.get(document.id)
    later(store, 5 * SECOND)
    expect(await service.acquire(BEN, document.id, OTHER_TAB, TRANSACTION)).toEqual({ kind: 'held', holderId: ALICE, lastActiveAt: before?.lastActiveAt, sameUser: false })
    expect(store.leaseRecords.get(document.id)).toEqual(before)
    expect(store.repositories.documents.advanceWriteEpoch).toHaveBeenCalledTimes(1)
    expect(store.documents.get(document.id)?.writeEpoch).toBe(1)
  })

  it('同一个人在另一个标签页、另一个登录（别的设备）：同样被占用，sameUser 为真', async () => {
    const setupResult = setup()
    const { service, document } = setupResult
    await acquired(setupResult)
    for (const [actor, tab] of [[AMY, OTHER_TAB], [{ userId: ALICE, sessionId: ALICE_OTHER_SESSION }, TAB]] as const)
      expect(await service.acquire(actor, document.id, tab, TRANSACTION)).toMatchObject({ kind: 'held', holderId: ALICE, sameUser: true })
  })

  it('同一个登录、同一个标签页的有效租约：这个页面的重试（上次的回包丢了），发新的一代——代次再加一、换新的令牌，没有提醒', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const first = await acquired(setupResult)
    const retried = await service.acquire(AMY, document.id, TAB, TRANSACTION)
    expect(retried).toMatchObject({ kind: 'acquired', writeEpoch: 2, interruption: undefined })
    if (retried.kind !== 'acquired')
      return
    expect(retried.token).not.toBe(first)
    expect(store.leaseRecords.get(document.id)?.tokenDigest.equals(editLeaseTokenDigest(retried.token))).toBe(true)
  })

  it('当前的租约无效（到期、空闲、登录失效、没了编辑权、已释放、代次过时）：都照样发新的一代', async () => {
    const cases: readonly (readonly [string, (s: Setup) => void | Promise<void>])[] = [
      ['到期', ({ store }) => later(store, EDIT_LEASE_TTL_SECONDS * SECOND)],
      ['空闲', ({ store, document }) => {
        const row = store.leaseRecords.get(document.id)
        if (row !== undefined)
          store.leaseRecords.set(document.id, { ...row, lastActiveAt: new Date(store.databaseNow.getTime() - EDIT_LEASE_IDLE_RECLAIM_SECONDS * SECOND) })
      }],
      ['登录失效', ({ store }) => void store.activeSessions.delete(ALICE_SESSION)],
      ['没了编辑权', ({ store }) => store.setMember(TEAM_SPACE, ALICE, 'viewer')],
      ['已释放', async ({ store, document }) => void await store.leases.end(document.id, 'released')],
      ['代次过时', ({ store, document }) => void store.repositories.documents.advanceWriteEpoch(document.id)],
    ]
    for (const [name, invalidate] of cases) {
      const setupResult = setup()
      const { store, service, document } = setupResult
      await acquired(setupResult)
      await invalidate(setupResult)
      const epoch = store.documents.get(document.id)?.writeEpoch ?? 0
      expect(await service.acquire(BEN, document.id, OTHER_TAB, TRANSACTION), name).toMatchObject({ kind: 'acquired', writeEpoch: epoch + 1 })
      expect(store.leaseRecords.get(document.id), name).toMatchObject({ holderId: BOB, sessionId: BOB_SESSION, clientInstanceId: OTHER_TAB, endedAt: null, endReason: null })
    }
  })

  it('上一个租约异常结束（到期、空闲、登录失效）、在 30 分钟以内：给出提醒——上一位持有者与他最近一次续租的时间', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    const renewedAt = store.leaseRecords.get(document.id)?.renewedAt
    later(store, 20 * 60 * SECOND)
    expect(await service.acquire(BEN, document.id, OTHER_TAB, TRANSACTION)).toMatchObject({ kind: 'acquired', interruption: { holderId: ALICE, endedAt: renewedAt } })
  })

  it('不给提醒：明确释放的、没了编辑权的、超过 30 分钟的', async () => {
    const released = setup()
    await acquired(released)
    await released.store.leases.end(released.document.id, 'released')
    expect(await released.service.acquire(BEN, released.document.id, OTHER_TAB, TRANSACTION)).toMatchObject({ kind: 'acquired', interruption: undefined })

    const demoted = setup()
    await acquired(demoted)
    demoted.store.setMember(TEAM_SPACE, ALICE, 'viewer')
    expect(await demoted.service.acquire(BEN, demoted.document.id, OTHER_TAB, TRANSACTION)).toMatchObject({ kind: 'acquired', interruption: undefined })

    const old = setup()
    await acquired(old)
    later(old.store, 30 * 60 * SECOND + 1)
    expect(await old.service.acquire(BEN, old.document.id, OTHER_TAB, TRANSACTION)).toMatchObject({ kind: 'acquired', interruption: undefined })
  })

  it('第 6、7 条的事实在调用方的事务里查：持有者的登录（auth）与持有者对这份文档的编辑权（访问策略）', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    store.spaces.accessFactsOf.mockClear()
    await service.acquire(BEN, document.id, OTHER_TAB, TRANSACTION)
    expect(store.sessions.isActive).toHaveBeenCalledWith(ALICE_SESSION, TRANSACTION)
    // 访问策略判断了两个人：申请的人（不加锁、锁下各一次）与持有者
    expect(store.spaces.accessFactsOf.mock.calls.map(([userId]) => userId)).toEqual([BOB, BOB, ALICE])
  })

  it('日志：取得、被占用各一条 debug，带文档 id 与上一个租约的情形，不带令牌', async () => {
    const setupResult = setup()
    const { service, document, logs, logText } = setupResult
    const token = await acquired(setupResult)
    await service.acquire(BEN, document.id, OTHER_TAB, TRANSACTION)
    expect(logs().map(entry => [entry.level, entry.msg, entry.documentId, entry.previous ?? entry.sameUser])).toEqual([
      ['debug', '申请编辑权：取得新的一代', document.id, 'none'],
      ['debug', '申请编辑权：有效的租约在别人手里', document.id, false],
    ])
    expect(logText()).not.toContain(token)
  })
})

describe('EditLeaseService.renew', () => {
  it('有效：续租（续租的时间是 now，到期往后推，最后活动按上报的空闲秒数）；先判断能编辑、再锁租约行、再读文档的代次', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const token = await acquired(setupResult)
    later(store, 60 * SECOND)
    const renewed = await service.renew(AMY, document.id, 15, token, TRANSACTION)
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
    expect((await rejection(service.renew({ userId: CAROL, sessionId: BOB_SESSION }, document.id, 0, token, TRANSACTION))).code).toBe('NOT_FOUND')
    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    expect((await rejection(service.renew(AMY, document.id, 0, token, TRANSACTION))).code).toBe('PERMISSION_DENIED')
    expect(store.leases.lockByDocument).not.toHaveBeenCalled()
  })

  it('不再有效：EDIT_LEASE_LOST，details 带原因，不续租', async () => {
    const lostWith = async (prepare: (s: Setup, token: string) => Promise<{ actor?: EditingActor, token?: string | undefined }>): Promise<unknown> => {
      const setupResult = setup()
      const token = await acquired(setupResult)
      const request = await prepare(setupResult, token)
      const error = await rejection(setupResult.service.renew(request.actor ?? AMY, setupResult.document.id, 0, 'token' in request ? request.token : token, TRANSACTION))
      expect(error.code).toBe('EDIT_LEASE_LOST')
      expect(setupResult.store.leases.renew).not.toHaveBeenCalled()
      return error.details
    }
    expect(await lostWith(async () => ({ token: undefined }))).toEqual({ reason: 'none' })
    expect(await lostWith(async ({ service, document }) => {
      await service.acquire(AMY, document.id, TAB, TRANSACTION)
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

  it('这次登录在锁住租约行之后再核对（M3-P1 审查 A1）：被撤销时 401 SESSION_EXPIRED，不续租', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    const token = await acquired(setupResult)
    store.activeSessions.delete(ALICE_SESSION)
    const error = await rejection(service.renew(AMY, document.id, 0, token, TRANSACTION))
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
      expect((await rejection(service.renew(AMY, document.id, 0, token, TRANSACTION))).code, String(role)).toBe(code)
      expect(store.leases.renew).not.toHaveBeenCalled()
    }
  })

  it('没有租约：none', async () => {
    const { service, document } = setup()
    const error = await rejection(service.renew(AMY, document.id, 0, 'x'.repeat(43), TRANSACTION))
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
    expect((await rejection(service.renew(AMY, document.id, 0, token, TRANSACTION))).details).toEqual({ reason: 'stale' })
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
    expect((await rejection(service.renew(AMY, document.id, 0, token, TRANSACTION))).code).toBe('NOT_FOUND')
  })

  it('日志：失效时一条 debug，带文档 id 与原因，不带令牌', async () => {
    const setupResult = setup()
    const { store, service, document, logs, logText } = setupResult
    const token = await acquired(setupResult)
    later(store, EDIT_LEASE_TTL_SECONDS * SECOND)
    await rejection(service.renew(AMY, document.id, 0, token, TRANSACTION))
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
  it('有效的租约：修订号与持有者、最后活动时间、是不是调用者自己；能读就能看（查看者也看得到）', async () => {
    const setupResult = setup()
    const { store, service, document } = setupResult
    await acquired(setupResult)
    const lastActiveAt = store.leaseRecords.get(document.id)?.lastActiveAt
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    expect(await service.status(BEN, document.id, TRANSACTION)).toEqual({ revision: 3, editor: { holderId: ALICE, lastActiveAt, sameUser: false }, canEdit: false })
    expect(await service.status(AMY, document.id, TRANSACTION)).toEqual({ revision: 3, editor: { holderId: ALICE, lastActiveAt, sameUser: true }, canEdit: true })
    expect(store.leases.findByDocument).toHaveBeenCalledWith(document.id, TRANSACTION)
    expect(store.leases.lockByDocument).toHaveBeenCalledTimes(1)
  })

  it('没有租约、租约无效（到期、登录失效、没了编辑权）：editor 为空', async () => {
    const { service, document } = setup()
    expect(await service.status(BEN, document.id, TRANSACTION)).toEqual({ revision: 3, editor: undefined, canEdit: true })
    for (const invalidate of [
      ({ store }: Setup) => later(store, EDIT_LEASE_TTL_SECONDS * SECOND),
      ({ store }: Setup) => void store.activeSessions.delete(ALICE_SESSION),
      ({ store }: Setup) => store.setMember(TEAM_SPACE, ALICE, 'viewer'),
    ]) {
      const setupResult = setup()
      await acquired(setupResult)
      invalidate(setupResult)
      expect(await setupResult.service.status(BEN, setupResult.document.id, TRANSACTION)).toEqual({ revision: 3, editor: undefined, canEdit: true })
    }
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

  it('读不到：NOT_FOUND，不读租约', async () => {
    const { store, service, document } = setup()
    expect((await rejection(service.status({ userId: CAROL, sessionId: BOB_SESSION }, document.id, TRANSACTION))).code).toBe('NOT_FOUND')
    expect(store.leases.findByDocument).not.toHaveBeenCalled()
  })
})
