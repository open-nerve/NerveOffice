import type { DraftCatalogView } from './draft-catalog.ts'
import type { DraftMaintenanceOptions } from './draft-maintenance.ts'
import { describe, expect, it, vi } from 'vitest'
import { deferred } from '../outbox/outbox-lock.test-support.ts'
import { createDraftMaintenance } from './draft-maintenance.ts'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FIRST = { userId: USER, generation: '00000000-0000-4000-8000-000000000011' }
const SECOND = { userId: USER, generation: '00000000-0000-4000-8000-000000000012' }
const CLEARING = { userId: USER, generation: '00000000-0000-4000-8000-000000000013', cause: 'logout' as const }
const VIEW: DraftCatalogView = { checked: true, completedCopies: [], uncertainCopies: [], rows: [{ documentId: USER, title: '旧账户的文档', updatedAt: 1, mirrorOnly: false, access: 'accessible', recovery: undefined }], busy: undefined, problem: undefined, incomplete: false, stale: false, held: undefined, copyPending: undefined }

function fixture() {
  const calls: string[] = []
  const readCleanup = vi.fn<DraftMaintenanceOptions['readCleanup']>(async () => ({ kind: 'ready', permit: undefined }))
  const removeUser = vi.fn<DraftMaintenanceOptions['cleanup']['removeUser']>(async () => {
    calls.push('cleanup')
    return { kind: 'cleared', pending: [] }
  })
  const purgeExpired = vi.fn<DraftMaintenanceOptions['cleanup']['purgeExpired']>(async () => {
    calls.push('expiry')
    return { kind: 'purged', drafts: [], pending: [], mirror: { kind: 'done' } }
  })
  const check = vi.fn<DraftMaintenanceOptions['check']>(async () => 'active')
  const catalogs: { refresh: ReturnType<typeof vi.fn<() => Promise<void>>>, dispose: ReturnType<typeof vi.fn>, view: () => DraftCatalogView, still: () => boolean }[] = []
  const makeCatalog = vi.fn<DraftMaintenanceOptions['makeCatalog']>((_permit, still) => {
    const catalog = { refresh: vi.fn(async () => {
      calls.push('catalog')
    }), dispose: vi.fn(), view: () => VIEW, still }
    catalogs.push(catalog)
    return catalog
  })
  const maintenance = createDraftMaintenance({ readCleanup, cleanup: { removeUser, purgeExpired }, check, makeCatalog, now: () => 1000 })
  return { maintenance, readCleanup, removeUser, purgeExpired, check, makeCatalog, catalogs, calls }
}

describe('启动维护串行、按原资格清理并隔离当前账户结果', () => {
  it('未登录只补持久清理及全局到期，不查询账户或文档', async () => {
    const t = fixture()
    t.readCleanup.mockResolvedValue({ kind: 'ready', permit: CLEARING })
    await t.maintenance.refresh()
    expect(t.calls).toEqual(['cleanup', 'expiry'])
    expect(t.removeUser).toHaveBeenCalledExactlyOnceWith(CLEARING)
    expect(t.makeCatalog).not.toHaveBeenCalled()
    expect(t.maintenance.view()).toEqual({ busy: false, cleanup: 'cleared', retention: 'done', catalog: undefined, problem: undefined })
    expect(JSON.stringify(t.maintenance.view())).not.toContain(USER)
  })

  it('只有已采纳的原许可扫描自己的目录，顺序在清理和保留期之后', async () => {
    const t = fixture()
    t.readCleanup.mockResolvedValue({ kind: 'ready', permit: CLEARING })
    t.maintenance.activate(FIRST)
    await t.maintenance.refresh()
    expect(t.calls).toEqual(['cleanup', 'expiry', 'catalog'])
    expect(t.makeCatalog).toHaveBeenCalledExactlyOnceWith(FIRST, expect.any(Function))
    expect(t.maintenance.view().catalog).toBe(VIEW)
    expect(t.check).toHaveBeenCalledWith(FIRST)
    expect(t.catalogs[0]!.dispose).toHaveBeenCalledOnce()
  })

  it('同一轮里的重复信号最多合并为下一轮，永远不并行扫描', async () => {
    const t = fixture()
    const waiting = deferred<Awaited<ReturnType<DraftMaintenanceOptions['readCleanup']>>>()
    t.readCleanup.mockImplementationOnce(async () => waiting.promise)
    const first = t.maintenance.refresh()
    await Promise.resolve()
    const second = t.maintenance.refresh()
    const third = t.maintenance.retry()
    expect(t.readCleanup).toHaveBeenCalledOnce()
    waiting.resolve({ kind: 'ready', permit: undefined })
    await Promise.all([first, second, third])
    expect(t.readCleanup).toHaveBeenCalledTimes(2)
    expect(t.purgeExpired).toHaveBeenCalledTimes(2)
    expect(t.maintenance.view().busy).toBe(false)
  })

  it('新激活立即清旧标题；旧扫描晚到不能发布，新一轮使用新原许可', async () => {
    const t = fixture()
    t.maintenance.activate(FIRST)
    await t.maintenance.refresh()
    const waiting = deferred<void>()
    t.makeCatalog.mockImplementationOnce((_permit, still) => {
      const catalog = { refresh: vi.fn(async () => waiting.promise), dispose: vi.fn(), view: () => VIEW, still }
      t.catalogs.push(catalog)
      return catalog
    })
    const running = t.maintenance.refresh()
    await vi.waitFor(() => expect(t.catalogs).toHaveLength(2))
    t.maintenance.activate(SECOND)
    expect(t.maintenance.view().catalog).toBeUndefined()
    expect(t.catalogs[1]!.still()).toBe(false)
    expect(t.catalogs[1]!.dispose).toHaveBeenCalledOnce()
    t.check.mockResolvedValue('session')
    waiting.resolve()
    await running
    expect(t.maintenance.view().catalog).toBeUndefined()
    expect(t.check).toHaveBeenLastCalledWith(SECOND)
  })

  it('相同许可的重复采纳不销毁当前结果、不另排扫描', async () => {
    const t = fixture()
    t.maintenance.activate(FIRST)
    await t.maintenance.refresh()
    t.maintenance.activate({ ...FIRST })
    await Promise.resolve()
    expect(t.makeCatalog).toHaveBeenCalledOnce()
    expect(t.maintenance.view().catalog).toBe(VIEW)
  })

  it('读到持久资格已失效时清旧标题；读库未知只报告未知', async () => {
    const t = fixture()
    t.maintenance.activate(FIRST)
    await t.maintenance.refresh()
    t.check.mockResolvedValue('storage')
    await t.maintenance.refresh()
    expect(t.maintenance.view().problem).toBe('storage')
    expect(t.maintenance.view().catalog).toBeUndefined()
    expect(t.makeCatalog).toHaveBeenCalledOnce()
    t.check.mockResolvedValue('session')
    await t.maintenance.refresh()
    expect(t.maintenance.view().catalog).toBeUndefined()
  })

  it('扫描结束再核对持久原许可，不靠未收到广播来显示标题', async () => {
    const t = fixture()
    t.maintenance.activate(FIRST)
    t.check.mockResolvedValueOnce('active').mockResolvedValueOnce('session')
    await t.maintenance.refresh()
    expect(t.makeCatalog).toHaveBeenCalledOnce()
    expect(t.maintenance.view().catalog).toBeUndefined()
  })

  it('pending 即使为空也仍未完成；清理和到期故障不宣称成功，允许重试', async () => {
    const t = fixture()
    t.readCleanup.mockResolvedValue({ kind: 'ready', permit: CLEARING })
    t.removeUser.mockResolvedValueOnce({ kind: 'pending', pending: [] })
    t.purgeExpired.mockResolvedValueOnce({ kind: 'purged', drafts: [], pending: [], mirror: { kind: 'failed', error: new Error('目录忙') } })
    await t.maintenance.refresh()
    expect(t.maintenance.view()).toMatchObject({ cleanup: 'pending', retention: 'pending' })
    await t.maintenance.retry()
    expect(t.maintenance.view()).toMatchObject({ cleanup: 'cleared', retention: 'done' })
    expect(t.removeUser).toHaveBeenNthCalledWith(2, CLEARING)
  })

  it('旧清理被新代次拒绝，不重建清理资格也不报清完', async () => {
    const t = fixture()
    t.readCleanup.mockResolvedValue({ kind: 'ready', permit: CLEARING })
    t.removeUser.mockResolvedValueOnce({ kind: 'invalidated' })
    await t.maintenance.refresh()
    expect(t.maintenance.view().cleanup).toBe('none')
    expect(t.removeUser).toHaveBeenCalledExactlyOnceWith(CLEARING)
  })

  it('存储抛错不会阻断阅读；某一段失败仍尝试下一段', async () => {
    const t = fixture()
    t.readCleanup.mockRejectedValueOnce(new Error('IDB blocked'))
    t.purgeExpired.mockRejectedValueOnce(new Error('OPFS unavailable'))
    await expect(t.maintenance.refresh()).resolves.toBeUndefined()
    expect(t.maintenance.view()).toMatchObject({ busy: false, cleanup: 'failed', retention: 'failed' })
    expect(t.purgeExpired).toHaveBeenCalledOnce()
  })

  it('dispose 立即取消元数据所有权，晚到扫描不能再通知或开始下一轮', async () => {
    const t = fixture()
    const waiting = deferred<void>()
    t.makeCatalog.mockReturnValueOnce({ view: () => VIEW, refresh: async () => waiting.promise, dispose: vi.fn() })
    t.maintenance.activate(FIRST)
    const listener = vi.fn()
    t.maintenance.subscribe(listener)
    const running = t.maintenance.refresh()
    await vi.waitFor(() => expect(t.makeCatalog).toHaveBeenCalledOnce())
    t.maintenance.dispose()
    const count = listener.mock.calls.length
    waiting.resolve()
    await running
    await t.maintenance.retry()
    expect(t.maintenance.view().catalog).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(count)
    expect(t.makeCatalog).toHaveBeenCalledOnce()
  })

  it('目录模块下载期间已失效时，迟到实例立即释放且不读取旧文档', async () => {
    const t = fixture()
    const catalog = { view: () => VIEW, refresh: vi.fn(async () => {}), dispose: vi.fn() }
    const loading = deferred<typeof catalog>()
    t.makeCatalog.mockImplementationOnce(async () => loading.promise)
    t.maintenance.activate(FIRST)
    const running = t.maintenance.refresh()
    await vi.waitFor(() => expect(t.makeCatalog).toHaveBeenCalledOnce())
    t.maintenance.activate(undefined)
    loading.resolve(catalog)
    await running
    expect(catalog.dispose).toHaveBeenCalledOnce()
    expect(catalog.refresh).not.toHaveBeenCalled()
    expect(t.maintenance.view().catalog).toBeUndefined()
  })
})
