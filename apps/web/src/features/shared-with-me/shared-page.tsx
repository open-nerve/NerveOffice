import type { SharedDocument } from '@nerve-office/contracts'
import { documentPagePath } from '@nerve-office/contracts'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { FileSpreadsheet } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { sharedWithMeMessages } from '../../shared/i18n/zh-cn/shared-with-me.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { Alert, AlertDescription, Button, Skeleton } from '../../shared/ui/index.ts'
import { SpaceLabel } from '../../shared/ui/space-label.tsx'
import { sessionQueryOptions } from '../auth/index.ts'
import { sharedListQueryOptions } from './shared-api.ts'

const text = sharedWithMeMessages

/**
 * 一条：标题是打开编辑器页的链接（整页打开，另一个入口）；下面是所属的空间（团队空间的名称；个人空间按所有者的人名呈现）、
 * 我能不能编辑与更新时间。不显示所在位置：只凭授权的人看不到空间的目录结构（00 号计划书 §5.5），契约里也不给文件夹
 */
function SharedItem({ document, viewerId }: { readonly document: SharedDocument, readonly viewerId: string | undefined }) {
  return (
    <li>
      <a href={documentPagePath(document.id)} className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
        <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{document.title}</span>
          <span className="text-xs text-muted-foreground">
            <SpaceLabel space={document.space} viewerId={viewerId} />
            {' · '}
            {document.contentRole === 'viewer' ? text.readOnly : text.canEdit}
            {' · '}
            <time dateTime={document.updatedAt}>{messages.documents.updatedAt(formatDateTime(document.updatedAt))}</time>
          </span>
        </span>
      </a>
    </li>
  )
}

/** 列表：加载中、加载失败（可以重试）、一份也没有、逐页加载 */
function SharedList() {
  const query = useInfiniteQuery(sharedListQueryOptions())
  const session = useQuery(sessionQueryOptions())
  const documents = query.data?.pages.flatMap(page => page.items) ?? []
  // 加载更多时已有的条数：新的一页到了之后，焦点移到第一条新内容。按钮在最后一页之后随之消失，焦点不能留在它身上
  // （文档列表与搜索结果的做法，M1 审查 B13；M2-P6 复核 S3 的 P13）
  const listRef = useRef<HTMLUListElement>(null)
  const focusFromRef = useRef<number>(undefined)
  useEffect(() => {
    const from = focusFromRef.current
    if (from === undefined || documents.length <= from)
      return
    focusFromRef.current = undefined
    listRef.current?.children.item(from)?.querySelector('a')?.focus()
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

  if (query.isPending) {
    // 骨架屏本身不带 role：状态写在包住它的容器上（M2-P6 复核 S4）
    return (
      <div role="status" aria-label={text.loading} className="flex flex-col gap-3">
        {['first', 'second', 'third'].map(row => <Skeleton key={row} className="h-12 w-full" />)}
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
  if (documents.length === 0)
    return <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{text.empty}</p>
  return (
    <>
      <ul ref={listRef} aria-label={text.listLabel} className="divide-y rounded-lg border">
        {documents.map(document => <SharedItem key={document.id} document={document} viewerId={session.data?.user.id} />)}
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
 * "与我共享"（M2-P5 设计 §3.5，US-M2-10）：别人单独分享给我的全部文档（不论我在那个空间里有没有角色），按更新时间从新到旧。
 * 每条显示文档与所属的空间，不显示所在位置。路由级按需加载，不进平台页面的首屏
 */
export function SharedWithMePage() {
  useDocumentTitle(messages.spaces.sharedWithMe)
  return (
    <section className="flex flex-col gap-4" aria-labelledby="shared-title">
      <h1 id="shared-title" className="text-xl font-semibold">{messages.spaces.sharedWithMe}</h1>
      <p className="text-sm text-muted-foreground">{text.description}</p>
      <SharedList />
    </section>
  )
}
