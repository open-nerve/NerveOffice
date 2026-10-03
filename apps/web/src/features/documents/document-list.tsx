import type { RefObject } from 'react'
import type { OrganizeNotice } from './item-actions.tsx'
import type { TargetSpaces } from './target-spaces.ts'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { Alert, AlertDescription, Button, Skeleton } from '../../shared/ui/index.ts'
import { RefreshProblem } from '../../shared/ui/refresh-problem.tsx'
import { DocumentRow } from './document-row.tsx'
import { folderDocumentsQueryOptions } from './documents-api.ts'

function LoadingRows() {
  // 名称与"确认登录状态"的骨架屏不同：测试与读屏软件都能分清是哪一步在加载（审查 B10）
  return (
    <div className="flex flex-col gap-3" role="status" aria-label={messages.documents.loading}>
      {['first', 'second', 'third'].map(row => <Skeleton key={row} className="h-12 w-full" />)}
    </div>
  )
}

interface DocumentListProps {
  readonly spaceId: string
  /** 当前所在的文件夹；null 表示空间的根目录（M2-P4） */
  readonly folderId: string | null
  /** 我能新建内容的空间，连同取到了没有：移动与复制的目标候选 */
  readonly targetSpaces: TargetSpaces
  /** 当前展开操作面板的那一个（整页只有一个） */
  readonly openId: string | undefined
  /** 记下被点的那个"操作"按钮：面板收起之后空间页把焦点还给它 */
  readonly openTriggerRef: RefObject<HTMLButtonElement | null>
  readonly onToggle: (id: string) => void
  readonly onDone: (notice: OrganizeNotice | undefined) => void
  /** 操作按访问权限被拒绝：由空间页重新请求，兑现为列表刷新好了没有（M2-P6 复核第五批 G3） */
  readonly onDenied: () => Promise<boolean>
  /** 这一层还有没有子文件夹：都没有时"这里还没有文档"才是整块空的说明 */
  readonly hasFolders: boolean
}

/**
 * 一个空间里某个文件夹下的文档列表（US-M1-03，M2-P2 设计 §3.10，M2-P4 按目录过滤）。
 * 加载中、空列表、加载失败都有明确的显示；分页用"加载更多"。标题与新建在空间页的页头，子文件夹排在这个列表前面。
 * 留着之前的列表、刷新却失败了（例如整理之后）：列表上方明说没能刷新、给出重试（Codex 对抗评审 CX5）；加载下一页失败另在列表下方说明。
 * 每一行与它的操作面板是 document-row.tsx（与"与我共享"共用）
 */
export function DocumentList({ spaceId, folderId, targetSpaces, openId, openTriggerRef, onToggle, onDone, onDenied, hasFolders }: DocumentListProps) {
  const query = useInfiniteQuery(folderDocumentsQueryOptions(spaceId, folderId))
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
  const refreshProblem = <RefreshProblem query={query} list={messages.documents.listLabel} />
  if (documents.length === 0) {
    // 这一层有子文件夹时不说"这里还没有文档"：那会读成整个位置是空的
    return (
      <>
        {refreshProblem}
        {!hasFolders && <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{messages.documents.empty}</p>}
      </>
    )
  }
  return (
    <>
      {refreshProblem}
      <ul ref={listRef} aria-label={messages.documents.listLabel} className="divide-y rounded-lg border">
        {documents.map(document => (
          <DocumentRow
            key={document.id}
            documentId={document.id}
            title={document.title}
            details={(
              <>
                {messages.documents.typeName(document.type)}
                {' · '}
                <time dateTime={document.updatedAt}>{messages.documents.updatedAt(formatDateTime(document.updatedAt))}</time>
              </>
            )}
            spaceId={spaceId}
            targetSpaces={targetSpaces}
            open={openId === document.id}
            openTriggerRef={openTriggerRef}
            onToggle={() => onToggle(document.id)}
            onDone={onDone}
            onDenied={onDenied}
          />
        ))}
      </ul>
      {query.isFetchNextPageError && (
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
