import type { SearchResult } from '@nerve-office/contracts'
import type { RefObject } from 'react'
import { documentPagePath, searchKeywordSchema } from '@nerve-office/contracts'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { FileSpreadsheet } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { searchMessages } from '../../shared/i18n/zh-cn/search.ts'
import { cn } from '../../shared/lib/cn.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { SEARCH_QUERY_PARAM } from '../../shared/lib/space-paths.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { useFirstLoadRetry } from '../../shared/lib/use-first-load-retry.ts'
import { Alert, AlertDescription, Button, RetryButton, Skeleton } from '../../shared/ui/index.ts'
import { RefreshProblem } from '../../shared/ui/refresh-problem.tsx'
import { SpaceLabel } from '../../shared/ui/space-label.tsx'
import { sessionQueryOptions } from '../auth/index.ts'
import { searchQueryOptions } from './search-api.ts'

const text = searchMessages

/** 只能由程序聚焦的元素（tabIndex -1）得到焦点时的样式：键盘操作时看得见焦点在哪里 */
const FOCUS_RING = 'outline-none focus-visible:ring-3 focus-visible:ring-ring/50'

/** 列表本身（结果的列表，或者没搜到的说明）带的标记：说明连同"重试"消失时按它找到焦点的去处 */
const LIST_SELECTOR = '[data-search-results]'

/**
 * 一条结果：标题是打开编辑器页的链接，下面是它在哪里与更新时间。所在的空间：团队空间是名称，自己的个人空间是"我的空间"，
 * 别人的个人空间（凭单独授权命中，M2-P5）按所有者的人名呈现（人名组件），不用个人空间存的名称（规范 §2.4）；
 * 后面是从空间根目录到它所在文件夹的路径（凭授权命中的一条没有：看不到空间的目录结构）
 */
function ResultItem({ result, viewerId }: { readonly result: SearchResult, readonly viewerId: string | undefined }) {
  return (
    <li>
      {/* 编辑器页是另一个入口：普通的链接，整页打开 */}
      <a href={documentPagePath(result.id)} className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
        <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{result.title}</span>
          <span className="truncate text-xs text-muted-foreground">
            <SpaceLabel space={result.space} viewerId={viewerId} />
            {text.folderPath(result.folderPath)}
            {' · '}
            <time dateTime={result.updatedAt}>{messages.documents.updatedAt(formatDateTime(result.updatedAt))}</time>
          </span>
        </span>
      </a>
    </li>
  )
}

/**
 * 一次搜索的结果：加载中、失败（可以重试）、没搜到、逐页加载；留着之前的结果、重新请求却失败了时明说、给出重试（Codex 对抗评审 CX5）。
 * 第一次就没取到时按"重试"：重试期间说明与按钮留着（不可用、说正在重试）；取到之后说明连同"重试"一起消失，焦点交给列表本身
 * （结果的列表，或者没搜到的说明；tabIndex -1，只能由程序聚焦），不落到 body（规范 §2.4，shared/lib/use-first-load-retry.ts）；
 * "没能刷新"的说明重试成功之后同样如此（与管理界面的分页表格同一个做法）
 */
function Results({ keyword }: { readonly keyword: string }) {
  const query = useInfiniteQuery(searchQueryOptions(keyword))
  const session = useQuery(sessionQueryOptions())
  const results = query.data?.pages.flatMap(page => page.items) ?? []
  /** 有结果时的外层：没能刷新的说明与列表本身都在它里面 */
  const dataRef = useRef<HTMLDivElement>(null)
  /**
   * 列表本身（同一时刻只有一个）。按标记在外层里找，不用它自己的 ref：刷新之后由有结果变成没搜到（或者反过来）时，"没能刷新"的说明
   * 交出焦点的那一刻新的那个已经在页面上，它的 ref 却还没接上（React 先执行排在前面的说明的布局效果）
   */
  const listFocus = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() {
      return dataRef.current?.querySelector<HTMLElement>(LIST_SELECTOR) ?? null
    },
  }), [])
  const firstLoad = useFirstLoadRetry(query, listFocus)
  // 加载更多时已有的条数：新的一页到了之后，焦点移到第一条新结果。按钮在最后一页之后随之消失，焦点不能留在它身上
  // （文档列表与管理表格的做法，M1 审查 B13；M2-P6 复核 S3 的 P13）
  const listRef = useRef<HTMLUListElement>(null)
  const focusFromRef = useRef<number>(undefined)
  useEffect(() => {
    const from = focusFromRef.current
    if (from === undefined || results.length <= from)
      return
    focusFromRef.current = undefined
    listRef.current?.children.item(from)?.querySelector('a')?.focus()
  }, [results.length])

  function loadMore(): void {
    if (query.isFetchingNextPage)
      return
    focusFromRef.current = results.length
    void query.fetchNextPage().then((result) => {
      // 失败时焦点留在按钮上，错误提示由 role="alert" 读出
      if (result.isError)
        focusFromRef.current = undefined
    })
  }

  if (firstLoad.failed) {
    // 重试期间说明与按钮留着（不可用、说正在重试），上一次的原因不再给（请求缓存已经清掉了它）
    return (
      <Alert variant="destructive" onFocus={firstLoad.focus.onFocus} onBlur={firstLoad.focus.onBlur}>
        <AlertDescription>
          <p>{text.loadFailed}</p>
          {!firstLoad.retrying && <p>{describeError(query.error).message}</p>}
          <RetryButton retrying={firstLoad.retrying} onRetry={() => void query.refetch()} className="mt-2" />
        </AlertDescription>
      </Alert>
    )
  }
  if (query.data === undefined) {
    return (
      <div role="status" aria-label={text.loading}>
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }
  // 留着之前的结果、重新请求却失败了（例如回到这一页时，Codex 对抗评审 CX5）：明说没能刷新、给出重试，之前的结果照常显示；
  // 说明在同一个位置（由有结果变成没搜到时它也不重新挂载），重试成功之后焦点交给列表本身
  return (
    <div ref={dataRef} className="flex flex-col gap-4">
      <RefreshProblem query={query} list={text.listLabel} fallbackFocus={listFocus} />
      {results.length === 0
        ? <p data-search-results="" tabIndex={-1} className={cn('rounded-lg border border-dashed p-8 text-center text-muted-foreground', FOCUS_RING)}>{text.empty(keyword)}</p>
        : (
            <>
              <ul ref={listRef} data-search-results="" tabIndex={-1} aria-label={text.listLabel} className={cn('divide-y rounded-lg border', FOCUS_RING)}>
                {results.map(result => <ResultItem key={result.id} result={result} viewerId={session.data?.user.id} />)}
              </ul>
              {query.isFetchNextPageError && (
                <Alert variant="destructive">
                  <AlertDescription>{describeError(query.error).message}</AlertDescription>
                </Alert>
              )}
              {query.hasNextPage && (
                // 加载中用 aria-disabled：按钮变成 disabled 时浏览器把焦点丢到 body（审查 B13）；重复点击由 loadMore 挡住
                <Button variant="outline" className="self-center" aria-disabled={query.isFetchingNextPage} onClick={loadMore}>
                  {query.isFetchingNextPage ? messages.common.loadingMore : messages.common.loadMore}
                </Button>
              )}
            </>
          )}
    </div>
  )
}

/**
 * 搜索结果页（M2-P4 设计 §3.7，US-M2-12）：关键词在地址的查询参数里，所以结果页可以分享、可以刷新、可以前进后退。
 * 页头的搜索框只负责跳到这里，结果页按需加载，不进平台页面的首屏包。
 * 排序是"最近更新在前"（服务端不做相关度排序），这里如实写明。
 */
export function SearchPage() {
  const [params] = useSearchParams()
  const raw = params.get(SEARCH_QUERY_PARAM) ?? ''
  const parsed = searchKeywordSchema.safeParse(raw)
  const heading = parsed.success ? text.heading(parsed.data) : text.title
  useDocumentTitle(heading)

  return (
    <section className="flex flex-col gap-4" aria-labelledby="search-title">
      <h1 id="search-title" className="text-xl font-semibold">{heading}</h1>
      {parsed.success
        ? (
            <>
              <p className="text-sm text-muted-foreground">{text.sortNote}</p>
              <Results key={parsed.data} keyword={parsed.data} />
            </>
          )
        : <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{text.noKeyword}</p>}
    </section>
  )
}
