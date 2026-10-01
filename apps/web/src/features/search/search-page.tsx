import type { SearchResult } from '@nerve-office/contracts'
import { documentPagePath, searchKeywordSchema } from '@nerve-office/contracts'
import { useInfiniteQuery } from '@tanstack/react-query'
import { FileSpreadsheet } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { searchMessages } from '../../shared/i18n/zh-cn/search.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { SEARCH_QUERY_PARAM } from '../../shared/lib/space-paths.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { Alert, AlertDescription, Button, Skeleton } from '../../shared/ui/index.ts'
import { searchQueryOptions } from './search-api.ts'

const text = searchMessages

/** 一条结果：标题是打开编辑器页的链接，下面是它在哪里（空间名 + 文件夹路径）与更新时间 */
function ResultItem({ result }: { readonly result: SearchResult }) {
  return (
    <li>
      {/* 编辑器页是另一个入口：普通的链接，整页打开 */}
      <a href={documentPagePath(result.id)} className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
        <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{result.title}</span>
          <span className="truncate text-xs text-muted-foreground">
            {text.location(result.space.type === 'personal' ? messages.documents.title : result.space.name, result.folderPath)}
            {' · '}
            <time dateTime={result.updatedAt}>{messages.documents.updatedAt(formatDateTime(result.updatedAt))}</time>
          </span>
        </span>
      </a>
    </li>
  )
}

function Results({ keyword }: { readonly keyword: string }) {
  const query = useInfiniteQuery(searchQueryOptions(keyword))
  const results = query.data?.pages.flatMap(page => page.items) ?? []
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

  if (query.isPending) {
    return (
      <div role="status" aria-label={text.loading}>
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }
  if (query.data === undefined) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>{text.loadFailed}</p>
          <p>{describeError(query.error).message}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}>{messages.common.retry}</Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (results.length === 0)
    return <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{text.empty(keyword)}</p>
  return (
    <>
      <ul ref={listRef} aria-label={text.listLabel} className="divide-y rounded-lg border">
        {results.map(result => <ResultItem key={result.id} result={result} />)}
      </ul>
      {query.isError && (
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
