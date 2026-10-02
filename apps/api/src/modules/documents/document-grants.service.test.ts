// 单独授权的规则与文档这一段（M2-P5 设计 §3.2、§3.4(3)）：能不能分享只经访问策略；锁文档行之后按"还在 → 仍在持住的空间 → 仍能分享"复核；
// 新建、调整、没有变化与取消各写什么；编辑者降为查看者与取消时收回"这个人在这份文档上"的写入权，升级与没有变化时不收回。
// 账户行、空间行、审计与拼响应在 workspace 的编排里（document-sharing.service.test.ts）；锁的确定交错在集成测试。
import type { Transaction } from '../database/index.ts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { SHARING_FROZEN_MESSAGE } from './document-access-policy.ts'
import { DocumentGrantsService } from './document-grants.service.ts'
import { ALICE, ALICE_SPACE, BOB, BOB_SPACE, FakeStore, GRANT_WRITTEN_AT, member, TEAM_SPACE } from './documents.test-support.ts'

const TRANSACTION = { transaction: true } as unknown as Transaction
const CAROL = '0199a2c4-0000-7000-8000-00000000000c'
const ZERO = '00000000-0000-0000-0000-000000000000'
const MISSING = '0199a2c4-0000-7000-8000-0000000000ff'
const EARLIER = new Date('2026-09-27T08:00:00.000Z')

function setup() {
  const store = new FakeStore()
  const { documents, grants, policy, writeAccess } = store.deps
  return { store, service: new DocumentGrantsService(documents, grants, policy, writeAccess) }
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

/** 艾丽丝是团队空间的空间管理员时，团队空间里的一份文档 */
function teamDocument(store: FakeStore) {
  store.setMember(TEAM_SPACE, ALICE, 'admin')
  return store.addDocument({ spaceId: TEAM_SPACE, title: '部门的表' })
}

describe('DocumentGrantsService.requireSharing（不加锁的判断）', () => {
  it('个人空间的所有者与团队空间的空间管理员能分享：给出文档与它所在的空间（调用方随后持住这个空间的行）', async () => {
    const { store, service } = setup()
    const own = store.addDocument()
    expect(await service.requireSharing(member(ALICE), own.id, TRANSACTION)).toEqual({ id: own.id, spaceId: ALICE_SPACE })
    const team = teamDocument(store)
    expect(await service.requireSharing(member(ALICE), team.id, TRANSACTION)).toEqual({ id: team.id, spaceId: TEAM_SPACE })
    // 在调用方的事务里判断
    expect(store.repositories.documents.findById).toHaveBeenLastCalledWith(team.id, TRANSACTION)
  })

  it('看得到却不能分享：编辑者与查看者 403（只有空间管理员能分享）；只凭授权的人 403（他自己的说明，即使他的授权是编辑者）', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    for (const role of ['editor', 'viewer'] as const) {
      store.setMember(TEAM_SPACE, BOB, role)
      expect(await errorOf(service.requireSharing(member(BOB), document.id, TRANSACTION)), role).toMatchObject({ code: 'PERMISSION_DENIED', message: '只有空间管理员能分享这份文档' })
    }
    store.setMember(TEAM_SPACE, BOB, undefined)
    store.setGrant(document.id, BOB, 'editor')
    expect(await errorOf(service.requireSharing(member(BOB), document.id, TRANSACTION))).toMatchObject({ code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能再分享给别人' })
  })

  it('归档的空间里冻结：空间管理员也是 403，给冻结的说明（与默认的"只能查看"不同）；恢复之后也不能分享的编辑者照旧是"只有空间管理员能分享"；只凭授权的人仍是他自己的说明', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    store.setGrant(document.id, BOB, 'editor')
    store.space(TEAM_SPACE).status = 'archived'
    expect(SHARING_FROZEN_MESSAGE).toBe('空间已归档，恢复之后才能调整分享')
    expect(await errorOf(service.requireSharing(member(ALICE), document.id, TRANSACTION))).toMatchObject({ code: 'PERMISSION_DENIED', message: SHARING_FROZEN_MESSAGE })
    store.setMember(TEAM_SPACE, CAROL, 'editor')
    expect(await errorOf(service.requireSharing(member(CAROL), document.id, TRANSACTION))).toMatchObject({ message: '只有空间管理员能分享这份文档' })
    expect(await errorOf(service.requireSharing(member(BOB), document.id, TRANSACTION))).toMatchObject({ message: '这份文档是单独分享给你的，不能再分享给别人' })
  })

  it('看不到、不存在、在回收站里：都是 NOT_FOUND；看不到与不存在执行同样的查询（不存在时用全零的空间与 id 照样判断一次）', async () => {
    const { store, service } = setup()
    const others = store.addDocument({ spaceId: BOB_SPACE, createdBy: BOB })
    const trashed = store.addDocument()
    store.documentEntries.set(trashed.id, 'entry-1')
    for (const id of [others.id, MISSING, trashed.id])
      expect((await errorOf(service.requireSharing(member(ALICE), id, TRANSACTION))).code, id).toBe('NOT_FOUND')
    expect(store.spaces.accessFactsOf.mock.calls.map(call => call[1])).toEqual([BOB_SPACE, ZERO, ZERO])
    expect(store.grants.roleOf.mock.calls.map(call => call[0])).toEqual([others.id, ZERO, ZERO])
  })
})

describe('DocumentGrantsService.set（调用方已持住账户行与空间行）', () => {
  it('新建：先锁文档行、锁下复核，再读现有的授权、插入（设置人是操作者）；不收回写入权', async () => {
    const { store, service } = setup()
    const document = store.addDocument()
    const target = await service.requireSharing(member(ALICE), document.id, TRANSACTION)
    const change = await service.set(member(ALICE), target, BOB, 'viewer', TRANSACTION)
    expect(change).toEqual({ kind: 'created', grant: { documentId: document.id, userId: BOB, role: 'viewer', grantedBy: ALICE, createdAt: GRANT_WRITTEN_AT, updatedAt: GRANT_WRITTEN_AT } })
    const { lockById, findById } = store.repositories.documents
    expect(lockById).toHaveBeenCalledWith(document.id, TRANSACTION)
    // 锁下的复核在加锁之后：判断权限的那两条查询各有一次落在 lockById 之后
    const locked = lockById.mock.invocationCallOrder[0] ?? 0
    expect(findById.mock.invocationCallOrder[0]).toBeLessThan(locked)
    expect(store.spaces.accessFactsOf.mock.invocationCallOrder.filter(order => order > locked)).toHaveLength(1)
    expect(store.grants.roleOf.mock.invocationCallOrder.filter(order => order > locked)).toHaveLength(1)
    expect(store.grants.find.mock.invocationCallOrder[0]).toBeGreaterThan(locked)
    expect(store.writeAccess.revoke).not.toHaveBeenCalled()
  })

  it('同样的角色：什么都不写（不改设置人与时间、不收回），给出现有的那一条', async () => {
    const { store, service } = setup()
    const document = store.addDocument()
    store.setGrant(document.id, BOB, 'editor', CAROL)
    const target = await service.requireSharing(member(ALICE), document.id, TRANSACTION)
    expect(await service.set(member(ALICE), target, BOB, 'editor', TRANSACTION)).toEqual({ kind: 'unchanged', grant: { documentId: document.id, userId: BOB, role: 'editor', grantedBy: CAROL, createdAt: EARLIER, updatedAt: EARLIER } })
    expect(store.grants.insert).not.toHaveBeenCalled()
    expect(store.grants.updateRole).not.toHaveBeenCalled()
    expect(store.writeAccess.revoke).not.toHaveBeenCalled()
  })

  it('查看者升为编辑者：调整角色、设置人与时间，给出原来的角色；不收回写入权', async () => {
    const { store, service } = setup()
    const document = store.addDocument()
    store.setGrant(document.id, BOB, 'viewer', CAROL)
    const target = await service.requireSharing(member(ALICE), document.id, TRANSACTION)
    expect(await service.set(member(ALICE), target, BOB, 'editor', TRANSACTION)).toEqual({
      kind: 'changed',
      previousRole: 'viewer',
      grant: { documentId: document.id, userId: BOB, role: 'editor', grantedBy: ALICE, createdAt: EARLIER, updatedAt: GRANT_WRITTEN_AT },
    })
    expect(store.writeAccess.revoke).not.toHaveBeenCalled()
  })

  it('编辑者降为查看者：在同一个事务里收回"这个人在这份文档上"的写入权（userDocuments，不是这些文档上的所有人）', async () => {
    const { store, service } = setup()
    const document = store.addDocument()
    store.setGrant(document.id, BOB, 'editor')
    const target = await service.requireSharing(member(ALICE), document.id, TRANSACTION)
    expect(await service.set(member(ALICE), target, BOB, 'viewer', TRANSACTION)).toMatchObject({ kind: 'changed', previousRole: 'editor', grant: { role: 'viewer' } })
    expect(store.writeAccess.revoke).toHaveBeenCalledTimes(1)
    expect(store.writeAccess.revoke).toHaveBeenCalledWith({ kind: 'userDocuments', userId: BOB, documentIds: [document.id] }, TRANSACTION)
    expect(store.writeAccess.revoke.mock.invocationCallOrder[0]).toBeGreaterThan(store.grants.updateRole.mock.invocationCallOrder[0] ?? 0)
  })

  it('锁下发现文档已不在持住的那个空间（跨空间移动插在判断与持住空间行之间）：404，什么也不写——即使操作者在新空间里也是空间管理员', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    const target = await service.requireSharing(member(ALICE), document.id, TRANSACTION)
    // 判断之后被移到了艾丽丝的个人空间：她在那里也能分享，按新空间判断权限会通过
    store.documents.set(document.id, { ...document, spaceId: ALICE_SPACE })
    expect((await errorOf(service.set(member(ALICE), target, BOB, 'viewer', TRANSACTION))).code).toBe('NOT_FOUND')
    expect(store.grantOf(document.id, BOB)).toBeUndefined()
    // 先核对空间、再判断权限：新空间的权限没被持住，不按它判断
    expect(store.spaces.accessFactsOf).toHaveBeenCalledTimes(1)
  })

  it('锁下复核：判断之后空间被归档 403（冻结的说明）、自己被降为编辑者 403、被移出 404、文档进了回收站 404，都什么也不写', async () => {
    const cases: [string, (store: FakeStore, documentId: string) => void, string][] = [
      ['归档', (store) => {
        store.space(TEAM_SPACE).status = 'archived'
      }, 'PERMISSION_DENIED'],
      ['降为编辑者', store => store.setMember(TEAM_SPACE, ALICE, 'editor'), 'PERMISSION_DENIED'],
      ['移出空间', store => store.setMember(TEAM_SPACE, ALICE, undefined), 'NOT_FOUND'],
      ['进回收站', (store, documentId) => store.documentEntries.set(documentId, 'entry-1'), 'NOT_FOUND'],
    ]
    for (const [name, change, code] of cases) {
      const { store, service } = setup()
      const document = teamDocument(store)
      store.setGrant(document.id, BOB, 'editor')
      const target = await service.requireSharing(member(ALICE), document.id, TRANSACTION)
      change(store, document.id)
      const error = await errorOf(service.set(member(ALICE), target, BOB, 'viewer', TRANSACTION))
      expect(error.code, name).toBe(code)
      if (name === '归档')
        expect(error.message).toBe(SHARING_FROZEN_MESSAGE)
      expect(store.grantOf(document.id, BOB)?.role, name).toBe('editor')
      expect(store.grants.find, name).not.toHaveBeenCalled()
      expect(store.writeAccess.revoke, name).not.toHaveBeenCalled()
    }
  })
})

describe('DocumentGrantsService.remove（调用方已持住空间行）', () => {
  it('有这一条：删掉，收回他在这份文档上的写入权，给出删掉的那一条（角色是删掉之前的）', async () => {
    const { store, service } = setup()
    const document = store.addDocument()
    store.setGrant(document.id, BOB, 'viewer', CAROL)
    const target = await service.requireSharing(member(ALICE), document.id, TRANSACTION)
    expect(await service.remove(member(ALICE), target, BOB, TRANSACTION)).toMatchObject({ documentId: document.id, userId: BOB, role: 'viewer' })
    expect(store.grantOf(document.id, BOB)).toBeUndefined()
    expect(store.writeAccess.revoke).toHaveBeenCalledWith({ kind: 'userDocuments', userId: BOB, documentIds: [document.id] }, TRANSACTION)
    expect(store.repositories.documents.lockById.mock.invocationCallOrder[0]).toBeLessThan(store.grants.delete.mock.invocationCallOrder[0] ?? 0)
  })

  it('没有这一条：什么也不写，不收回（按状态幂等）；同一份文档上别人的授权不动', async () => {
    const { store, service } = setup()
    const document = store.addDocument()
    store.setGrant(document.id, CAROL, 'editor')
    const target = await service.requireSharing(member(ALICE), document.id, TRANSACTION)
    expect(await service.remove(member(ALICE), target, BOB, TRANSACTION)).toBeUndefined()
    expect(store.writeAccess.revoke).not.toHaveBeenCalled()
    expect(store.grantOf(document.id, CAROL)?.role).toBe('editor')
  })

  it('锁下发现文档已不在持住的那个空间：404，什么也不删', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    store.setGrant(document.id, BOB, 'editor')
    const target = await service.requireSharing(member(ALICE), document.id, TRANSACTION)
    store.documents.set(document.id, { ...document, spaceId: ALICE_SPACE })
    expect((await errorOf(service.remove(member(ALICE), target, BOB, TRANSACTION))).code).toBe('NOT_FOUND')
    expect(store.grantOf(document.id, BOB)?.role).toBe('editor')
    expect(store.grants.delete).not.toHaveBeenCalled()
  })
})

describe('DocumentGrantsService.list', () => {
  it('能分享的人看得到这份文档的全部授权；不能分享 403、归档 403（冻结的说明）、看不到 404，都不读授权列表', async () => {
    const { store, service } = setup()
    const document = teamDocument(store)
    store.setGrant(document.id, BOB, 'viewer')
    store.setGrant(document.id, CAROL, 'editor')
    expect((await service.list(member(ALICE), document.id)).map(grant => [grant.userId, grant.role]).toSorted()).toEqual([[BOB, 'viewer'], [CAROL, 'editor']].toSorted())
    expect(store.grants.listFor).toHaveBeenCalledTimes(1)

    expect(await errorOf(service.list(member(CAROL), document.id))).toMatchObject({ code: 'PERMISSION_DENIED', message: '这份文档是单独分享给你的，不能再分享给别人' })
    expect((await errorOf(service.list(member(BOB), MISSING))).code).toBe('NOT_FOUND')
    store.space(TEAM_SPACE).status = 'archived'
    expect(await errorOf(service.list(member(ALICE), document.id))).toMatchObject({ code: 'PERMISSION_DENIED', message: SHARING_FROZEN_MESSAGE })
    expect(store.grants.listFor).toHaveBeenCalledTimes(1)
  })
})
