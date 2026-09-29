import type { SpaceView } from '@nerve-office/contracts'
import { spaceNameSchema } from '@nerve-office/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { describeError, isMissingResource } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { spaceMembersPath } from '../../shared/lib/space-paths.ts'
import { useFocusAfterRender } from '../../shared/lib/use-focus-after-render.ts'
import { Alert, AlertDescription, Badge, Button, buttonVariants, Input, Label, Skeleton } from '../../shared/ui/index.ts'
import { sessionQueryOptions } from '../auth/index.ts'
import { DocumentList, NewSheetButton } from '../documents/index.ts'
import { useForgetMissingSpace } from './missing-space.ts'
import { renameSpace, spaceQueryOptions, SPACES_QUERY_KEY } from './spaces-api.ts'

const text = messages.spaces

/** 行内改名（不用弹窗，不进首屏的 Radix Dialog）：保存之后导航与页头随即是新名称 */
function RenameForm({ space, onDone }: { readonly space: SpaceView, readonly onDone: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(space.name)
  const inputId = useId()
  const mutation = useMutation({
    mutationFn: async (value: string) => renameSpace(space.id, value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SPACES_QUERY_KEY })
      onDone()
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

/** 页头：名称（个人空间显示"我的空间"）、类型与状态、我的角色；只显示能做的操作（新建表格、成员、改名） */
function SpaceHeader({ space }: { readonly space: SpaceView }) {
  const [renaming, setRenaming] = useState(false)
  const renameRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useFocusAfterRender()
  const personal = space.type === 'personal'

  function doneRenaming(): void {
    setRenaming(false)
    focusAfterRender(renameRef)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 id="space-title" className="truncate text-xl font-semibold">{personal ? messages.documents.title : space.name}</h1>
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
          {space.permissions.canCreateDocuments && <NewSheetButton spaceId={space.id} />}
        </div>
      </div>
      {renaming && <RenameForm space={space} onDone={doneRenaming} />}
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
  if (missing) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{text.notFound}</AlertDescription>
      </Alert>
    )
  }
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
