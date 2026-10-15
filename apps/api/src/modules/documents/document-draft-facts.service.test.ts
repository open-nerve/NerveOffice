import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { DocumentDraftFactsService } from './document-draft-facts.service.ts'
import { ALICE, BOB, BOB_SPACE, FakeStore, TEAM_SPACE, TRANSACTION } from './documents.test-support.ts'

const ABSENT = '0199a2c4-0000-7000-8000-0000000000ff'

function setup() {
  const store = new FakeStore()
  const { documents, revisions, leases, policy, sessions, transactions } = store.deps
  return { store, service: new DocumentDraftFactsService(documents, policy, revisions, leases, sessions, transactions) }
}

describe('DocumentDraftFactsService：只在一个快照里返回允许的事实', () => {
  it('保持请求顺序；没有权限和不存在同形，不泄露标题或位置', async () => {
    const { store, service } = setup()
    const first = store.addDocument({ title: '第一份' })
    const second = store.addDocument({ title: '第二份' })
    const hidden = store.addDocument({ spaceId: BOB_SPACE, title: '秘密' })
    expect(await service.get(ALICE, [second.id, hidden.id, ABSENT, first.id])).toEqual({ items: [
      { status: 'accessible', id: second.id, title: '第二份', type: 'sheet', canEdit: true, revision: 1, revisionSource: null, occupied: false },
      { status: 'unavailable', id: hidden.id },
      { status: 'unavailable', id: ABSENT },
      { status: 'accessible', id: first.id, title: '第一份', type: 'sheet', canEdit: true, revision: 1, revisionSource: null, occupied: false },
    ] })
    expect(store.transactions.readSnapshot).toHaveBeenCalledTimes(1)
    expect(store.repositories.documents.findManyWithGrants).toHaveBeenCalledExactlyOnceWith(ALICE, [second.id, hidden.id, ABSENT, first.id], TRANSACTION)
    expect(store.repositories.revisions.findCurrentOf).toHaveBeenCalledExactlyOnceWith([second.id, first.id], TRANSACTION)
    expect(store.leases.findByDocuments).toHaveBeenCalledExactlyOnceWith([second.id, first.id], TRANSACTION)
  })

  it('全部缺失仍经批量权限核对；不读取任何修订或租约', async () => {
    const { store, service } = setup()
    expect(await service.get(ALICE, [ABSENT])).toEqual({ items: [{ id: ABSENT, status: 'unavailable' }] })
    expect(store.spaces.accessFactsOfMany).toHaveBeenCalledTimes(1)
    expect(store.repositories.revisions.findCurrentOf).not.toHaveBeenCalled()
    expect(store.leases.findByDocuments).not.toHaveBeenCalled()
  })

  it('来源只给实际保存者本人，读取当前修订而非旧历史', async () => {
    const { store, service } = setup()
    const doc = store.addDocument({ revision: 3 })
    store.setGrant(doc.id, BOB, 'viewer')
    for (const revision of [2, 3]) {
      store.addRevision({ documentId: doc.id, revision, kind: 'saved', requestId: `${revision}`, payloadDigest: Buffer.alloc(32), savedBy: ALICE, source: { clientInstanceId: ALICE, localSeq: revision + 10 } })
    }
    expect((await service.get(ALICE, [doc.id])).items[0]).toMatchObject({ revision: 3, revisionSource: { clientInstanceId: ALICE, localSeq: 13 } })
    expect((await service.get(BOB, [doc.id])).items[0]).toMatchObject({ canEdit: false, revision: 3, revisionSource: null })
  })

  it('归档团队空间的管理员仍可读，但编辑位按同一访问策略降级', async () => {
    const { store, service } = setup()
    const doc = store.addDocument({ spaceId: TEAM_SPACE })
    store.setMember(TEAM_SPACE, ALICE, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    expect((await service.get(ALICE, [doc.id])).items[0]).toMatchObject({ status: 'accessible', canEdit: false })
  })

  it('存储读取失败向外传播，不伪装为 unavailable 或空目录', async () => {
    const { store, service } = setup()
    const failure = new Error('database unavailable')
    store.repositories.documents.findManyWithGrants.mockRejectedValue(failure)
    await expect(service.get(ALICE, [ABSENT])).rejects.toBe(failure)
  })
})
