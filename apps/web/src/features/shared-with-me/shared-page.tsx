import type { SharedDocument } from '@nerve-office/contracts'
import type { RefObject } from 'react'
import type { GoneTexts } from '../documents/index.ts'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { describeError } from '../../shared/api/index.ts'
import { SHARED_LIST_QUERY_KEY } from '../../shared/api/shared-list-key.ts'
import { refreshWithin } from '../../shared/api/write-outcome.ts'
import { messages } from '../../shared/i18n/index.ts'
import { sharedWithMeMessages } from '../../shared/i18n/zh-cn/shared-with-me.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { refreshQueries } from '../../shared/lib/refresh-queries.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { useFirstLoadRetry } from '../../shared/lib/use-first-load-retry.ts'
import { useFocusRescue } from '../../shared/lib/use-focus-rescue.ts'
import { Alert, AlertDescription, Button, RetryButton, Skeleton } from '../../shared/ui/index.ts'
import { RefreshProblem } from '../../shared/ui/refresh-problem.tsx'
import { SpaceLabel } from '../../shared/ui/space-label.tsx'
import { sessionQueryOptions } from '../auth/index.ts'
import { DocumentRow, OrganizeNoticeBar, targetSpacesOf, useOrganizePanels, useOrganizeRefreshChecked } from '../documents/index.ts'
import { SPACES_QUERY_KEY, spacesQueryOptions } from '../spaces/index.ts'
import { sharedListQueryOptions } from './shared-api.ts'

const text = sharedWithMeMessages

/** 行内操作得到 404 时的说法：在这一页，它还可能是分享被取消了 */
const SHARED_GONE_TEXTS: GoneTexts = { gone: text.gone, targetOrItemGone: text.targetOrItemGone }

/**
 * 一条的标题下面：所属的空间（团队空间的名称；个人空间按所有者的人名呈现）、我能不能编辑与更新时间。
 * 不显示所在位置：只凭授权的人看不到空间的目录结构（00 号计划书 §5.5），契约里也不给文件夹
 */
function SharedDetails({ document, viewerId }: { readonly document: SharedDocument, readonly viewerId: string | undefined }) {
  return (
    <>
      <SpaceLabel space={document.space} viewerId={viewerId} />
      {' · '}
      {document.contentRole === 'viewer' ? text.readOnly : text.canEdit}
      {' · '}
      <time dateTime={document.updatedAt}>{messages.documents.updatedAt(formatDateTime(document.updatedAt))}</time>
    </>
  )
}

/**
 * 列表：加载中、加载失败（可以重试）、一份也没有、逐页加载；留着之前的列表、刷新却失败了时明说、给出重试（Codex 对抗评审 CX5）。
 * 每一条与空间的文档列表同一个"操作"（features/documents 的 DocumentRow，Codex 对抗评审 CX3）：展开时取这份文档的详情，
 * 按服务端给的权限只列出能做的——只凭单独授权时，编辑者能改名，能读就能复制，没有移动、删除与分享。
 * 复制的目标是自己能新建的空间（与空间页同一个候选），源空间不在其中，不显示它的目录结构；改名之后连同这一页一起刷新，
 * 复制之后刷新目标空间的列表。说明、焦点与刷新的做法与空间页相同（organize-panels.tsx）。
 * 第一页就没取到时按"重试"：重试期间说明与按钮留着（不可用、说正在重试）；取到之后焦点交给页面的标题，不落到 body
 * （规范 §2.4，shared/lib/use-first-load-retry.ts）
 */
function SharedList({ titleRef }: { readonly titleRef: RefObject<HTMLHeadingElement | null> }) {
  const queryClient = useQueryClient()
  const query = useInfiniteQuery(sharedListQueryOptions())
  const firstLoad = useFirstLoadRetry(query, titleRef)
  const session = useQuery(sessionQueryOptions())
  // 导航已经请求过"我能看到的空间"：复制的目标候选直接用它（服务端给的 canCreateDocuments），共用同一份缓存，
  // 连同取到了没有：还没取到、取不到时复制的目标说明加载中、没能加载（可以重试），不回落到看不到的源空间（M2 Codex 评审复验的一般 1）；
  // refetchOnMount 关掉的理由与空间页相同（features/spaces/space-page.tsx）
  const spaces = useQuery({ ...spacesQueryOptions(), refetchOnMount: false })
  const visibleSpaces = spaces.data?.items ?? []
  const targetSpaces = targetSpacesOf(spaces)
  const panels = useOrganizePanels(titleRef)
  const refreshChecked = useOrganizeRefreshChecked()
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

  /**
   * 行内的操作按访问权限被拒绝（403、404：例如分享刚被取消、文档刚被删除）：这一页显示的已经过时，重新请求"与我共享"与文档详情；
   * 兑现为列表刷新好了没有（最多等 10 秒，说明据此说"列表已刷新"还是"没能刷新"）。导航（复制的目标候选）照常刷新、不计入
   */
  async function refreshAfterDenied(): Promise<boolean> {
    void refreshQueries(queryClient, [SPACES_QUERY_KEY], { throwOnError: false })
    return refreshWithin(async () => refreshChecked([], [SHARED_LIST_QUERY_KEY]))
  }

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
    // 骨架屏本身不带 role：状态写在包住它的容器上（M2-P6 复核 S4）
    return (
      <div role="status" aria-label={text.loading} className="flex flex-col gap-3">
        {['first', 'second', 'third'].map(row => <Skeleton key={row} className="h-12 w-full" />)}
      </div>
    )
  }
  return (
    <>
      {/* 列表上方的说明（做完了、没能完成）：那一行常常随之消失（例如分享被取消之后），说明不挂在行里 */}
      {panels.notice !== undefined && <OrganizeNoticeBar notice={panels.notice} onClose={panels.closeNotice} />}
      <RefreshProblem query={query} list={text.listName} />
      {documents.length === 0
        ? <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{text.empty}</p>
        : (
            <ul ref={listRef} aria-label={text.listLabel} className="divide-y rounded-lg border">
              {documents.map(document => (
                <DocumentRow
                  key={document.id}
                  documentId={document.id}
                  title={document.title}
                  details={<SharedDetails document={document} viewerId={session.data?.user.id} />}
                  spaceId={document.space.id}
                  targetSpaces={targetSpaces}
                  open={panels.open?.kind === 'document' && panels.open.id === document.id}
                  openTriggerRef={panels.openTriggerRef}
                  onToggle={() => panels.toggle('document', document.id)}
                  onDone={panels.finish}
                  onDenied={refreshAfterDenied}
                  listedIn={SHARED_LIST_QUERY_KEY}
                  // 看不到它所在空间的人（只凭单独授权）进不去那个空间的回收站：说明里不给"打开回收站"
                  trashReachable={visibleSpaces.some(space => space.id === document.space.id)}
                  goneTexts={SHARED_GONE_TEXTS}
                />
              ))}
            </ul>
          )}
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
  )
}

/**
 * "与我共享"（M2-P5 设计 §3.5，US-M2-10）：别人单独分享给我的全部文档（不论我在那个空间里有没有角色），按更新时间从新到旧。
 * 每条显示文档与所属的空间，不显示所在位置；每条有"操作"（复制、改名，按权限，Codex 对抗评审 CX3，US-M2-08）。
 * 页面里有焦点的按钮、行随刷新消失时（例如分享刚被取消），焦点交给页面的标题（M2-P6 复核 S3，shared/lib/use-focus-rescue.ts）。
 * 路由级按需加载，不进平台页面的首屏
 */
export function SharedWithMePage() {
  useDocumentTitle(messages.spaces.sharedWithMe)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const rescueFocus = useFocusRescue(titleRef)
  return (
    <section ref={rescueFocus} className="flex flex-col gap-4" aria-labelledby="shared-title">
      {/* tabIndex -1：只能由程序聚焦（那一行随操作或刷新消失之后），Tab 键不经过它 */}
      <h1 ref={titleRef} id="shared-title" tabIndex={-1} className="text-xl font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">{messages.spaces.sharedWithMe}</h1>
      <p className="text-sm text-muted-foreground">{text.description}</p>
      <SharedList titleRef={titleRef} />
    </section>
  )
}
