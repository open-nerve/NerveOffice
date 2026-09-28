import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { Alert, AlertDescription, Button, Skeleton, Table, TableBody, TableHead, TableHeader, TableRow } from '../../shared/ui/index.ts'

export interface Page<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

interface PagedTableProps<T> {
  readonly query: UseInfiniteQueryResult<InfiniteData<Page<T>>>
  /** 表格的名称（读屏软件读出） */
  readonly label: string
  readonly texts: { readonly loading: string, readonly loadFailed: string, readonly empty: string }
  readonly columns: readonly string[]
  readonly rowKey: (item: T) => string
  /** 一行的各个单元格（TableCell） */
  readonly renderCells: (item: T) => ReactNode
}

/**
 * 管理界面的分页表格（M2-P1 设计 §3.8）：加载中、第一页失败（可以重试）、空、有数据四种状态；"加载更多"按游标取下一页，
 * 失败时保留已有的行并提示。新的一页到了之后，焦点移到第一条新行：按钮可能随之消失，焦点不能留在它身上（M1 审查 B13）。
 */
export function PagedTable<T>({ query, label, texts, columns, rowKey, renderCells }: PagedTableProps<T>) {
  const items = query.data?.pages.flatMap(page => page.items) ?? []
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  const focusFromRef = useRef<number>(undefined)
  useEffect(() => {
    const from = focusFromRef.current
    if (from === undefined || items.length <= from)
      return
    focusFromRef.current = undefined
    const firstNewRow = bodyRef.current?.rows.item(from)
    firstNewRow?.focus()
  }, [items.length])

  function loadMore(): void {
    if (query.isFetchingNextPage)
      return
    focusFromRef.current = items.length
    void query.fetchNextPage().then((result) => {
      // 失败时焦点留在按钮上，错误提示由 role="alert" 读出
      if (result.isError)
        focusFromRef.current = undefined
    })
  }

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-label={texts.loading}>
        {['first', 'second', 'third'].map(row => <Skeleton key={row} className="h-10 w-full" />)}
      </div>
    )
  }
  if (query.data === undefined) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>{texts.loadFailed}</p>
          <p>{describeError(query.error).message}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}>{messages.common.retry}</Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (items.length === 0)
    return <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{texts.empty}</p>

  return (
    <div className="flex flex-col gap-3">
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            {columns.map(column => <TableHead key={column}>{column}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody ref={bodyRef}>
          {items.map(item => (
            // tabIndex -1：只能由程序聚焦（加载更多之后），Tab 键不经过整行
            <TableRow key={rowKey(item)} tabIndex={-1} className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              {renderCells(item)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {query.isError && (
        <Alert variant="destructive">
          <AlertDescription>{describeError(query.error).message}</AlertDescription>
        </Alert>
      )}
      {query.hasNextPage && (
        // 加载中用 aria-disabled：按钮变成 disabled 时浏览器把焦点丢到 body（M1 审查 B13）；重复点击由 loadMore 挡住
        <Button variant="outline" className="self-center" aria-disabled={query.isFetchingNextPage} onClick={loadMore}>
          {query.isFetchingNextPage ? messages.common.loadingMore : messages.common.loadMore}
        </Button>
      )}
    </div>
  )
}
