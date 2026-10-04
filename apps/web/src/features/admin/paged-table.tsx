import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query'
import type { ReactNode, Ref, RefObject } from 'react'
import type { BackgroundRefresh } from '../../shared/api/write-outcome.ts'
import { useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { cn } from '../../shared/lib/cn.ts'
import { useFirstLoadRetry } from '../../shared/lib/use-first-load-retry.ts'
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

/** 只能由程序聚焦的元素（tabIndex -1）得到焦点时的样式：键盘操作时看得见焦点在哪里 */
const FOCUS_RING = 'outline-none focus-visible:ring-3 focus-visible:ring-ring/50'

/** 列表本身（表格，或者空的说明）带的标记 data-paged-list："没能刷新"的说明消失时按它找到焦点的去处 */
const LIST_SELECTOR = '[data-paged-list]'

/**
 * 管理界面的分页表格（M2-P1 设计 §3.8）：加载中、第一页失败（可以重试）、空、有数据四种状态；"加载更多"按游标取下一页，
 * 失败时保留已有的行并提示。新的一页到了之后，焦点移到第一条新行：按钮可能随之消失，焦点不能留在它身上（M1 审查 B13）。
 * 留着之前的行、刷新却失败了（例如写操作之后）：表格上方明说没能刷新、给出重试（Codex 对抗评审 CX5）；重试成功之后焦点交给列表本身。
 * 第一页失败之后按"重试"：重试期间说明与按钮留着（不可用、说正在重试），取到之后焦点同样交给列表本身（规范 §2.4，use-first-load-retry.ts）
 */
export function PagedTable<T>({ query, label, texts, columns, rowKey, renderCells, ref }: PagedTableProps<T>) {
  const items = query.data?.pages.flatMap(page => page.items) ?? []
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  /** 有数据时的外层：没能刷新的说明与列表本身都在它里面 */
  const dataRef = useRef<HTMLDivElement>(null)
  /**
   * 列表本身（表格，或者空的说明，同一时刻只有一个）："没能刷新"的说明连同"重试"一起消失时焦点交给它。按标记在外层里找，不用它自己的 ref：
   * 刷新之后由有行变成空（或者反过来）时，说明交出焦点的那一刻新的那个已经在页面上，它的 ref 却还没接上（React 先执行排在前面的说明的布局效果）
   */
  const listFocus = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() {
      return dataRef.current?.querySelector<HTMLElement>(LIST_SELECTOR) ?? null
    },
  }), [])
  const firstLoad = useFirstLoadRetry(query, listFocus)
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

  if (firstLoad.failed) {
    // 重试期间说明与按钮留着（aria-disabled：按钮变成 disabled 时焦点会丢），上一次的原因不再给（请求缓存已经清掉了它）
    return (
      <Alert variant="destructive" onFocus={firstLoad.focus.onFocus} onBlur={firstLoad.focus.onBlur}>
        <AlertDescription>
          <p>{texts.loadFailed}</p>
          {!firstLoad.retrying && <p>{describeError(query.error).message}</p>}
          <Button variant="outline" size="sm" className="mt-2" aria-disabled={firstLoad.retrying} aria-busy={firstLoad.retrying} onClick={() => void query.refetch()}>
            {firstLoad.retrying ? messages.common.retrying : messages.common.retry}
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (query.data === undefined) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-label={texts.loading}>
        {['first', 'second', 'third'].map(row => <Skeleton key={row} className="h-10 w-full" />)}
      </div>
    )
  }
  // 有数据（含空）：没能刷新的说明在同一个位置（刷新之后由有行变成空、由空变成有行时它也不重新挂载），重试成功、说明连同"重试"一起
  // 消失时把焦点交给列表本身——表格或者空的说明（tabIndex -1，只能由程序聚焦），不落到 body（规范 §2.4）
  return (
    <div ref={dataRef} className="flex flex-col gap-3">
      <RefreshProblem query={query} fallbackFocus={listFocus} />
      {items.length === 0
        ? <p data-paged-list="" tabIndex={-1} className={cn('rounded-lg border border-dashed p-8 text-center text-muted-foreground', FOCUS_RING)}>{texts.empty}</p>
        : (
            <>
              <Table data-paged-list="" tabIndex={-1} aria-label={label} className={FOCUS_RING}>
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
                      <TableRow key={key} data-row-key={key} tabIndex={-1} className={FOCUS_RING}>
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
            </>
          )}
    </div>
  )
}
