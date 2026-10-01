import type { SpaceView, TrashEntry, TrashListResponse } from '@nerve-office/contracts'
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query'
import type { RefObject } from 'react'
import type { PendingConfirmation } from '../confirmation/index.ts'
import { TRASH_RETENTION_DAYS } from '@nerve-office/contracts'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { describeError, isAccessDenied, isMissingResource, isUnknownOutcome } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { trashMessages } from '../../shared/i18n/zh-cn/trash.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { refreshQueries } from '../../shared/lib/refresh-queries.ts'
import { spacePath } from '../../shared/lib/space-paths.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { useFocusRescue } from '../../shared/lib/use-focus-rescue.ts'
import { Alert, AlertDescription, Badge, Button, buttonVariants, Notice, PersonName, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../shared/ui/index.ts'
import { ConfirmDialog } from '../confirmation/index.ts'
import { spaceDocumentsQueryKey, spaceFoldersQueryKey } from '../documents/index.ts'
import { SpaceNotFound, spaceQueryOptions, SPACES_QUERY_KEY, useForgetMissingSpace } from '../spaces/index.ts'
import { purgeTrashEntry, restoreTrashEntry, spaceTrashQueryKey, spaceTrashQueryOptions } from './trash-api.ts'

const text = trashMessages

function spaceName(space: SpaceView): string {
  return space.type === 'personal' ? messages.documents.title : space.name
}

/** 被删的那一个对象当时在哪里（子孙跟着父辈，不单独记）：原位置不在时说明恢复会回到空间的根目录 */
function originOf(entry: TrashEntry): string {
  if (!entry.origin.available)
    return text.originGone
  return entry.origin.parentName === null ? text.originRoot : text.originIn(entry.origin.parentName)
}

interface EntryRowProps {
  readonly entry: TrashEntry
  readonly onRestore: () => void
  readonly onPurge: () => void
  readonly restoring: boolean
}

/** 回收站里的一个删除单元：种类与名称、谁在什么时候删的、原位置、到期时间、里面有多少份文档，以及我能做的操作 */
function EntryRow({ entry, onRestore, onPurge, restoring }: EntryRowProps) {
  return (
    // tabIndex -1：只能由程序聚焦（加载更多之后焦点移到第一条新行），Tab 键不经过整行
    <TableRow aria-busy={restoring} tabIndex={-1} className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      <TableCell>
        <div className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{text.kindName(entry.kind)}</Badge>
            <span className="font-medium">{entry.title}</span>
          </span>
          {/* 一份文档的单元就是 1 份，文件夹的单元是整棵子树里的份数（P4-S3 spec §6） */}
          <span className="text-xs text-muted-foreground">{text.documentCount(entry.documentCount)}</span>
        </div>
      </TableCell>
      {/* 删除者与时间分两行：删除者的显示名可能是从右到左的文字，与时间拼在一行会被打乱（M2-P6 复核 M2） */}
      <TableCell className="text-sm">
        <div className="flex flex-col gap-0.5">
          {entry.deletedBy === null ? <span>{text.unknownUser}</span> : <PersonName person={entry.deletedBy} />}
          <time dateTime={entry.deletedAt} className="text-xs text-muted-foreground">{formatDateTime(entry.deletedAt)}</time>
        </div>
      </TableCell>
      <TableCell className="text-sm">{originOf(entry)}</TableCell>
      <TableCell className="text-sm">
        <time dateTime={entry.expiresAt}>{formatDateTime(entry.expiresAt)}</time>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-2">
          {entry.permissions.canRestore && (
            <Button variant="outline" size="sm" aria-disabled={restoring} aria-label={`${text.restore} ${entry.title}`} onClick={onRestore}>
              {restoring ? text.restoring : text.restore}
            </Button>
          )}
          {entry.permissions.canPurge && (
            <Button variant="ghost" size="sm" aria-label={`${text.purge} ${entry.title}`} onClick={onPurge}>{text.purge}</Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

/** 表格上方的说明：每次一条新的对象（换了一条就再接一次焦点） */
interface TrashNotice {
  readonly message: string
  readonly problem?: boolean
}

type TrashQuery = UseInfiniteQueryResult<InfiniteData<TrashListResponse>>

/**
 * 回收站的列表本体：加载中、加载失败、空列表，以及每一条的恢复与永久删除。
 * headingRef 是页面标题（h1）：确认的弹窗关掉之后，打开它的那一行已经不在，焦点交给标题。
 * 这里不再另起一个同名的 sr-only 标题——读屏按标题导航会把同一句读两遍（M2-P4 审查建议 8）
 *
 * 没能完成时（M2-P6 复核 S1、S2）：
 * - 按访问权限被拒绝（403：空间刚被归档；404：这一条已经不在了，或者整个空间看不到了）：回收站、空间的页头与内容一起重新请求，
 *   "恢复"随新的权限消失；说明接住焦点（403 用服务端说的原因）。空间看不到了时页面换成"空间不存在"，不说"列表已刷新"；
 * - 结果未知：同样刷新，说明它可能已经恢复了。
 */
function TrashList({ space, query, headingRef }: { readonly space: SpaceView, readonly query: TrashQuery, readonly headingRef: RefObject<HTMLHeadingElement | null> }) {
  const queryClient = useQueryClient()
  const entries = query.data?.pages.flatMap(page => page.items) ?? []
  const [notice, setNotice] = useState<TrashNotice>()
  const [confirming, setConfirming] = useState<PendingConfirmation>()
  // 加载更多时已有的条数：新的一页到了之后，焦点移到第一条新行。按钮在最后一页之后随之消失，焦点不能留在它身上（M1 审查 B13 的做法，P13）
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  const focusFromRef = useRef<number>(undefined)
  useEffect(() => {
    const from = focusFromRef.current
    if (from === undefined || entries.length <= from)
      return
    focusFromRef.current = undefined
    bodyRef.current?.rows.item(from)?.focus()
  }, [entries.length])

  /** 恢复与永久删除会改变的内容：回收站、各层的文件夹与文档 */
  const contentKeys = [spaceTrashQueryKey(space.id), spaceFoldersQueryKey(space.id), spaceDocumentsQueryKey(space.id)]

  /** 恢复与永久删除都会改变空间里的内容：回收站、各层的文件夹与文档一起重新请求；被拒绝时页头（权限、归档）与导航也一起 */
  async function refresh(withSpace = false): Promise<void> {
    await Promise.all([...contentKeys, ...(withSpace ? [SPACES_QUERY_KEY] : [])].map(async queryKey => queryClient.invalidateQueries({ queryKey })))
  }

  /** 确认的弹窗在结果未知之后的刷新：刷新失败时拒绝，弹窗据此说明页面没能刷新（M2-P6 复核第三批 G-a） */
  async function refreshAfterUnknown(): Promise<void> {
    await refreshQueries(queryClient, contentKeys)
  }

  /** 回收站刷新出来了：看不到这个空间时它会失败，页面换成"空间不存在"，这时不说"列表已刷新" */
  function listRefreshed(): boolean {
    return queryClient.getQueryState(spaceTrashQueryKey(space.id))?.status === 'success'
  }

  const restore = useMutation({
    mutationFn: async (entry: TrashEntry) => ({ entry, result: await restoreTrashEntry(entry.id) }),
    onSuccess: async ({ entry, result }) => {
      await refresh()
      // 原来的位置已经不在（被永久删除、自己也在回收站里、跨空间移动过）：明确告诉用户它回到了空间的根目录
      setNotice({ message: result.movedToRoot ? text.restoredToRoot(entry.title) : text.restored(entry.title) })
    },
    onError: async (error, entry) => {
      if (isAccessDenied(error)) {
        await refresh(true)
        // 别人已经恢复或永久删除了它（404）：说明一句，不留下一条点不动的行；空间刚被归档（403）：用服务端说的原因
        if (isMissingResource(error)) {
          if (listRefreshed())
            setNotice({ message: text.gone })
        }
        else {
          setNotice({ message: text.denied(entry.title, describeError(error).message), problem: true })
        }
        return
      }
      if (isUnknownOutcome(error)) {
        await refresh()
        setNotice({ message: text.restoreOutcomeUnknown(entry.title, describeError(error).message), problem: true })
      }
    },
  })

  function confirmPurge(entry: TrashEntry): void {
    setConfirming({
      title: text.confirmPurge(entry.title),
      description: text.purgeDescription,
      confirmLabel: text.purge,
      destructive: true,
      run: async () => {
        // 别人已经恢复或永久删除了它：目的已经达到，按“已经不在回收站里”说明，不当成失败
        let gone = false
        try {
          await purgeTrashEntry(entry.id)
        }
        catch (error) {
          if (!isMissingResource(error)) {
            // 被拒绝（403）：列表与页头按新的权限刷新，弹窗留着说明原因（关掉之后"永久删除"可能已经不在了）。
            // 结果未知由确认的弹窗按 refresh 刷新、说明可能已经删除（M2-P6 复核第二批 G-2）
            if (isAccessDenied(error))
              await refresh(true)
            throw error
          }
          gone = true
        }
        await refresh()
        setNotice({ message: gone ? text.gone : text.purged(entry.title) })
      },
      refresh: refreshAfterUnknown,
      // 确认之后这一行就没了，打开弹窗的按钮随之消失：焦点交给页面的标题
      returnFocus: () => headingRef.current?.focus(),
    })
  }

  function loadMore(): void {
    if (query.isFetchingNextPage)
      return
    focusFromRef.current = entries.length
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

  return (
    <>
      {notice !== undefined && <Notice focusKey={notice} variant={notice.problem === true ? 'destructive' : 'default'}>{notice.message}</Notice>}
      {restore.isError && !isAccessDenied(restore.error) && !isUnknownOutcome(restore.error) && (
        <Alert variant="destructive">
          <AlertDescription>{describeError(restore.error).message}</AlertDescription>
        </Alert>
      )}
      {entries.length === 0
        ? <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{text.empty}</p>
        : (
            <Table aria-label={text.listLabel}>
              <TableHeader>
                <TableRow>
                  <TableHead>{text.columns.name}</TableHead>
                  <TableHead>{text.columns.deletedBy}</TableHead>
                  <TableHead>{text.columns.origin}</TableHead>
                  <TableHead>{text.columns.expiresAt}</TableHead>
                  <TableHead>{text.columns.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody ref={bodyRef}>
                {entries.map(entry => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    restoring={restore.isPending && restore.variables?.id === entry.id}
                    onRestore={() => !restore.isPending && restore.mutate(entry)}
                    onPurge={() => confirmPurge(entry)}
                  />
                ))}
              </TableBody>
            </Table>
          )}
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
      <ConfirmDialog pending={confirming} onClose={() => setConfirming(undefined)} />
    </>
  )
}

/**
 * 回收站页的内容：空间（页头的名称）与回收站的列表。先看错误、再看数据（ADR-008 的请求缓存约定）：两者任何一个得到 404，
 * 这个空间就看不到了，按"空间不存在"显示，不留着旧的行（M2-P6 复核 S2 的 P4）。两个请求谁先回来都一样：回收站先得到 404 时
 * 不等页头的请求（它可能还在路上，也可能拿着看不到之前的旧结果回来），直接说空间不存在（第二批 S-2 的 T1）。
 * 有焦点的按钮、行随刷新或新的权限消失时，焦点交给页面的标题（M2-P6 复核 S3）。
 */
function TrashContent({ spaceId }: { readonly spaceId: string }) {
  const space = useQuery(spaceQueryOptions(spaceId))
  const trash = useInfiniteQuery(spaceTrashQueryOptions(spaceId))
  const missing = isMissingResource(space.error) || isMissingResource(trash.error)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const rescueFocus = useFocusRescue(titleRef)
  useForgetMissingSpace(spaceId, missing)
  let title: string | undefined
  if (space.data !== undefined && !missing)
    title = text.heading(spaceName(space.data))
  else if (!space.isPending && !missing)
    title = text.loadFailed
  useDocumentTitle(title)
  if (missing)
    return <SpaceNotFound />
  if (space.isPending) {
    return (
      <div role="status" aria-label={text.loading}>
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }
  if (space.data === undefined) {
    return (
      <section className="flex flex-col gap-4" aria-labelledby="trash-title">
        <h1 id="trash-title" className="text-xl font-semibold">{text.loadFailed}</h1>
        <Alert variant="destructive">
          <AlertDescription>
            <p>{describeError(space.error).message}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void space.refetch()}>{messages.common.retry}</Button>
          </AlertDescription>
        </Alert>
      </section>
    )
  }
  return (
    <section ref={rescueFocus} className="flex flex-col gap-4" aria-labelledby="trash-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* tabIndex -1：只能由程序聚焦（确认的弹窗关掉之后，打开它的那一行已经不在），Tab 键不经过它 */}
        <h1 ref={titleRef} id="trash-title" tabIndex={-1} className="truncate text-xl font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">{text.heading(spaceName(space.data))}</h1>
        <Link to={spacePath(spaceId)} className={buttonVariants({ variant: 'outline' })}>{text.backToSpace}</Link>
      </div>
      <Alert>
        <AlertDescription>
          <p>{text.retention(TRASH_RETENTION_DAYS)}</p>
          <p>{text.readOnly}</p>
        </AlertDescription>
      </Alert>
      <TrashList space={space.data} query={trash} headingRef={titleRef} />
    </section>
  )
}

/**
 * 一个空间的回收站（M2-P4 设计 §3.7，规则细则见 specs/P4-S3-回收站的规则.md）：按空间列出删除单元，能恢复、能永久删除。
 * 按需加载：带着确认的弹窗（Radix Dialog），不进平台页面的首屏包（ADR-008）。
 * 看得到空间内容的人都看得到这个列表，能不能动它由每一条的 permissions 决定，界面不自己算。
 */
export function TrashPage() {
  const { spaceId = '' } = useParams()
  return <TrashContent key={spaceId} spaceId={spaceId} />
}
