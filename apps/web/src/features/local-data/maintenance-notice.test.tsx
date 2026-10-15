import type { DraftCatalogView } from '../../shared/local-drafts/draft-catalog.ts'
import type { DraftMaintenanceOptions } from '../../shared/local-drafts/draft-maintenance.ts'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { localDataMessages } from '../../shared/i18n/zh-cn/local-data.ts'
import { createDraftMaintenance } from '../../shared/local-drafts/draft-maintenance.ts'
import { deferred } from '../../shared/outbox/outbox-lock.test-support.ts'
import { LocalDataStatus } from './local-data-notice.tsx'
import { maintenanceMessage } from './notice-runtime.ts'

const PERMIT = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation: '00000000-0000-4000-8000-000000000011' }
const EMPTY: DraftCatalogView = { checked: true, rows: [], completedCopies: [], uncertainCopies: [], busy: undefined, problem: undefined, incomplete: false, stale: false, held: undefined, copyPending: undefined }

function completed(reason: 'unreadable' | 'revoked' | 'corrupted'): DraftCatalogView {
  return { ...EMPTY, rows: [{ documentId: 'removed-document', title: '已清理的旧标题', updatedAt: 1, mirrorOnly: false, access: 'accessible', recovery: {
    stage: 'finished',
    decision: { kind: 'remove', reason },
    updatedAt: 1,
    operation: undefined,
    cleanup: { kind: 'removed', mirror: { kind: 'removed' } },
    copy: { kind: 'idle' },
    notice: undefined,
    problem: undefined,
  } }] }
}

function fixture(first: DraftCatalogView, wait: Promise<void> = Promise.resolve()) {
  const check = vi.fn<DraftMaintenanceOptions['check']>(async () => 'active')
  const makeCatalog = vi.fn<DraftMaintenanceOptions['makeCatalog']>()
    .mockImplementationOnce(() => ({ refresh: async () => wait, view: () => first, dispose: () => {} }))
    .mockImplementation(() => ({ refresh: async () => {}, view: () => EMPTY, dispose: () => {} }))
  const model = createDraftMaintenance({
    readCleanup: async () => ({ kind: 'ready', permit: undefined }),
    cleanup: { removeUser: async () => ({ kind: 'cleared', pending: [] }), purgeExpired: async () => ({ kind: 'purged', drafts: [], pending: [], mirror: { kind: 'done' } }) },
    check,
    makeCatalog,
    now: () => 1000,
  })
  const show = () => render(<LocalDataStatus runtime={{ model, text: localDataMessages, describe: maintenanceMessage, dispose: () => model.dispose() }} />)
  return { model, check, makeCatalog, show }
}

describe('完成说明独立于下一轮维护的当前目录', () => {
  it.each([
    ['unreadable', '已无法访问这份文档，对应的本机草稿已清除'],
    ['revoked', '密钥失效的本机草稿已清除'],
    ['corrupted', '损坏的本机草稿已清除'],
  ] as const)('连续扫描清理 %s 后目录已空，迟到挂载的状态栏仍能解释清理原因', async (reason, message) => {
    const waiting = deferred<void>()
    const t = fixture(completed(reason), waiting.promise)
    t.model.activate(PERMIT)
    const running = t.model.refresh()
    await vi.waitFor(() => expect(t.makeCatalog).toHaveBeenCalledOnce())
    void t.model.refresh()
    waiting.resolve()
    await running
    expect(t.model.view().catalog?.rows).toEqual([])
    t.show()
    expect(screen.getByRole('status')).toHaveTextContent(message)
    expect(JSON.stringify(t.model.view())).not.toContain('已清理的旧标题')
    expect(JSON.stringify(t.model.view())).not.toContain('removed-document')
    t.model.dispose()
  })

  it.each(['session', 'storage'] as const)('持久资格检查为 %s 时立即清除已显示的完成说明', async (problem) => {
    const t = fixture(completed('corrupted'))
    t.model.activate(PERMIT)
    await t.model.refresh()
    t.show()
    expect(screen.getByRole('status')).toHaveTextContent('损坏的本机草稿已清除')
    t.check.mockResolvedValue(problem)
    await act(async () => t.model.refresh())
    expect(screen.getByRole('status')).not.toHaveTextContent('损坏的本机草稿已清除')
    expect(t.model.view().catalog).toBeUndefined()
    t.model.dispose()
  })

  it('相同许可的再扫描不丢完成说明，同人新代次立即清除', async () => {
    const t = fixture(completed('corrupted'))
    t.model.activate(PERMIT)
    await t.model.refresh()
    t.show()
    await act(async () => t.model.refresh())
    expect(screen.getByRole('status')).toHaveTextContent('损坏的本机草稿已清除')
    act(() => t.model.activate({ ...PERMIT, generation: '00000000-0000-4000-8000-000000000012' }))
    expect(screen.getByRole('status')).not.toHaveTextContent('损坏的本机草稿已清除')
    await act(async () => t.model.refresh())
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    t.model.dispose()
  })

  it('旧账户迟到完成的清理不能向新代次发布说明', async () => {
    const waiting = deferred<void>()
    const t = fixture(completed('corrupted'), waiting.promise)
    t.model.activate(PERMIT)
    const running = t.model.refresh()
    await vi.waitFor(() => expect(t.makeCatalog).toHaveBeenCalledOnce())
    t.model.activate({ ...PERMIT, generation: '00000000-0000-4000-8000-000000000012' })
    waiting.resolve()
    await running
    t.show()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    t.model.dispose()
  })

  it('只决定清理但尚未完成时不宣称成功，同原因反复完成也只播报一次', async () => {
    const removed = completed('corrupted')
    const row = removed.rows[0]!
    const t = fixture({ ...removed, rows: [{ ...row, recovery: { ...row.recovery!, stage: 'ready', cleanup: undefined } }] })
    t.model.activate(PERMIT)
    await t.model.refresh()
    t.show()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    t.makeCatalog.mockImplementation(() => ({ refresh: async () => {}, view: () => removed, dispose: () => {} }))
    await act(async () => {
      await t.model.refresh()
      await t.model.refresh()
    })
    expect(screen.getByRole('status').textContent).toBe('损坏的本机草稿已清除')
    t.model.dispose()
  })
})
