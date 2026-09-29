import type { DocumentSummary } from '@nerve-office/contracts'
import { documentPagePath } from '@nerve-office/contracts'
import { useInfiniteQuery } from '@tanstack/react-query'
import { FileSpreadsheet } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { Alert, AlertDescription, Button, Skeleton } from '../../shared/ui/index.ts'
import { spaceDocumentsQueryOptions } from './documents-api.ts'

function DocumentItem({ document }: { document: DocumentSummary }) {
  return (
    <li>
      {/* 编辑器页是另一个入口：普通的链接，整页打开（P4 设计 §3.7.4） */}
      <a href={documentPagePath(document.id)} className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
        <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{document.title}</span>
          <span className="text-xs text-muted-foreground">
            {messages.documents.typeName(document.type)}
            {' · '}
            <time dateTime={document.updatedAt}>{messages.documents.updatedAt(formatDateTime(document.updatedAt))}</time>
          </span>
        </span>
      </a>
    </li>
  )
}

function LoadingRows() {
  // 名称与"确认登录状态"的骨架屏不同：测试与读屏软件都能分清是哪一步在加载（审查 B10）
  return (
    <div className="flex flex-col gap-3" role="status" aria-label={messages.documents.loading}>
      {['first', 'second', 'third'].map(row => <Skeleton key={row} className="h-12 w-full" />)}
    </div>
  )
}

/**
 * 一个空间里的文档列表（US-M1-03，M2-P2 设计 §3.10）。加载中、空列表、加载失败都有明确的显示；分页用"加载更多"。
 * 标题与操作（新建表格等）在空间页的页头。
 */
export function DocumentList({ spaceId }: { readonly spaceId: string }) {
  const query = useInfiniteQuery(spaceDocumentsQueryOptions(spaceId))
  const documents = query.data?.pages.flatMap(page => page.items) ?? []
  // 加载更多时已有的条数：新的一页到了之后，焦点移到第一个新条目。按钮可能随之消失（没有下一页了），焦点不能留在它身上（审查 B13）
  const listRef = useRef<HTMLUListElement>(null)
  const focusFromRef = useRef<number>(undefined)
  useEffect(() => {
    const from = focusFromRef.current
    if (from === undefined || documents.length <= from)
      return
    focusFromRef.current = undefined
    const firstNewLink = listRef.current?.children.item(from)?.querySelector('a')
    firstNewLink?.focus()
  }, [documents.length])

  function loadMore(): void {
    if (query.isFetchingNextPage)
      return
    focusFromRef.current = documents.length
    void query.fetchNextPage().then((result) => {
      // 失败时焦点留在按钮上，错误提示由 role="alert" 读出
      if (result.isError)
        focusFromRef.current = undefined
    })
  }

  if (query.isPending)
    return <LoadingRows />
  if (query.data === undefined) {
    // 第一页就失败了；加载下一页失败时 status 同样是 error，但已经有数据，列表要保留
    const error = describeError(query.error)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>{messages.documents.loadFailed}</p>
          <p>{error.message}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}>{messages.common.retry}</Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (documents.length === 0)
    return <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{messages.documents.empty}</p>
  return (
    <>
      <ul ref={listRef} aria-label={messages.documents.listLabel} className="divide-y rounded-lg border">
        {documents.map(document => <DocumentItem key={document.id} document={document} />)}
      </ul>
      {query.isError && (
        <Alert variant="destructive">
          <AlertDescription>{describeError(query.error).message}</AlertDescription>
        </Alert>
      )}
      {query.hasNextPage && (
        // 加载中用 aria-disabled：按钮变成 disabled 时浏览器把焦点丢到 body（审查 B13）；重复点击由 loadMore 挡住
        <Button variant="outline" className="self-center" aria-disabled={query.isFetchingNextPage} onClick={loadMore}>
          {query.isFetchingNextPage ? messages.documents.loadingMore : messages.documents.loadMore}
        </Button>
      )}
    </>
  )
}
