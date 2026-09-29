import type { SpaceView, TrashEntry } from '@nerve-office/contracts'
import type { RefObject } from 'react'
import type { PendingConfirmation } from '../confirmation/index.ts'
import { TRASH_RETENTION_DAYS } from '@nerve-office/contracts'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { describeError, isMissingResource } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { spacePath } from '../../shared/lib/space-paths.ts'
import { Alert, AlertDescription, Badge, Button, buttonVariants, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../shared/ui/index.ts'
import { ConfirmDialog } from '../confirmation/index.ts'
import { spaceDocumentsQueryKey, spaceFoldersQueryKey } from '../documents/index.ts'
import { SpaceNotFound, spaceQueryOptions, useForgetMissingSpace } from '../spaces/index.ts'
import { purgeTrashEntry, restoreTrashEntry, spaceTrashQueryKey, spaceTrashQueryOptions } from './trash-api.ts'

const text = messages.trash

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
  const who = entry.deletedBy === null ? text.unknownUser : messages.colleagues.name(entry.deletedBy)
  return (
    <TableRow aria-busy={restoring}>
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
      <TableCell className="text-sm">{text.deletedBy(who, formatDateTime(entry.deletedAt))}</TableCell>
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

/** 做完一件事之后的说明：那一行随之消失，说明接住焦点，不落到 body */
function Notice({ message }: { readonly message: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [message])
  return (
    <Alert ref={ref} tabIndex={-1}>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

/**
 * 回收站的列表本体：加载中、加载失败、空列表，以及每一条的恢复与永久删除。
 * headingRef 是页面标题（h1）：确认的弹窗关掉之后，打开它的那一行已经不在，焦点交给标题。
 * 这里不再另起一个同名的 sr-only 标题——读屏按标题导航会把同一句读两遍（M2-P4 审查建议 8）
 */
function TrashList({ space, headingRef }: { readonly space: SpaceView, readonly headingRef: RefObject<HTMLHeadingElement | null> }) {
  const queryClient = useQueryClient()
  const query = useInfiniteQuery(spaceTrashQueryOptions(space.id))
  const entries = query.data?.pages.flatMap(page => page.items) ?? []
  const [notice, setNotice] = useState<string>()
  const [confirming, setConfirming] = useState<PendingConfirmation>()

  /** 恢复与永久删除都会改变空间里的内容：回收站、各层的文件夹与文档一起重新请求 */
  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: spaceTrashQueryKey(space.id) }),
      queryClient.invalidateQueries({ queryKey: spaceFoldersQueryKey(space.id) }),
      queryClient.invalidateQueries({ queryKey: spaceDocumentsQueryKey(space.id) }),
    ])
  }

  const restore = useMutation({
    mutationFn: async (entry: TrashEntry) => ({ entry, result: await restoreTrashEntry(entry.id) }),
    onSuccess: async ({ entry, result }) => {
      await refresh()
      // 原来的位置已经不在（被永久删除、自己也在回收站里、跨空间移动过）：明确告诉用户它回到了空间的根目录
      setNotice(result.movedToRoot ? text.restoredToRoot(entry.title) : text.restored(entry.title))
    },
    onError: async (error) => {
      // 别人已经恢复或永久删除了它：列表刷新之后说明一句，不留下一条点不动的行
      if (isMissingResource(error)) {
        await refresh()
        setNotice(text.gone)
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
          if (!isMissingResource(error))
            throw error
          gone = true
        }
        await refresh()
        setNotice(gone ? text.gone : text.purged(entry.title))
      },
      // 确认之后这一行就没了，打开弹窗的按钮随之消失：焦点交给页面的标题
      returnFocus: () => headingRef.current?.focus(),
    })
  }

  if (query.isPending)
    return <Skeleton className="h-24 w-full" role="status" aria-label={text.loading} />
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
      {notice !== undefined && <Notice message={notice} />}
      {restore.isError && !isMissingResource(restore.error) && (
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
              <TableBody>
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
      {query.hasNextPage && (
        <Button variant="outline" className="self-center" aria-disabled={query.isFetchingNextPage} onClick={() => !query.isFetchingNextPage && void query.fetchNextPage()}>
          {query.isFetchingNextPage ? messages.common.loadingMore : messages.common.loadMore}
        </Button>
      )}
      <ConfirmDialog pending={confirming} onClose={() => setConfirming(undefined)} />
    </>
  )
}

function TrashContent({ spaceId }: { readonly spaceId: string }) {
  const space = useQuery(spaceQueryOptions(spaceId))
  const missing = isMissingResource(space.error)
  const titleRef = useRef<HTMLHeadingElement>(null)
  useForgetMissingSpace(spaceId, missing)
  if (space.isPending)
    return <Skeleton className="h-24 w-full" role="status" aria-label={text.loading} />
  if (missing)
    return <SpaceNotFound />
  if (space.data === undefined) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>{text.loadFailed}</p>
          <p>{describeError(space.error).message}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void space.refetch()}>{messages.common.retry}</Button>
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <section className="flex flex-col gap-4" aria-labelledby="trash-title">
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
      <TrashList space={space.data} headingRef={titleRef} />
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
