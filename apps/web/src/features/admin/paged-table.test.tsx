// 管理界面的分页表格：加载中、第一页失败（可以重试）、空、有数据；加载更多与焦点；由页面把焦点放回某一行。
import type { Ref } from 'react'
import type { Page, PagedTableHandle } from './paged-table.tsx'
import { QueryClient, QueryClientProvider, useInfiniteQuery } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { refreshAfterSuccess } from '../../shared/api/write-outcome.ts'
import { TableCell } from '../../shared/ui/index.ts'
import { PagedTable, StillRefreshingLine } from './paged-table.tsx'

interface Item {
  readonly id: string
  readonly name: string
}

type FetchPage = (cursor: string | null) => Promise<Page<Item>>

const TEXTS = { loading: '正在加载条目…', loadFailed: '条目加载失败', empty: '没有条目' }

function Harness({ fetchPage, tableRef }: { readonly fetchPage: FetchPage, readonly tableRef?: Ref<PagedTableHandle> }) {
  const query = useInfiniteQuery({
    queryKey: ['items'],
    queryFn: async ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
  })
  return (
    <PagedTable
      ref={tableRef}
      query={query}
      label="条目列表"
      texts={TEXTS}
      columns={['名字']}
      rowKey={item => item.id}
      renderCells={item => <TableCell>{item.name}</TableCell>}
    />
  )
}

function renderTable(fetchPage: FetchPage, tableRef?: Ref<PagedTableHandle>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rendered = render(
    <QueryClientProvider client={client}>
      <Harness fetchPage={fetchPage} tableRef={tableRef} />
    </QueryClientProvider>,
  )
  return { ...rendered, client }
}

function items(...names: string[]): Item[] {
  return names.map(name => ({ id: `id-${name}`, name }))
}

/** 由测试决定何时返回的一页 */
function pending(): { fetch: () => Promise<Page<Item>>, resolve: (page: Page<Item>) => void, reject: (error: unknown) => void } {
  let resolve: (page: Page<Item>) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<Page<Item>>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { fetch: async () => promise, resolve, reject }
}

describe('PagedTable', () => {
  it('加载中：骨架屏与可读的状态；到了之后显示表格', async () => {
    const first = pending()
    renderTable(first.fetch)
    expect(screen.getByRole('status', { name: '正在加载条目…' })).toBeInTheDocument()
    first.resolve({ items: items('甲', '乙'), nextCursor: null })
    const table = await screen.findByRole('table', { name: '条目列表' })
    expect(within(table).getAllByRole('row').map(row => row.textContent)).toEqual(['名字', '甲', '乙'])
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
  })

  it('空：明确的说明', async () => {
    renderTable(async () => ({ items: [], nextCursor: null }))
    expect(await screen.findByText('没有条目')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('第一页失败：说明失败与原因，可以重试', async () => {
    const fetchPage = vi.fn<FetchPage>(async () => {
      throw new ApiError(403, 'PERMISSION_DENIED', '没有执行这个操作的权限')
    })
    renderTable(fetchPage)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('条目加载失败')
    // 看得到却不能做的原因由服务端给出（ADR-008 的例外，M2-P6 复核 S5）
    expect(alert).toHaveTextContent('没有执行这个操作的权限')
    fetchPage.mockResolvedValue({ items: items('甲'), nextCursor: null })
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('table', { name: '条目列表' })).toBeInTheDocument()
  })

  it('加载更多：加载中按钮标为不可用、再点不重复请求；新的一页到了之后焦点移到第一条新行', async () => {
    const second = pending()
    const fetchPage = vi.fn<FetchPage>(async cursor => (cursor === null ? { items: items('甲'), nextCursor: 'c1' } : second.fetch()))
    renderTable(fetchPage)
    const more = await screen.findByRole('button', { name: '加载更多' })
    more.focus()
    fireEvent.click(more)
    const busy = await screen.findByRole('button', { name: '正在加载…' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    // aria-disabled 而不是 disabled：焦点不丢
    expect(document.activeElement).toBe(busy)
    fireEvent.click(busy)
    expect(fetchPage).toHaveBeenCalledTimes(2)

    second.resolve({ items: items('乙', '丙'), nextCursor: null })
    const table = await screen.findByRole('table', { name: '条目列表' })
    await waitFor(() => expect(document.activeElement).toHaveTextContent('乙'))
    expect(within(table).getAllByRole('row')).toHaveLength(4)
    // 没有下一页了，按钮消失
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
  })

  it('加载更多失败：保留已有的行，说明原因，焦点留在按钮上，可以再试', async () => {
    const fetchPage = vi.fn<FetchPage>(async (cursor) => {
      if (cursor === null)
        return { items: items('甲'), nextCursor: 'c1' }
      throw new NetworkError('x')
    })
    renderTable(fetchPage)
    const more = await screen.findByRole('button', { name: '加载更多' })
    more.focus()
    fireEvent.click(more)
    expect(await screen.findByRole('alert')).toHaveTextContent('网络连接失败，请检查网络后重试')
    expect(within(screen.getByRole('table', { name: '条目列表' })).getByText('甲')).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '加载更多' }))

    fetchPage.mockResolvedValueOnce({ items: items('乙'), nextCursor: null })
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await waitFor(() => expect(document.activeElement).toHaveTextContent('乙'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('由页面把焦点放回某一行；这一行不在表里时返回 false', async () => {
    const tableRef = createRef<PagedTableHandle>()
    renderTable(async () => ({ items: items('甲', '乙'), nextCursor: null }), tableRef)
    await screen.findByRole('table', { name: '条目列表' })
    let found: boolean | undefined
    act(() => {
      found = tableRef.current?.focusRow('id-乙')
    })
    expect(found).toBe(true)
    expect(document.activeElement).toHaveTextContent('乙')
    expect(tableRef.current?.focusRow('id-不存在')).toBe(false)
  })

  it('还在加载时（没有表）：放不回焦点，返回 false', () => {
    const tableRef = createRef<PagedTableHandle>()
    renderTable(pending().fetch, tableRef)
    expect(tableRef.current?.focusRow('id-甲')).toBe(false)
  })

  it('留着之前的行、刷新却失败了（例如写操作之后，Codex 对抗评审 CX5）：表格上方说明没能刷新与原因、给出重试，旧的行照常显示；重试成功之后说明消失，行是新的', async () => {
    const fetchPage = vi.fn<FetchPage>(async () => ({ items: items('甲'), nextCursor: null }))
    const { client } = renderTable(fetchPage)
    const table = await screen.findByRole('table', { name: '条目列表' })
    fetchPage.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'x'))
    await act(async () => client.invalidateQueries({ queryKey: ['items'] }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('列表没能刷新，显示的还是之前的内容')
    expect(alert).toHaveTextContent('服务器出了点问题，请稍后重试')
    expect(alert.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(table).getByText('甲')).toBeInTheDocument()
    fetchPage.mockResolvedValueOnce({ items: items('乙'), nextCursor: null })
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await within(table).findByText('乙')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('没能刷新、按"重试"成功之后说明连同"重试"一起消失：焦点交给表格，不落到 body（规范 §2.4）；刷新之后变成空的也交给空的说明', async () => {
    const fetchPage = vi.fn<FetchPage>(async () => ({ items: items('甲'), nextCursor: null }))
    const { client } = renderTable(fetchPage)
    const table = await screen.findByRole('table', { name: '条目列表' })
    fetchPage.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'x'))
    await act(async () => client.invalidateQueries({ queryKey: ['items'] }))
    const retry = within(await screen.findByRole('alert')).getByRole('button', { name: '重试' })
    retry.focus()
    fetchPage.mockResolvedValueOnce({ items: items('乙'), nextCursor: null })
    fireEvent.click(retry)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(document.activeElement).toBe(table)

    fetchPage.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'x'))
    await act(async () => client.invalidateQueries({ queryKey: ['items'] }))
    const again = within(await screen.findByRole('alert')).getByRole('button', { name: '重试' })
    again.focus()
    fetchPage.mockResolvedValueOnce({ items: [], nextCursor: null })
    fireEvent.click(again)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(document.activeElement).toBe(screen.getByText('没有条目'))
  })

  it('加载下一页失败：照旧只说原因（在表格下方），不说成"没能刷新"', async () => {
    const fetchPage = vi.fn<FetchPage>(async (cursor) => {
      if (cursor === null)
        return { items: items('甲'), nextCursor: 'c1' }
      throw new ApiError(500, 'INTERNAL_ERROR', 'x')
    })
    renderTable(fetchPage)
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/^服务器出了点问题，请稍后重试$/)
    expect(screen.queryByText(/没能刷新/)).toBeNull()
  })
})

describe('StillRefreshingLine（Codex 对抗评审 CX4）', () => {
  it('一直在的一行，显式写 aria-live（弹窗开着时遮罩跳过它）：没有在后台的刷新时是空的、只做视觉隐藏；还在后台刷新时说列表还在刷新，有了结果之后又空了', async () => {
    let finish: () => void = () => {}
    const background = await refreshAfterSuccess(async () => new Promise<void>((resolve) => {
      finish = resolve
    }), { timeLimitMs: 10 })
    const { rerender } = render(<StillRefreshingLine background={undefined} />)
    const line = screen.getByRole('status')
    expect(line).toHaveAttribute('aria-live', 'polite')
    expect(line).toBeEmptyDOMElement()
    expect(line).toHaveClass('sr-only')
    rerender(<StillRefreshingLine background={background} />)
    expect(screen.getByRole('status')).toBe(line)
    expect(line).toHaveTextContent('列表还在刷新，显示的可能还是之前的，刷新好了会自动更新。')
    expect(line).not.toHaveClass('sr-only')
    await act(async () => finish())
    expect(line).toBeEmptyDOMElement()
  })
})
