import type { DocumentSummary, SpaceView } from '@nerve-office/contracts'
import type { RefObject } from 'react'
import type { OrganizeNotice } from './item-actions.tsx'
import { documentPagePath, documentTitleSchema } from '@nerve-office/contracts'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { FileSpreadsheet } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import { describeError, isDefiniteRejection } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { Alert, AlertDescription, Button, buttonVariants, Skeleton } from '../../shared/ui/index.ts'
import { copyDocument, deleteDocument, documentQueryOptions, folderDocumentsQueryOptions, moveDocument, updateDocument } from './documents-api.ts'
import { ItemActions } from './item-actions.tsx'
import { useOrganizeRefresh } from './organize-refresh.ts'

const organize = messages.organize

function validTitle(value: string): boolean {
  return documentTitleSchema.safeParse(value).success
}

interface DocumentItemProps {
  readonly document: DocumentSummary
  readonly targetSpaces: readonly SpaceView[]
  readonly open: boolean
  /** 记下被点的那个"操作"按钮：面板收起之后空间页把焦点还给它 */
  readonly openTriggerRef: RefObject<HTMLButtonElement | null>
  readonly onToggle: () => void
  readonly onDone: (notice: OrganizeNotice | undefined) => void
  readonly onDenied: () => void
}

/**
 * 列表里的一份文档：标题是打开编辑器页的链接，右边是"操作 <标题>"。
 * 列表的条目只有摘要（契约里没有权限位），所以展开操作时才按 id 取一次元数据：能做哪些操作一律以服务端给的 permissions 为准，
 * 顺带也拿到它现在所在的文件夹（移动与复制要用）。
 */
function DocumentItem({ document, targetSpaces, open, openTriggerRef, onToggle, onDone, onDenied }: DocumentItemProps) {
  const refresh = useOrganizeRefresh()
  const panelId = useId()
  const detail = useQuery({ ...documentQueryOptions(document.id), enabled: open })
  // 正在进行的这一次复制的 requestId 与它的目标位置（契约承诺同一个 requestId 只复制一份，新建表格也是同一个范式）：
  // 结果未知（网络错误、5xx）之后再点，沿用同一个，服务端不会建出第二份副本；确定失败（4xx）与做完之后换新的。
  // 换了目标位置也换新的：沿用旧的会让重试落回旧目标（M2-P4 审查 B1）
  const copyRequestRef = useRef<{ readonly target: string, readonly requestId: string }>(undefined)

  return (
    <li>
      <div className="flex items-center gap-3 px-4 py-3">
        {/* 编辑器页是另一个入口：普通的链接，整页打开（P4 设计 §3.7.4） */}
        <a href={documentPagePath(document.id)} className="flex min-w-0 flex-1 items-center gap-3 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={organize.actionsOn(document.title)}
          onClick={(event) => {
            openTriggerRef.current = event.currentTarget
            onToggle()
          }}
        >
          {organize.actions}
        </Button>
      </div>
      {open && (
        <ItemActions
          panelId={panelId}
          name={document.title}
          validateName={validTitle}
          permissions={detail.data?.permissions}
          loading={detail.isPending}
          error={detail.error}
          onRetry={() => void detail.refetch()}
          current={{ spaceId: detail.data?.spaceId ?? '', folderId: detail.data?.folderId ?? undefined }}
          targetSpaces={targetSpaces}
          operations={{
            rename: async (title) => {
              const renamed = await updateDocument(document.id, { title })
              await refresh([renamed.spaceId])
            },
            move: async (destination) => {
              const moved = await moveDocument(document.id, { spaceId: destination.spaceId, ...(destination.folderId === undefined ? {} : { folderId: destination.folderId }) })
              await refresh([detail.data?.spaceId ?? destination.spaceId, moved.spaceId])
            },
            copy: async (destination) => {
              const target = `${destination.spaceId}/${destination.folderId ?? ''}`
              if (copyRequestRef.current?.target !== target)
                copyRequestRef.current = { target, requestId: crypto.randomUUID() }
              try {
                const copy = await copyDocument(document.id, { spaceId: destination.spaceId, requestId: copyRequestRef.current.requestId, ...(destination.folderId === undefined ? {} : { folderId: destination.folderId }) })
                // 这一次复制做完了：再复制一次是另一件事，要换一个新的 requestId，否则服务端会把那一次当成重试
                copyRequestRef.current = undefined
                await refresh([copy.spaceId])
                return {
                  message: organize.copied(copy.title),
                  action: <a href={documentPagePath(copy.id)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{organize.openCopy}</a>,
                }
              }
              catch (error) {
                // 确定被拒绝（4xx）才换 requestId：结果未知时沿用同一个，再点不会复制出第二份
                if (isDefiniteRejection(error))
                  copyRequestRef.current = undefined
                throw error
              }
            },
            remove: async () => {
              await deleteDocument(document.id)
              await refresh([detail.data?.spaceId ?? ''])
            },
          }}
          onDone={onDone}
          onDenied={onDenied}
          onClose={onToggle}
        />
      )}
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

interface DocumentListProps {
  readonly spaceId: string
  /** 当前所在的文件夹；null 表示空间的根目录（M2-P4） */
  readonly folderId: string | null
  /** 我能新建内容的空间：移动与复制的目标候选 */
  readonly targetSpaces: readonly SpaceView[]
  /** 当前展开操作面板的那一个（整页只有一个） */
  readonly openId: string | undefined
  /** 记下被点的那个"操作"按钮：面板收起之后空间页把焦点还给它 */
  readonly openTriggerRef: RefObject<HTMLButtonElement | null>
  readonly onToggle: (id: string) => void
  readonly onDone: (notice: OrganizeNotice | undefined) => void
  readonly onDenied: () => void
  /** 这一层还有没有子文件夹：都没有时"这里还没有文档"才是整块空的说明 */
  readonly hasFolders: boolean
}

/**
 * 一个空间里某个文件夹下的文档列表（US-M1-03，M2-P2 设计 §3.10，M2-P4 按目录过滤）。
 * 加载中、空列表、加载失败都有明确的显示；分页用"加载更多"。标题与新建在空间页的页头，子文件夹排在这个列表前面。
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
  if (documents.length === 0) {
    // 这一层有子文件夹时不说"这里还没有文档"：那会读成整个位置是空的
    return hasFolders ? null : <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{messages.documents.empty}</p>
  }
  return (
    <>
      <ul ref={listRef} aria-label={messages.documents.listLabel} className="divide-y rounded-lg border">
        {documents.map(document => (
          <DocumentItem
            key={document.id}
            document={document}
            targetSpaces={targetSpaces}
            open={openId === document.id}
            openTriggerRef={openTriggerRef}
            onToggle={() => onToggle(document.id)}
            onDone={onDone}
            onDenied={onDenied}
          />
        ))}
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
