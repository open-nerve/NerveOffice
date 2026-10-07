// 收回写入权接上编辑租约（M3-P1 设计 §3.4.6）：五种范围各结束谁的租约、给哪些文档加代次；变化之后仍能编辑的不动；没有租约时什么也不做；
// 先锁（lockInScope）、再判断、最后各一条语句写。范围的 SQL 与 coversWriter 同义由 edit-lease-statements.test.ts 核对；
// 真实的加锁、锁下的再核对与交错由集成测试覆盖（tests/integration 的 documents/lease-revocation.test.ts）。
import type { DocumentRow } from './documents.repository.ts'
import type { EditLeaseRow } from './edit-leases.repository.ts'
import type { WriteAccessScope } from './write-access.ts'
import { Buffer } from 'node:buffer'
import { EDIT_LEASE_IDLE_RECLAIM_SECONDS, EDIT_LEASE_TTL_SECONDS } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { ALICE, ALICE_SPACE, BOB, FakeStore, NO_HANDOVER, TEAM_SPACE, TRANSACTION } from './documents.test-support.ts'
import { LeaseWriteAccessRevocation } from './lease-write-access.ts'

const CAROL = '0199a2c4-0000-7000-8000-00000000000c'
/** 另一个团队空间：艾米是编辑者，本不是成员 */
const OTHER_TEAM = '0199a2c4-0000-7000-8000-0000000000c2'
const SESSION = '0199a2c4-0000-7000-8000-0000000000e1'
const TAB = '0199a2c4-0000-7000-8000-0000000000f1'

/** 团队空间里艾米与本是编辑者；另一个团队空间里只有艾米是编辑者 */
function setup() {
  const store = new FakeStore()
  store.setMember(TEAM_SPACE, ALICE, 'editor')
  store.setMember(TEAM_SPACE, BOB, 'editor')
  store.spaceRecords.set(OTHER_TEAM, { type: 'team', name: '研发部', status: 'active', visibleToAll: false, members: new Map([[ALICE, 'editor']]) })
  const { documents, leases, policy } = store.deps
  return { store, revocation: new LeaseWriteAccessRevocation(leases, documents, policy) }
}

/** holderId 持有这份文档当前这一代的租约（代次是文档现在的代次，没有明确结束） */
function holding(store: FakeStore, document: DocumentRow, holderId: string): void {
  const now = store.databaseNow
  const writeEpoch = store.documents.get(document.id)?.writeEpoch ?? 0
  store.leaseRecords.set(document.id, {
    documentId: document.id,
    holderId,
    sessionId: SESSION,
    clientInstanceId: TAB,
    tokenDigest: Buffer.alloc(32, 1),
    writeEpoch,
    acquiredAt: now,
    renewedAt: now,
    expiresAt: new Date(now.getTime() + EDIT_LEASE_TTL_SECONDS * 1000),
    lastActiveAt: now,
    endedAt: null,
    endReason: null,
    ...NO_HANDOVER,
  })
}

/** 改这份文档上租约行的几列（时间） */
function changeLease(store: FakeStore, document: DocumentRow, changes: Partial<EditLeaseRow>): void {
  const row = store.leaseRecords.get(document.id)
  if (row === undefined)
    throw new Error(`${document.id} 没有租约`)
  store.leaseRecords.set(document.id, { ...row, ...changes })
}

/** 每份文档上租约的结束原因（没有明确结束为 null）与文档现在的代次 */
function stateOf(store: FakeStore, documents: readonly DocumentRow[]): unknown[] {
  return documents.map(document => [store.leaseRecords.get(document.id)?.endReason, store.documents.get(document.id)?.writeEpoch])
}

/** 调用方已经做完的改动：文档移到别的空间、代次加一（跨空间移动与转移的仓储一并做的） */
function movedTo(store: FakeStore, document: DocumentRow, spaceId: string): void {
  store.documents.set(document.id, { ...document, spaceId, writeEpoch: document.writeEpoch + 1 })
}

describe('LeaseWriteAccessRevocation：五种范围（M3-P1 设计 §3.4.6）', () => {
  it('user（停用账户）：这个人持有的租约一律结束（revoked）、文档的代次加一，不论他在那里还有什么角色；不问访问策略；别人的不动', async () => {
    const { store, revocation } = setup()
    const team = store.addDocument({ spaceId: TEAM_SPACE })
    const own = store.addDocument({ spaceId: ALICE_SPACE })
    const others = store.addDocument({ spaceId: TEAM_SPACE })
    holding(store, team, ALICE)
    holding(store, own, ALICE)
    holding(store, others, BOB)
    await revocation.revoke({ kind: 'user', userId: ALICE }, TRANSACTION)
    expect(stateOf(store, [team, own, others])).toEqual([['revoked', 1], ['revoked', 1], [null, 0]])
    // 访问策略不看账户的状态：停用的人按策略仍是编辑者，所以这一种不问它
    expect(store.spaces.accessFactsOf).not.toHaveBeenCalled()
  })

  it('membership（移出空间、降为查看者）：这个人在这个空间里的租约结束；他在别的空间里的、同一个空间里别人的不动', async () => {
    for (const role of ['viewer', undefined] as const) {
      const { store, revocation } = setup()
      const team = store.addDocument({ spaceId: TEAM_SPACE })
      const own = store.addDocument({ spaceId: ALICE_SPACE })
      const others = store.addDocument({ spaceId: TEAM_SPACE })
      holding(store, team, ALICE)
      holding(store, own, ALICE)
      holding(store, others, BOB)
      store.setMember(TEAM_SPACE, ALICE, role)
      await revocation.revoke({ kind: 'membership', userId: ALICE, spaceId: TEAM_SPACE }, TRANSACTION)
      expect(stateOf(store, [team, own, others]), role ?? '移出').toEqual([['revoked', 1], [null, 0], [null, 0]])
    }
  })

  it('membership：变化之后仍能编辑的不动——空间管理员降为编辑者；移出空间却有编辑授权（只凭授权也能编辑）', async () => {
    const demoted = setup()
    demoted.store.setMember(TEAM_SPACE, ALICE, 'admin')
    const document = demoted.store.addDocument({ spaceId: TEAM_SPACE })
    holding(demoted.store, document, ALICE)
    demoted.store.setMember(TEAM_SPACE, ALICE, 'editor')
    await demoted.revocation.revoke({ kind: 'membership', userId: ALICE, spaceId: TEAM_SPACE }, TRANSACTION)
    expect(stateOf(demoted.store, [document])).toEqual([[null, 0]])
    expect(demoted.store.leases.endAll).not.toHaveBeenCalled()
    expect(demoted.store.repositories.documents.advanceWriteEpochs).not.toHaveBeenCalled()

    const granted = setup()
    const shared = granted.store.addDocument({ spaceId: TEAM_SPACE })
    holding(granted.store, shared, ALICE)
    granted.store.setGrant(shared.id, ALICE, 'editor')
    granted.store.setMember(TEAM_SPACE, ALICE, undefined)
    await granted.revocation.revoke({ kind: 'membership', userId: ALICE, spaceId: TEAM_SPACE }, TRANSACTION)
    expect(stateOf(granted.store, [shared])).toEqual([[null, 0]])
  })

  it('space（归档）：这个空间里的租约都结束，不论持有者——只凭授权编辑的人同样（归档的空间里授权降为查看者）；别的空间里的不动', async () => {
    const { store, revocation } = setup()
    const alices = store.addDocument({ spaceId: TEAM_SPACE })
    const carols = store.addDocument({ spaceId: TEAM_SPACE })
    const elsewhere = store.addDocument({ spaceId: ALICE_SPACE })
    holding(store, alices, ALICE)
    store.setGrant(carols.id, CAROL, 'editor')
    holding(store, carols, CAROL)
    holding(store, elsewhere, ALICE)
    store.space(TEAM_SPACE).status = 'archived'
    await revocation.revoke({ kind: 'space', spaceId: TEAM_SPACE }, TRANSACTION)
    expect(stateOf(store, [alices, carols, elsewhere])).toEqual([['revoked', 1], ['revoked', 1], [null, 0]])
  })

  it('documents（删除）：进了回收站的文档上的租约结束，持有者的角色没变也一样（回收站里的文档谁也不能编辑）；代次在删除加的一之上再加一', async () => {
    const { store, revocation } = setup()
    const trashed = store.addDocument({ spaceId: TEAM_SPACE })
    holding(store, trashed, ALICE)
    // 调用方先放进回收站（代次加一），再收回
    store.documentEntries.set(trashed.id, 'trash-entry')
    store.documents.set(trashed.id, { ...trashed, writeEpoch: 1 })
    await revocation.revoke({ kind: 'documents', documentIds: [trashed.id] }, TRANSACTION)
    expect(stateOf(store, [trashed])).toEqual([['revoked', 2]])
  })

  it('documents（跨空间移动、转移）：移过去之后仍能编辑的持有者不动（调用方加过的代次让他的租约按 stale 失效）；不能编辑了的结束、代次再加一', async () => {
    const { store, revocation } = setup()
    const stays = store.addDocument({ spaceId: TEAM_SPACE })
    const loses = store.addDocument({ spaceId: TEAM_SPACE })
    holding(store, stays, ALICE)
    holding(store, loses, BOB)
    movedTo(store, stays, OTHER_TEAM)
    movedTo(store, loses, OTHER_TEAM)
    await revocation.revoke({ kind: 'documents', documentIds: [stays.id, loses.id] }, TRANSACTION)
    expect(stateOf(store, [stays, loses])).toEqual([[null, 1], ['revoked', 2]])
  })

  it('userDocuments（取消、降低单独授权）：只凭授权编辑的人的租约结束；同时是空间编辑者的不动；同一份文档上别人的租约不在范围里', async () => {
    const { store, revocation } = setup()
    const carols = store.addDocument({ spaceId: TEAM_SPACE })
    store.setGrant(carols.id, CAROL, 'editor')
    holding(store, carols, CAROL)
    store.setGrant(carols.id, CAROL, 'viewer')
    await revocation.revoke({ kind: 'userDocuments', userId: CAROL, documentIds: [carols.id] }, TRANSACTION)

    const bobs = store.addDocument({ spaceId: TEAM_SPACE })
    store.setGrant(bobs.id, BOB, 'editor')
    holding(store, bobs, BOB)
    store.setGrant(bobs.id, BOB, undefined)
    await revocation.revoke({ kind: 'userDocuments', userId: BOB, documentIds: [bobs.id] }, TRANSACTION)

    // 卡罗尔在这份文档上的授权取消了，可正在编辑它的是艾米：不能用 documents 范围，就是为了不把她一起结束
    const alices = store.addDocument({ spaceId: TEAM_SPACE })
    store.setGrant(alices.id, CAROL, 'editor')
    holding(store, alices, ALICE)
    store.setGrant(alices.id, CAROL, undefined)
    await revocation.revoke({ kind: 'userDocuments', userId: CAROL, documentIds: [alices.id] }, TRANSACTION)
    expect(stateOf(store, [carols, bobs, alices])).toEqual([['revoked', 1], [null, 0], [null, 0]])
  })
})

describe('LeaseWriteAccessRevocation：步骤与写了什么', () => {
  it('范围里没有租约、租约都已明确结束：什么也不写，也不问访问策略', async () => {
    const { store, revocation } = setup()
    const released = store.addDocument({ spaceId: TEAM_SPACE })
    holding(store, released, ALICE)
    await store.leases.end(released.id, 'released')
    store.space(TEAM_SPACE).status = 'archived'
    const scopes: WriteAccessScope[] = [
      { kind: 'user', userId: BOB },
      { kind: 'membership', userId: ALICE, spaceId: TEAM_SPACE },
      { kind: 'space', spaceId: TEAM_SPACE },
      { kind: 'documents', documentIds: [released.id] },
      { kind: 'userDocuments', userId: ALICE, documentIds: [released.id] },
    ]
    for (const scope of scopes)
      await revocation.revoke(scope, TRANSACTION)
    expect(store.leases.lockInScope).toHaveBeenCalledTimes(scopes.length)
    expect(store.spaces.accessFactsOf).not.toHaveBeenCalled()
    expect(store.leases.endAll).not.toHaveBeenCalled()
    expect(store.repositories.documents.advanceWriteEpochs).not.toHaveBeenCalled()
    expect(stateOf(store, [released])).toEqual([['released', 0]])
  })

  it('M3-P5（DEF-044）按时间已死的租约（到期、空闲满 12 分钟）不收回：不记 revoked、不加代次——它不能再续租，撤权之后才拿到文档行的保存在锁下按新的权限被拒，异常中断的提醒得以保留；还活着的照常结束（刚死不久的文档行由仓储另锁、等在途的保存，审查 A1，见集成测试）', async () => {
    const { store, revocation } = setup()
    const expired = store.addDocument({ spaceId: TEAM_SPACE })
    const idle = store.addDocument({ spaceId: TEAM_SPACE })
    const alive = store.addDocument({ spaceId: TEAM_SPACE })
    for (const document of [expired, idle, alive])
      holding(store, document, ALICE)
    const now = store.databaseNow.getTime()
    // 恰好到期、恰好空闲 12 分钟：与有效条件的边界相同，都算死
    changeLease(store, expired, { expiresAt: new Date(now) })
    changeLease(store, idle, { lastActiveAt: new Date(now - EDIT_LEASE_IDLE_RECLAIM_SECONDS * 1000) })
    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    await revocation.revoke({ kind: 'membership', userId: ALICE, spaceId: TEAM_SPACE }, TRANSACTION)
    expect(stateOf(store, [expired, idle, alive])).toEqual([[null, 0], [null, 0], ['revoked', 1]])
    expect(store.leases.endAll.mock.calls).toEqual([[[alive.id], 'revoked', TRANSACTION]])
  })

  it('先锁住范围里的租约，再逐个判断，最后一条语句结束这些租约、一条语句给这些文档加代次（一批文档也是各一条），都在调用方的事务里', async () => {
    const { store, revocation } = setup()
    const first = store.addDocument({ spaceId: TEAM_SPACE })
    const second = store.addDocument({ spaceId: TEAM_SPACE })
    const kept = store.addDocument({ spaceId: TEAM_SPACE })
    holding(store, first, BOB)
    holding(store, second, BOB)
    holding(store, kept, ALICE)
    // 一起移到另一个团队空间（例如它们所在的文件夹连同子树）：本在那里不是成员，艾米是编辑者
    for (const document of [first, second, kept])
      movedTo(store, document, OTHER_TEAM)
    await revocation.revoke({ kind: 'documents', documentIds: [first.id, second.id, kept.id] }, TRANSACTION)
    expect(stateOf(store, [first, second, kept])).toEqual([['revoked', 2], ['revoked', 2], [null, 1]])

    const { leases, spaces, repositories } = store
    expect(leases.lockInScope.mock.calls).toEqual([[{ kind: 'documents', documentIds: [first.id, second.id, kept.id] }, TRANSACTION]])
    expect(leases.endAll.mock.calls).toEqual([[[first.id, second.id], 'revoked', TRANSACTION]])
    expect(repositories.documents.advanceWriteEpochs.mock.calls).toEqual([[[first.id, second.id], TRANSACTION]])
    // 每个租约的持有者问一次（三次），都在锁住之后、写之前
    expect(spaces.accessFactsOf).toHaveBeenCalledTimes(3)
    const order = (fn: { mock: { invocationCallOrder: number[] } }): number => fn.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    expect(order(leases.lockInScope)).toBeLessThan(order(spaces.accessFactsOf))
    expect(Math.max(...spaces.accessFactsOf.mock.invocationCallOrder)).toBeLessThan(order(leases.endAll))
    expect(order(leases.endAll)).toBeLessThan(order(repositories.documents.advanceWriteEpochs))
  })
})
