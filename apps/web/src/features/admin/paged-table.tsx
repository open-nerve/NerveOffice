import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query'
import type { ReactNode, Ref } from 'react'
import type { BackgroundRefresh } from '../../shared/api/write-outcome.ts'
import { useEffect, useImperativeHandle, useRef } from 'react'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { useStillRefreshing } from '../../shared/lib/use-still-refreshing.ts'
import { Alert, AlertDescription, Button, Skeleton, Table, TableBody, TableHead, TableHeader, TableRow } from '../../shared/ui/index.ts'
import { RefreshProblem } from '../../shared/ui/refresh-problem.tsx'

export interface Page<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

/** 由页面调用：操作完成、弹窗关闭之后把焦点放回这一行（审查 B9） */
export interface PagedTableHandle {
  /** 焦点移到 rowKey 为 key 的行；这一行不在表里（被过滤掉了、表是空的、还在加载）时返回 false，由页面另找去处 */
  readonly focusRow: (key: string) => boolean
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
  readonly ref?: Ref<PagedTableHandle>
}

/**
 * 页面上的写操作成功之后、到了时限还在后台的刷新（Codex 对抗评审 CX4，shared/api/write-outcome.ts 的 refreshAfterSuccess）：
 * 表格上方一直在的一行，列表还在刷新时说出来，有了结果之后不再说。账户、邀请与团队空间这几页没有别的说明可以接着说，统一用它。
 * 显式写 aria-live（语义不变：role="status" 本来就是 polite）：弹窗（确认框、签发链接的弹窗、改名与加入空间的弹窗）开着时
 * Radix 把弹窗之外的内容都标为 aria-hidden，只跳过打开那一刻已经在的、显式写了 aria-live 的元素——这一行一直在，弹窗开着时写进去
 * 照样播报（与编辑器页头的保存状态同一个做法，规范 §2.4）。空的时候只做视觉隐藏
 */
export function StillRefreshingLine({ background }: { readonly background: BackgroundRefresh | undefined }) {
  const refreshing = useStillRefreshing(background)
  return <p role="status" aria-live="polite" className={refreshing ? 'm-0 text-sm text-muted-foreground' : 'sr-only'}>{refreshing ? `${messages.common.stillRefreshing()}。` : null}</p>
}

/**
 * 管理界面的分页表格（M2-P1 设计 §3.8）：加载中、第一页失败（可以重试）、空、有数据四种状态；"加载更多"按游标取下一页，
 * 失败时保留已有的行并提示。新的一页到了之后，焦点移到第一条新行：按钮可能随之消失，焦点不能留在它身上（M1 审查 B13）。
 * 留着之前的行、刷新却失败了（例如写操作之后）：表格上方明说没能刷新、给出重试（Codex 对抗评审 CX5）
 */
export function PagedTable<T>({ query, label, texts, columns, rowKey, renderCells, ref }: PagedTableProps<T>) {
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
  useImperativeHandle(ref, () => ({
    focusRow: (key) => {
      const row = Array.from(bodyRef.current?.rows ?? []).find(candidate => candidate.dataset.rowKey === key)
      row?.focus()
      return row !== undefined
    },
  }), [])

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
  const refreshProblem = <RefreshProblem query={query} />
  if (items.length === 0) {
    return (
      <>
        {refreshProblem}
        <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{texts.empty}</p>
      </>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {refreshProblem}
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            {columns.map(column => <TableHead key={column}>{column}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody ref={bodyRef}>
          {items.map((item) => {
            const key = rowKey(item)
            return (
              // tabIndex -1：只能由程序聚焦（加载更多之后、操作完成之后），Tab 键不经过整行
              <TableRow key={key} data-row-key={key} tabIndex={-1} className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                {renderCells(item)}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {query.isFetchNextPageError && (
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
