import type { SpacePermissions, SpaceView } from '@nerve-office/contracts'
import type { RefObject } from 'react'
import { spaceNameSchema } from '@nerve-office/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { describeError, isAccessDenied, isMissingResource } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { spaceMembersPath } from '../../shared/lib/space-paths.ts'
import { useFocusAfterRender } from '../../shared/lib/use-focus-after-render.ts'
import { Alert, AlertDescription, Badge, Button, buttonVariants, Input, Label, Skeleton } from '../../shared/ui/index.ts'
import { sessionQueryOptions } from '../auth/index.ts'
import { DocumentList, NewSheetButton } from '../documents/index.ts'
import { useForgetMissingSpace } from './missing-space.ts'
import { SpaceNotFound } from './space-not-found.tsx'
import { renameSpace, spaceQueryOptions, SPACES_QUERY_KEY } from './spaces-api.ts'

const text = messages.spaces

interface RenameFormProps {
  readonly space: SpaceView
  readonly onDone: () => void
  /** 改名按访问权限被拒绝（403、404）：由页头重新请求自己；原因仍在表单里说明 */
  readonly onDenied: () => void
}

/** 行内改名（不用弹窗，不进首屏的 Radix Dialog）：保存之后导航与页头随即是新名称 */
function RenameForm({ space, onDone, onDenied }: RenameFormProps) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(space.name)
  const inputId = useId()
  const mutation = useMutation({
    mutationFn: async (value: string) => renameSpace(space.id, value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SPACES_QUERY_KEY })
      onDone()
    },
    onError: (error) => {
      if (isAccessDenied(error))
        onDenied()
    },
  })
  const parsed = spaceNameSchema.safeParse(name)

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (parsed.success && !mutation.isPending)
          mutation.mutate(parsed.data)
      }}
    >
      <div className="flex min-w-48 flex-1 flex-col gap-2">
        <Label htmlFor={inputId}>{text.renameLabel}</Label>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- 点了改名才出现的输入框：焦点直接给它，不落到 body */}
        <Input id={inputId} value={name} autoFocus aria-invalid={!parsed.success} onChange={event => setName(event.target.value)} />
      </div>
      <Button type="submit" aria-disabled={mutation.isPending || !parsed.success}>{mutation.isPending ? text.saving : text.save}</Button>
      <Button type="button" variant="ghost" aria-disabled={mutation.isPending} onClick={() => !mutation.isPending && onDone()}>{text.cancel}</Button>
      {mutation.isError && (
        <Alert variant="destructive" className="basis-full">
          <AlertDescription>{describeError(mutation.error).message}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}

/**
 * 页头按新的权限重新显示时（页内的操作被拒绝之后重新请求了页头），有焦点的按钮可能随之消失，例如空间刚被归档，"新建表格"没了：
 * 焦点交给标题，不落到 body（M2-P2 复验）。只看权限变了的那一次渲染：打开页面时不动焦点。
 * 权限没变时 TanStack Query 的结构共享保留原来的对象，按引用比较即可
 */
function useFocusTitleAfterPermissionChange(permissions: SpacePermissions, titleRef: RefObject<HTMLElement | null>): void {
  const shownRef = useRef(permissions)
  useEffect(() => {
    if (shownRef.current === permissions)
      return
    shownRef.current = permissions
    if (document.activeElement === null || document.activeElement === document.body)
      titleRef.current?.focus()
  }, [permissions, titleRef])
}

/** 页头：名称（个人空间显示"我的空间"）、类型与状态、我的角色；只显示能做的操作（新建表格、成员、改名） */
function SpaceHeader({ space }: { readonly space: SpaceView }) {
  const queryClient = useQueryClient()
  const [renaming, setRenaming] = useState(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const renameRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useFocusAfterRender()
  const personal = space.type === 'personal'
  useFocusTitleAfterPermissionChange(space.permissions, titleRef)

  /**
   * 页内的操作（新建表格、改名）按访问权限被拒绝：页头显示的权限已经过时，重新请求（M2-P2 复验），连同导航（归档的标记）。
   * 空间看不到了（404）时由空间页说明"空间不存在"（useForgetMissingSpace 另外刷新导航、去掉这个空间的缓存）
   */
  function refreshAfterDenied(): void {
    void queryClient.invalidateQueries({ queryKey: SPACES_QUERY_KEY })
  }

  function doneRenaming(): void {
    setRenaming(false)
    // 改名被拒绝之后页头按新的权限重新显示，"改名"可能已经没了（例如空间刚被归档）：焦点交给标题
    focusAfterRender(space.permissions.canRename ? renameRef : titleRef)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          {/* tabIndex -1：只能由程序聚焦（按钮随新的权限消失之后），Tab 键不经过它 */}
          <h1 ref={titleRef} id="space-title" tabIndex={-1} className="truncate text-xl font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">{personal ? messages.documents.title : space.name}</h1>
          {!personal && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="outline">{text.typeName(space.type)}</Badge>
              {space.visibleToAll && <Badge variant="outline">{text.visibleToAll}</Badge>}
              {space.status === 'archived' && <Badge variant="secondary">{text.archived}</Badge>}
              <span>{text.myRole(space.role)}</span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {space.permissions.canViewMembers && (
            <Link to={spaceMembersPath(space.id)} className={buttonVariants({ variant: 'outline' })}>{text.members}</Link>
          )}
          {space.permissions.canRename && !renaming && (
            <Button ref={renameRef} variant="outline" onClick={() => setRenaming(true)}>{text.rename}</Button>
          )}
          {space.permissions.canCreateDocuments && <NewSheetButton spaceId={space.id} onDenied={refreshAfterDenied} />}
        </div>
      </div>
      {renaming && <RenameForm space={space} onDone={doneRenaming} onDenied={refreshAfterDenied} />}
      {space.status === 'archived' && (
        <Alert>
          <AlertDescription>{text.archivedNotice}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

/**
 * 空间页的内容（M2-P2 设计 §3.10）：页头与文档列表；加载中、看不到（与不存在一致）、加载失败（可以重试）。
 * 先看错误、再看数据：重新请求失败时 TanStack Query 保留上一次的数据。已打开的页面里被移出了空间，再进来时缓存里还有旧的页头，
 * 重新请求得到 404 就按看不到显示，不再显示旧的页头与文档（审查 B1）；导航与这个空间的缓存随之更新。
 * 页内的新建与改名被拒绝之后页头重新请求，同样按这里的状态显示（复验）。
 */
function SpaceContent({ spaceId }: { readonly spaceId: string }) {
  const space = useQuery(spaceQueryOptions(spaceId))
  const missing = isMissingResource(space.error)
  useForgetMissingSpace(spaceId, missing)
  if (space.isPending) {
    return (
      <div role="status" aria-label={text.loading} className="flex flex-col gap-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }
  if (missing)
    return <SpaceNotFound />
  if (space.data === undefined) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>{text.pageLoadFailed}</p>
          <p>{describeError(space.error).message}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void space.refetch()}>{messages.common.retry}</Button>
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <section className="flex flex-col gap-4" aria-labelledby="space-title">
      <SpaceHeader space={space.data} />
      <DocumentList spaceId={space.data.id} />
    </section>
  )
}

/** 首页：本人的个人空间（"我的空间"，US-M1-03 的地址不变）。会话由外层的 RequireSession 加载好了 */
export function HomePage() {
  const session = useQuery(sessionQueryOptions())
  const personal = session.data?.personalSpace
  return personal === undefined ? null : <SpaceContent key={personal.id} spaceId={personal.id} />
}

/** 任意空间：/spaces/{id}（M2-P2 设计 §3.10）。换了空间就重新开始（输入框、改名的状态不带到别的空间） */
export function SpacePage() {
  const { spaceId = '' } = useParams()
  return <SpaceContent key={spaceId} spaceId={spaceId} />
}
