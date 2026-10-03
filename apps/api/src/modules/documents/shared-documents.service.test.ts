// "与我共享"（M2-P5 设计 §3.4(4)）：范围是"可访问文档"的授权那一半（不论在那个空间里有没有角色），回收站里的不出现；
// 每条的内容权限经访问策略的批量入口（一页一次批量取空间事实），授权角色与行出自同一条语句；个人空间给所有者的 id（人名在 workspace）；
// 分页与文档列表一致。
import type { DocumentRow } from './documents.repository.ts'
import { SHARED_PAGE_SIZE } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeTimeCursor, encodeTimeCursor } from '../../shared/time-cursor.ts'
import { ALICE, ALICE_SPACE, BOB, BOB_SPACE, FakeStore, member, TEAM_SPACE, TRANSACTION } from './documents.test-support.ts'
import { SharedDocumentsService } from './shared-documents.service.ts'

function setup() {
  const store = new FakeStore()
  const { documents, policy } = store.deps
  return { store, service: new SharedDocumentsService(documents, policy) }
}

/** 一份文档：位置（游标用的更新时间）由用例给出，顺序据此确定 */
function at(store: FakeStore, spaceId: string, title: string, position: string): DocumentRow {
  const time = new Date(position)
  return store.addDocument({ spaceId, title, createdBy: spaceId === BOB_SPACE ? BOB : ALICE, createdAt: time, updatedAt: time, position })
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

describe('SharedDocumentsService.list 的范围与每一条', () => {
  it('我有授权的全部文档（包括我在那个空间里也有角色的），按更新时间从新到旧；没有授权的、授权给别人的都不出现', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    const inTeam = at(store, TEAM_SPACE, '部门的表', '2026-09-26T10:00:00.000003Z')
    const inAlices = at(store, ALICE_SPACE, '爱丽丝的表', '2026-09-26T10:00:00.000002Z')
    const notShared = at(store, ALICE_SPACE, '没分享的', '2026-09-26T10:00:00.000004Z')
    const toOthers = at(store, TEAM_SPACE, '分享给别人的', '2026-09-26T10:00:00.000005Z')
    store.setGrant(inTeam.id, BOB, 'editor')
    store.setGrant(inAlices.id, BOB, 'viewer')
    store.setGrant(toOthers.id, ALICE, 'editor', BOB)
    const page = await service.list(member(BOB), {}, TRANSACTION)
    expect(page.items.map(item => item.id)).toEqual([inTeam.id, inAlices.id])
    expect(page.items.map(item => item.id)).not.toContain(notShared.id)
    expect(store.repositories.documents.listGranted).toHaveBeenCalledWith(BOB, { limit: SHARED_PAGE_SIZE + 1, after: undefined }, TRANSACTION)
  })

  it('每条：摘要（不带文件夹）、所在空间（团队空间的名称；个人空间的所有者 id）、内容权限（空间角色与授权取较高者）', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    const inTeam = at(store, TEAM_SPACE, '部门的表', '2026-09-26T10:00:00.000002Z')
    const inAlices = at(store, ALICE_SPACE, '爱丽丝的表', '2026-09-26T10:00:00.000001Z')
    store.setGrant(inTeam.id, BOB, 'editor')
    store.setGrant(inAlices.id, BOB, 'viewer')
    expect((await service.list(member(BOB), {}, TRANSACTION)).items).toEqual([
      {
        id: inTeam.id,
        title: '部门的表',
        type: 'sheet',
        createdAt: inTeam.createdAt.toISOString(),
        updatedAt: inTeam.updatedAt.toISOString(),
        space: { id: TEAM_SPACE, type: 'team', name: '市场部' },
        contentRole: 'editor',
      },
      {
        id: inAlices.id,
        title: '爱丽丝的表',
        type: 'sheet',
        createdAt: inAlices.createdAt.toISOString(),
        updatedAt: inAlices.updatedAt.toISOString(),
        space: { id: ALICE_SPACE, type: 'personal', ownerUserId: ALICE },
        contentRole: 'viewer',
      },
    ])
  })

  it('内容权限经访问策略：空间管理员另有查看授权仍是空间管理员；归档的空间里编辑授权降为查看者；一页只批量取一次空间事实', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, BOB, 'admin')
    const asAdmin = at(store, TEAM_SPACE, '我管的', '2026-09-26T10:00:00.000002Z')
    const inArchived = at(store, ALICE_SPACE, '归档里的', '2026-09-26T10:00:00.000001Z')
    store.setGrant(asAdmin.id, BOB, 'viewer')
    store.setGrant(inArchived.id, BOB, 'editor')
    store.space(ALICE_SPACE).status = 'archived'
    expect((await service.list(member(BOB), {}, TRANSACTION)).items.map(item => [item.title, item.contentRole])).toEqual([['我管的', 'admin'], ['归档里的', 'viewer']])
    expect(store.spaces.accessFactsOfMany).toHaveBeenCalledTimes(1)
    expect(store.spaces.accessFactsOfMany).toHaveBeenCalledWith(BOB, [TEAM_SPACE, ALICE_SPACE], { transaction: TRANSACTION })
    // 单个的判断入口不用：每条不各查一次
    expect(store.spaces.accessFactsOf).not.toHaveBeenCalled()
    expect(store.grants.roleOf).not.toHaveBeenCalled()
  })

  it('授权角色来自列出它的那一条语句：之后另读时授权已被并发取消，这一页仍按读到的角色给出，不另读授权', async () => {
    const { store, service } = setup()
    const shared = at(store, TEAM_SPACE, '刚被取消的', '2026-09-26T10:00:00.000001Z')
    store.repositories.documents.listGranted.mockResolvedValueOnce([{ ...shared, grantRole: 'editor' }])
    expect((await service.list(member(BOB), {}, TRANSACTION)).items.map(item => [item.id, item.contentRole])).toEqual([[shared.id, 'editor']])
    expect(store.grants.roleOf).not.toHaveBeenCalled()
  })

  it('回收站里的不出现（状态由 accessible 定死）', async () => {
    const { store, service } = setup()
    const trashed = at(store, ALICE_SPACE, '删掉的', '2026-09-26T10:00:00.000002Z')
    const kept = at(store, ALICE_SPACE, '留着的', '2026-09-26T10:00:00.000001Z')
    store.setGrant(trashed.id, BOB, 'viewer')
    store.setGrant(kept.id, BOB, 'viewer')
    store.documentEntries.set(trashed.id, 'entry-1')
    expect((await service.list(member(BOB), {}, TRANSACTION)).items.map(item => item.id)).toEqual([kept.id])
  })

  it('仓储给出的一行算不出访问（条件坏了：没有授权、也不在我有角色的空间里）：按意外错误处理，不静默丢掉', async () => {
    const { store, service } = setup()
    const others = at(store, TEAM_SPACE, '不该出现的', '2026-09-26T10:00:00.000001Z')
    store.repositories.documents.listGranted.mockResolvedValueOnce([{ ...others, grantRole: null }])
    const failure: unknown = await service.list(member(BOB), {}, TRANSACTION).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(AppError)
    expect((failure as Error).message).toBe(`"与我共享"里的文档算不出访问：文档 ${others.id}，空间 ${TEAM_SPACE}`)
  })
})

describe('SharedDocumentsService.list 的分页', () => {
  /** 位置从新到旧的一批分享给鲍勃的文档：正好比一页多一条 */
  function overOnePage(store: FakeStore): DocumentRow[] {
    return Array.from({ length: SHARED_PAGE_SIZE + 1 }, (_, index) => {
      const row = at(store, ALICE_SPACE, `表 ${index}`, `2026-09-26T10:00:00.${String(SHARED_PAGE_SIZE + 1 - index).padStart(6, '0')}Z`)
      store.setGrant(row.id, BOB, 'viewer')
      return row
    })
  }

  it('每页固定条数，多取一条判断下一页；按游标接着取，不丢也不重，取完之后没有游标', async () => {
    const { store, service } = setup()
    const rows = overOnePage(store)
    const first = await service.list(member(BOB), {}, TRANSACTION)
    expect(first.items.map(item => item.id)).toEqual(rows.slice(0, SHARED_PAGE_SIZE).map(row => row.id))
    expect(decodeTimeCursor(first.nextCursor ?? '')).toEqual({ position: rows[SHARED_PAGE_SIZE - 1]?.position, id: rows[SHARED_PAGE_SIZE - 1]?.id })
    const second = await service.list(member(BOB), { cursor: first.nextCursor ?? '' }, TRANSACTION)
    expect(second.items.map(item => item.id)).toEqual([rows[SHARED_PAGE_SIZE]?.id])
    expect(second.nextCursor).toBeNull()
    // 本页的空间事实只按本页取（多取的那一条不算）
    expect(store.spaces.accessFactsOfMany.mock.calls[0]?.[1]).toHaveLength(SHARED_PAGE_SIZE)
  })

  it('恰好是一页的条数：这一页给全，没有下一页的游标（"加载更多"不出现，不会取到空的一页；M2-P5 审查 B 的 S1）', async () => {
    const { store, service } = setup()
    const rows = Array.from({ length: SHARED_PAGE_SIZE }, (_, index) => {
      const row = at(store, ALICE_SPACE, `表 ${index}`, `2026-09-26T10:00:00.${String(SHARED_PAGE_SIZE - index).padStart(6, '0')}Z`)
      store.setGrant(row.id, BOB, 'viewer')
      return row
    })
    const page = await service.list(member(BOB), {}, TRANSACTION)
    expect(page.items.map(item => item.id)).toEqual(rows.map(row => row.id))
    expect(page.nextCursor).toBeNull()
  })

  it('游标不合法（改过、时间不存在）：REQUEST_INVALID，而且不查询', async () => {
    const { store, service } = setup()
    for (const cursor of ['broken', encodeTimeCursor({ position: '2026-02-30T00:00:00.000000Z', id: ALICE_SPACE })])
      expect((await errorOf(service.list(member(BOB), { cursor }, TRANSACTION))).code, cursor).toBe('REQUEST_INVALID')
    expect(store.repositories.documents.listGranted).not.toHaveBeenCalled()
  })

  it('什么都没有：空的一页，不取空间事实', async () => {
    const { store, service } = setup()
    expect(await service.list(member(BOB), {}, TRANSACTION)).toEqual({ items: [], nextCursor: null })
    expect(store.spaces.accessFactsOfMany).not.toHaveBeenCalled()
  })
})
