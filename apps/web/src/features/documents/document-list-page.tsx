import type { DocumentSummary } from '@nerve-office/contracts'
import { useInfiniteQuery } from '@tanstack/react-query'
import { FileSpreadsheet } from 'lucide-react'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { Alert, AlertDescription, Button, Skeleton } from '../../shared/ui/index.ts'
import { personalDocumentsQueryOptions } from './documents-api.ts'

function DocumentItem({ document }: { document: DocumentSummary }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{document.title}</span>
        <span className="text-xs text-muted-foreground">
          {messages.documents.typeName(document.type)}
          {' · '}
          <time dateTime={document.updatedAt}>{messages.documents.updatedAt(formatDateTime(document.updatedAt))}</time>
        </span>
      </div>
    </li>
  )
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label={messages.common.loading}>
      {['first', 'second', 'third'].map(row => <Skeleton key={row} className="h-12 w-full" />)}
    </div>
  )
}

/** 我的空间：个人空间的文档列表（US-M1-03）。加载中、空列表、加载失败都有明确的显示；分页用"加载更多"。 */
export function DocumentListPage() {
  const query = useInfiniteQuery(personalDocumentsQueryOptions())
  const documents = query.data?.pages.flatMap(page => page.items) ?? []

  let content
  if (query.isPending) {
    content = <LoadingRows />
  }
  else if (query.data === undefined) {
    // 第一页就失败了；加载下一页失败时 status 同样是 error，但已经有数据，列表要保留
    const error = describeError(query.error)
    content = (
      <Alert variant="destructive">
        <AlertDescription>
          <p>{messages.documents.loadFailed}</p>
          <p>{error.message}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}>{messages.common.retry}</Button>
        </AlertDescription>
      </Alert>
    )
  }
  else if (documents.length === 0) {
    content = <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{messages.documents.empty}</p>
  }
  else {
    content = (
      <>
        <ul aria-label={messages.documents.listLabel} className="divide-y rounded-lg border">
          {documents.map(document => <DocumentItem key={document.id} document={document} />)}
        </ul>
        {query.isError && (
          <Alert variant="destructive">
            <AlertDescription>{describeError(query.error).message}</AlertDescription>
          </Alert>
        )}
        {query.hasNextPage && (
          <Button variant="outline" className="self-center" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {query.isFetchingNextPage ? messages.documents.loadingMore : messages.documents.loadMore}
          </Button>
        )}
      </>
    )
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="documents-title">
      <h1 id="documents-title" className="text-xl font-semibold">{messages.documents.title}</h1>
      {content}
    </section>
  )
}
