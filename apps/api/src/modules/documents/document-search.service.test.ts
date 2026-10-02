import type { DocumentRow } from './documents.repository.ts'
import { SEARCH_PAGE_SIZE } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeTimeCursor, encodeTimeCursor } from '../../shared/time-cursor.ts'
import { DocumentSearchService } from './document-search.service.ts'
import { ALICE, ALICE_SPACE, BOB_SPACE, FakeStore, member, TEAM_SPACE } from './documents.test-support.ts'

function setup() {
  const store = new FakeStore()
  const { documents, folders, policy } = store.deps
  return { store, service: new DocumentSearchService(documents, folders, policy) }
}

/** 一份文档：位置（游标用的更新时间）由用例给出，顺序据此确定 */
function at(store: FakeStore, spaceId: string, title: string, position: string, folderId: string | null = null): DocumentRow {
  const time = new Date(position)
  return store.addDocument({ spaceId, title, folderId, createdAt: time, updatedAt: time, position })
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError')
  return error
}

describe('DocumentSearchService.search 的范围', () => {
  it('只在我能看到的空间里查正常状态的文档：范围只由 accessible 的 spaceIds 给出，状态由它自己定死', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'viewer')
    at(store, ALICE_SPACE, '季度预算', '2026-09-26T10:00:00.000001Z')
    await service.search(member(ALICE), { query: '预算' })
    // 现在只要空间那一半（M2-P5 设计 §3.4(2)：并上授权要同时改不变量与凭授权命中的行，一起接上）
    expect(store.repositories.documents.searchByTitle).toHaveBeenCalledWith(
      { spaceIds: [ALICE_SPACE, TEAM_SPACE], grantsOf: undefined },
      { limit: 51, after: undefined, titlePattern: '%预算%' },
    )
  })

  it('现在只要空间那一半：分享给我的、在我看不到的空间里的文档不出现，也不让不变量误报', async () => {
    const { store, service } = setup()
    const shared = at(store, TEAM_SPACE, '分享来的预算', '2026-09-26T10:00:00.000002Z')
    at(store, ALICE_SPACE, '我的预算', '2026-09-26T10:00:00.000001Z')
    store.setGrant(shared.id, ALICE, 'editor')
    // 前提：要了授权那一半就会搜到它（授权确实在），不然下面的断言什么也证明不了
    const both = await store.repositories.documents.searchByTitle({ spaceIds: [ALICE_SPACE], grantsOf: ALICE }, { limit: 10, titlePattern: '%预算%' })
    expect(both.map(row => row.title).toSorted()).toEqual(['分享来的预算', '我的预算'].toSorted())
    expect((await service.search(member(ALICE), { query: '预算' })).items.map(item => item.title)).toEqual(['我的预算'])
  })

  it('看不到的空间：不进范围，里面的文档与空间名都不出现', async () => {
    const { store, service } = setup()
    at(store, BOB_SPACE, '鲍勃的预算', '2026-09-26T10:00:00.000001Z')
    at(store, TEAM_SPACE, '部门预算', '2026-09-26T10:00:00.000002Z')
    const page = await service.search(member(ALICE), { query: '预算' })
    expect(page.items).toEqual([])
    expect(store.repositories.documents.searchByTitle).toHaveBeenCalledWith(
      { spaceIds: [ALICE_SPACE], grantsOf: undefined },
      expect.anything(),
    )
  })

  it('仓储返回了范围之外的行：不变量失败，整个请求按意外错误处理，不静默丢掉、不给游标（M2-P6 复核 A 的 S3、B 的 G-3）', async () => {
    const { store, service } = setup()
    const mine = at(store, ALICE_SPACE, '我的预算', '2026-09-26T10:00:00.000001Z')
    const others = at(store, BOB_SPACE, '鲍勃的预算', '2026-09-26T10:00:00.000002Z')
    // "可访问文档"的条件坏了（例如不再按空间过滤）：仓储把别处的行也返回了
    store.repositories.documents.searchByTitle.mockResolvedValueOnce([others, mine])
    const failure: unknown = await service.search(member(ALICE), { query: '预算' }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(AppError)
    // 说明里只有 id，没有标题与空间名：它会进请求日志
    expect((failure as Error).message).toBe(`搜索结果里有可见范围之外的文档：文档 ${others.id}，空间 ${BOB_SPACE}`)
  })

  it('范围之外的行落在"多取的那一条"上也一样失败：不能只核对本页、按丢掉之前的行数给出下一页的游标', async () => {
    const { store, service } = setup()
    const rows = Array.from({ length: SEARCH_PAGE_SIZE }, (_, index) => at(store, ALICE_SPACE, `预算 ${index}`, `2026-09-26T10:00:00.${String(900_000 - index).padStart(6, '0')}Z`))
    const others = at(store, BOB_SPACE, '鲍勃的预算', '2026-09-26T09:00:00.000001Z')
    store.repositories.documents.searchByTitle.mockResolvedValueOnce([...rows, others])
    // 本页的 50 条都在范围里，只有多取的那一条（用来判断还有没有下一页）不在：同样是不变量失败——
    // 只核对本页的话会照常给出下一页的游标，透露范围之外还有匹配
    await expect(service.search(member(ALICE), { query: '预算' })).rejects.toThrow(`搜索结果里有可见范围之外的文档：文档 ${others.id}，空间 ${BOB_SPACE}`)
  })

  it('归档的空间还能搜到（归档只是只读）', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    store.space(TEAM_SPACE).status = 'archived'
    at(store, TEAM_SPACE, '归档里的预算', '2026-09-26T10:00:00.000001Z')
    expect((await service.search(member(ALICE), { query: '预算' })).items.map(item => item.title)).toEqual(['归档里的预算'])
  })

  it('回收站里的不出现：状态一维固定是 active', async () => {
    const { store, service } = setup()
    const trashed = at(store, ALICE_SPACE, '删掉的预算', '2026-09-26T10:00:00.000002Z')
    at(store, ALICE_SPACE, '留着的预算', '2026-09-26T10:00:00.000001Z')
    store.documentEntries.set(trashed.id, 'entry-1')
    expect((await service.search(member(ALICE), { query: '预算' })).items.map(item => item.title)).toEqual(['留着的预算'])
  })
})

describe('DocumentSearchService.search 的结果', () => {
  it('一条结果带空间的 id、类型与名称，以及从空间根目录到它所在文件夹的名称', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const outer = store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    const inner = store.addFolder({ spaceId: TEAM_SPACE, parentId: outer.id, name: '2026' })
    const row = at(store, TEAM_SPACE, '季度预算', '2026-09-26T10:00:00.000001Z', inner.id)
    expect((await service.search(member(ALICE), { query: '预算' })).items).toEqual([{
      id: row.id,
      title: '季度预算',
      type: 'sheet',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      space: { id: TEAM_SPACE, type: 'team', name: '市场部' },
      folderId: inner.id,
      folderPath: ['资料', '2026'],
      accessVia: 'space',
    }])
  })

  it('空间根目录下的文档：folderId 为空、路径是空数组，而且不去查路径', async () => {
    const { store, service } = setup()
    at(store, ALICE_SPACE, '根目录的预算', '2026-09-26T10:00:00.000001Z')
    const page = await service.search(member(ALICE), { query: '预算' })
    expect(page.items[0]).toMatchObject({ folderId: null, folderPath: [] })
    expect(store.repositories.folders.ancestorsOf).toHaveBeenCalledWith([], [ALICE_SPACE])
  })

  it('一页结果只查一次路径：按本页用到的文件夹 id 批量取，不按条数、也不按层数反复查', async () => {
    const { store, service } = setup()
    const outer = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    const inner = store.addFolder({ spaceId: ALICE_SPACE, parentId: outer.id, name: '2026' })
    at(store, ALICE_SPACE, '甲预算', '2026-09-26T10:00:00.000001Z', inner.id)
    at(store, ALICE_SPACE, '乙预算', '2026-09-26T10:00:00.000002Z', inner.id)
    at(store, ALICE_SPACE, '丙预算', '2026-09-26T10:00:00.000003Z', outer.id)
    const page = await service.search(member(ALICE), { query: '预算' })
    expect(page.items.map(item => item.folderPath)).toEqual([['资料'], ['资料', '2026'], ['资料', '2026']])
    expect(store.repositories.folders.ancestorsOf).toHaveBeenCalledTimes(1)
    expect(store.repositories.folders.ancestorsOf).toHaveBeenCalledWith([outer.id, inner.id], [ALICE_SPACE])
  })
})

describe('DocumentSearchService.search 的分页', () => {
  /** 位置从新到旧的一批文档：正好比一页多一条 */
  function overOnePage(store: FakeStore): DocumentRow[] {
    return Array.from({ length: SEARCH_PAGE_SIZE + 1 }, (_, index) =>
      at(store, ALICE_SPACE, `预算 ${index}`, `2026-09-26T10:00:00.${String(SEARCH_PAGE_SIZE + 1 - index).padStart(6, '0')}Z`))
  }

  it('每页固定条数，多取一条判断下一页；游标是本页最后一条的位置', async () => {
    const { store, service } = setup()
    const rows = overOnePage(store)
    const first = await service.search(member(ALICE), { query: '预算' })
    expect(store.repositories.documents.searchByTitle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ limit: SEARCH_PAGE_SIZE + 1 }))
    expect(first.items.map(item => item.id)).toEqual(rows.slice(0, SEARCH_PAGE_SIZE).map(row => row.id))
    expect(decodeTimeCursor(first.nextCursor ?? '')).toEqual({ position: rows[SEARCH_PAGE_SIZE - 1]?.position, id: rows[SEARCH_PAGE_SIZE - 1]?.id })
  })

  it('按游标接着取下一页：不丢也不重，取完之后没有游标', async () => {
    const { store, service } = setup()
    const rows = overOnePage(store)
    const first = await service.search(member(ALICE), { query: '预算' })
    const second = await service.search(member(ALICE), { query: '预算', cursor: first.nextCursor ?? '' })
    expect(store.repositories.documents.searchByTitle).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ after: { position: rows[SEARCH_PAGE_SIZE - 1]?.position, id: rows[SEARCH_PAGE_SIZE - 1]?.id } }),
    )
    expect(second.items.map(item => item.id)).toEqual([rows[SEARCH_PAGE_SIZE]?.id])
    expect(second.nextCursor).toBeNull()
    expect([...first.items, ...second.items].map(item => item.id)).toEqual(rows.map(row => row.id))
  })

  it('游标不合法（改过、时间不存在）：REQUEST_INVALID，而且不查询', async () => {
    const { store, service } = setup()
    for (const cursor of ['broken', encodeTimeCursor({ position: '2026-02-30T00:00:00.000000Z', id: ALICE_SPACE })]) {
      expect((await errorOf(service.search(member(ALICE), { query: '预算', cursor }))).code, cursor).toBe('REQUEST_INVALID')
    }
    expect(store.repositories.documents.searchByTitle).not.toHaveBeenCalled()
  })
})
