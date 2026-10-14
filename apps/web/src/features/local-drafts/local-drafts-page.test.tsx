import type { DocumentDetail } from '@nerve-office/contracts'
import type { DraftCatalog, DraftCatalogView } from '../../shared/local-drafts/draft-catalog.ts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, Link, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { deferred } from '../../shared/outbox/outbox-lock.test-support.ts'
import { DraftCatalogContent } from './local-drafts-page.tsx'

const ID = '0199b0c4-7d3e-7a3b-9c4e-00000000d0c1'
const AT = Date.UTC(2026, 9, 14, 2)

function setup(patch: Partial<DraftCatalogView> = {}) {
  let state: DraftCatalogView = {
    checked: true,
    rows: [{ documentId: ID, title: '预算表', updatedAt: AT, mirrorOnly: false, access: 'accessible', recovery: { stage: 'ready', decision: { kind: 'restore', baseRevision: 1, formulasPending: false, reason: 'fast-forward' }, updatedAt: AT, operation: undefined, copy: { kind: 'idle' }, cleanup: undefined, notice: undefined, problem: undefined } }],
    completedCopies: [],
    uncertainCopies: [],
    busy: undefined,
    problem: undefined,
    incomplete: false,
    stale: false,
    held: undefined,
    copyPending: undefined,
    ...patch,
  }
  const listeners = new Set<() => void>()
  const update = (next: Partial<DraftCatalogView>) => {
    state = { ...state, ...next }
    listeners.forEach(listener => listener())
  }
  const intent = Object.freeze({ documentId: ID, title: '预算表', updatedAt: AT })
  const catalog: DraftCatalog = {
    view: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh: vi.fn(async () => {}),
    copy: vi.fn(async () => {}),
    prepareDiscard: vi.fn(async () => intent),
    discard: vi.fn(async () => {}),
    cancelDiscard: vi.fn(),
    retryCleanup: vi.fn(async () => {}),
    dispose: vi.fn(),
  }
  const recheck = vi.fn(async () => {})
  const router = createMemoryRouter([
    {
      path: '/local-drafts',
      element: (
        <>
          <Link to="/next">离开草稿页</Link>
          <DraftCatalogContent catalog={catalog} onSessionRecheck={recheck} />
        </>
      ),
    },
    { path: '/next', element: <h1>下一页</h1> },
  ], { initialEntries: ['/local-drafts'] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { catalog, intent, update, recheck, router }
}

describe('本机草稿页面的动作和焦点', () => {
  it('初次检查即资格失效时给重试，不继续宣称正在检查', () => {
    setup({ checked: false, rows: [], problem: 'session' })
    expect(screen.getByRole('alert')).toHaveTextContent('登录资格已经变化')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.queryByText('正在检查本机草稿…')).not.toBeInTheDocument()
  })

  it('标题和当前设备范围；打开文档仅为普通 URL，不携带恢复授权', () => {
    setup()
    expect(screen.getByRole('heading', { name: '本机草稿', level: 1 })).toBeInTheDocument()
    expect(screen.getByText(/此设备、此浏览器/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '打开文档恢复' })).toHaveAttribute('href', `/documents/${ID}`)
    expect(document.title).toContain('本机草稿')
  })

  it('只有完整检查后的空目录才显示空状态；不完整空列表必须给重试', async () => {
    const h = setup({ rows: [], incomplete: true })
    expect(screen.queryByText('这台设备上没有待处理的本机草稿。')).not.toBeInTheDocument()
    expect(screen.getByText(/列表可能不完整/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(h.catalog.refresh).toHaveBeenCalledOnce()
    await act(async () => h.update({ incomplete: false }))
    expect(screen.getByText('这台设备上没有待处理的本机草稿。')).toBeInTheDocument()
  })

  it('确认等待期间目录内容改变，仍提交弹窗原意图；取消不执行删除', async () => {
    const h = setup()
    const trigger = screen.getByRole('button', { name: '放弃本机修改' })
    trigger.focus()
    fireEvent.click(trigger)
    let dialog = await screen.findByRole('dialog', { name: '放弃这份本机修改？' })
    expect(dialog).toHaveTextContent('预算表')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(h.catalog.cancelDiscard).toHaveBeenCalledWith(h.intent)
    expect(h.catalog.discard).not.toHaveBeenCalled()
    await waitFor(() => expect(trigger).toHaveFocus())
    fireEvent.click(trigger)
    dialog = await screen.findByRole('dialog')
    await act(async () => h.update({ rows: h.catalog.view().rows.map(row => ({ ...row, title: '新标题', updatedAt: AT + 1000 })) }))
    expect(dialog).toHaveTextContent('预算表')
    expect(dialog).not.toHaveTextContent('新标题')
    fireEvent.click(within(dialog).getByRole('button', { name: '确认放弃' }))
    await waitFor(() => expect(h.catalog.discard).toHaveBeenCalledExactlyOnceWith(h.intent))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('副本进行中按钮保留且不重入；成功后的链接独立于清理结果', async () => {
    const h = setup()
    const wait = deferred<void>()
    vi.mocked(h.catalog.copy).mockImplementation(async () => {
      h.update({ busy: { kind: 'copy', documentId: ID } })
      await wait.promise
    })
    const button = screen.getByRole('button', { name: '另存为副本' })
    button.focus()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(h.catalog.copy).toHaveBeenCalledOnce()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveFocus()
    await act(async () => wait.resolve())
    await act(async () => h.update({
      busy: undefined,
      completedCopies: [{ id: 'copied', title: '预算表副本' } as DocumentDetail],
      rows: h.catalog.view().rows.map(row => ({ ...row, recovery: { ...row.recovery!, cleanup: { kind: 'quota' } } })),
    }))
    expect(screen.getByRole('link', { name: /预算表副本/ })).toHaveAttribute('href', '/documents/copied')
    expect(button).toHaveFocus()
    expect(screen.getByText(/清理.*空间|空间.*清理/)).toBeInTheDocument()
  })

  it('未知副本拦截内部导航和关闭/刷新，取消留在原页，确认离开不删除草稿', async () => {
    const h = setup({ copyPending: ID, held: ID })
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    fireEvent.click(screen.getByRole('link', { name: '离开草稿页' }))
    let dialog = await screen.findByRole('dialog', { name: '离开本机草稿页？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(h.router.state.location.pathname).toBe('/local-drafts')
    fireEvent.click(screen.getByRole('link', { name: '离开草稿页' }))
    dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '仍然离开' }))
    expect(await screen.findByRole('heading', { name: '下一页' })).toBeInTheDocument()
    expect(h.catalog.discard).not.toHaveBeenCalled()
  })

  it('资格失效立即隐藏旧确认的文档名，重试走真实会话复核', async () => {
    const h = setup()
    fireEvent.click(screen.getByRole('button', { name: '放弃本机修改' }))
    await screen.findByRole('dialog')
    await act(async () => h.update({ problem: 'session', rows: [], held: undefined }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByText('预算表')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(h.recheck).toHaveBeenCalledOnce()
  })
})
