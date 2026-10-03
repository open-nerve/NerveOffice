import type { SpaceView } from '@nerve-office/contracts'
import type { RefObject } from 'react'
import type { ApiError } from '../../shared/api/index.ts'
import { spaceNameSchema } from '@nerve-office/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { describeError, isAccessDenied, isMissingResource } from '../../shared/api/index.ts'
import { refreshAfterSuccess, refreshWithin, writeFailureText } from '../../shared/api/write-outcome.ts'
import { messages } from '../../shared/i18n/index.ts'
import { refreshQueries } from '../../shared/lib/refresh-queries.ts'
import { folderIdsFromPath, spaceMembersPath } from '../../shared/lib/space-paths.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { useFocusAfterRender } from '../../shared/lib/use-focus-after-render.ts'
import { useFocusRescue } from '../../shared/lib/use-focus-rescue.ts'
import { useOutcomeRefresh } from '../../shared/lib/use-outcome-refresh.ts'
import { problemOf } from '../../shared/lib/validation.ts'
import { Alert, AlertDescription, Badge, Button, buttonVariants, FieldProblem, Input, Label, Notice, Skeleton } from '../../shared/ui/index.ts'
import { sessionQueryOptions } from '../auth/index.ts'
import { NewSheetButton, SpaceContents, targetSpacesOf, useOrganizeRefreshChecked } from '../documents/index.ts'
import { useForgetMissingSpace } from './missing-space.ts'
import { SpaceNotFound } from './space-not-found.tsx'
import { renameSpace, spaceQueryOptions, SPACES_QUERY_KEY, spacesQueryOptions } from './spaces-api.ts'

const text = messages.spaces

interface RenameFormProps {
  readonly space: SpaceView
  readonly onDone: () => void
  /** 改名按访问权限被拒绝（403、404）：表单关掉，由页头说明原因并重新请求自己 */
  readonly onDenied: (error: ApiError) => void
}

/**
 * 行内改名（不用弹窗，不进首屏的 Radix Dialog）：保存之后导航与页头随即是新名称；名称不合法时说明原因（M2-P6 复核 S4）。
 * 成功之后先按响应改页头与导航里的名称，再刷新（最多等到时限，Codex 对抗评审 CX4）：刷新一直不回来时表单照常关掉，名称已经是新的。
 * 结果未知时页头与导航刷新、说明可能已经改好（改名按状态幂等，再保存一次是安全的，M2-P6 复核第二批 G-2）；
 * 刷新最多等 10 秒（第三批 S-a），刷新失败或者超时就说明页面没能刷新（第三批 G-a）；超时之后刷新才回来的，说明随后改过来（第五批 G4）
 */
function RenameForm({ space, onDone, onDenied }: RenameFormProps) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(space.name)
  /** 上一次失败之后页面刷新好了没有：说明据此说"已刷新"还是"没能刷新"（第三批 G-a） */
  const { refreshed, refreshAfterFailure } = useOutcomeRefresh()
  const inputId = useId()
  const problemId = useId()
  const mutation = useMutation({
    mutationFn: async (value: string) => renameSpace(space.id, value),
    onSuccess: async (renamed) => {
      queryClient.setQueryData(spaceQueryOptions(space.id).queryKey, current => current === undefined ? undefined : { ...current, name: renamed.name })
      queryClient.setQueryData(spacesQueryOptions().queryKey, list => list === undefined
        ? undefined
        : { ...list, items: list.items.map(item => (item.id === renamed.id ? { ...item, name: renamed.name } : item)) })
      await refreshAfterSuccess(async () => refreshQueries(queryClient, [SPACES_QUERY_KEY]))
      onDone()
    },
    onError: async (error) => {
      if (isAccessDenied(error)) {
        onDenied(error)
        return
      }
      await refreshAfterFailure(error, async () => refreshQueries(queryClient, [SPACES_QUERY_KEY]))
    },
  })
  const parsed = spaceNameSchema.safeParse(name)
  const problem = problemOf(parsed)

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
        <Input id={inputId} value={name} autoFocus aria-invalid={!parsed.success} aria-describedby={problem === undefined ? undefined : problemId} onChange={event => setName(event.target.value)} />
      </div>
      <Button type="submit" aria-disabled={mutation.isPending || !parsed.success} aria-describedby={problem === undefined ? undefined : problemId}>{mutation.isPending ? text.saving : text.save}</Button>
      <Button type="button" variant="ghost" aria-disabled={mutation.isPending} onClick={() => !mutation.isPending && onDone()}>{text.cancel}</Button>
      <FieldProblem id={problemId} problem={problem} empty={name === ''} />
      {mutation.isError && !isAccessDenied(mutation.error) && (
        <Alert variant="destructive" className="basis-full">
          <AlertDescription>{writeFailureText(mutation.error, refreshed)}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}

interface SpaceHeaderProps {
  readonly space: SpaceView
  readonly folderId: string | null
  /** 页面的标题（h1）：由空间页持有，内容区与焦点的兜底也用它 */
  readonly titleRef: RefObject<HTMLHeadingElement | null>
  /** 页头的操作被拒绝：由空间页重新请求（页头的说明不提列表，不用等它的结果） */
  readonly onDenied: () => Promise<boolean>
}

/**
 * 页头：名称（个人空间显示"我的空间"）、类型与状态、我的角色；只显示能做的操作（新建表格、成员、改名）。
 * 页头的操作被拒绝（403、404，M2-P6 复核 S2、S5）：页面按新的权限重新请求，改名的表单关掉，按钮可能随之消失；
 * 原因写在页头下方的说明里（403 用服务端说的原因），说明接住焦点。
 */
function SpaceHeader({ space, folderId, titleRef, onDenied }: SpaceHeaderProps) {
  const [renaming, setRenaming] = useState(false)
  // 页头的操作被拒绝的原因：每次一条新的对象（换了一条就再接一次焦点）
  const [denial, setDenial] = useState<{ readonly message: string }>()
  const renameRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useFocusAfterRender()
  const personal = space.type === 'personal'

  function doneRenaming(): void {
    setRenaming(false)
    focusAfterRender(space.permissions.canRename ? renameRef : titleRef)
  }

  function denied(message: string): void {
    setRenaming(false)
    setDenial({ message })
    void onDenied()
  }

  function closeDenial(): void {
    setDenial(undefined)
    focusAfterRender(titleRef)
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
          {/* 新建到当前位置：在文件夹里时建进那个文件夹（M2-P4） */}
          {space.permissions.canCreateDocuments && (
            <NewSheetButton spaceId={space.id} folderId={folderId} onDenied={error => denied(messages.documents.createDenied(describeError(error).message))} />
          )}
        </div>
      </div>
      {/* 刷新之后不能改名了（例如空间刚被归档）：表单不再显示（M2-P6 复核 S2） */}
      {renaming && space.permissions.canRename && <RenameForm space={space} onDone={doneRenaming} onDenied={error => denied(text.renameDenied(describeError(error).message))} />}
      {denial !== undefined && <Notice focusKey={denial} onClose={closeDenial} variant="destructive">{denial.message}</Notice>}
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
 * 页面里有焦点的按钮、行随刷新或新的权限消失时，焦点交给页面的标题（M2-P6 复核 S3，shared/lib/use-focus-rescue.ts）。
 */
function SpaceContent({ spaceId, folderIds = [] }: { readonly spaceId: string, readonly folderIds?: readonly string[] }) {
  const queryClient = useQueryClient()
  const space = useQuery(spaceQueryOptions(spaceId))
  // 导航已经请求过"我能看到的空间"：移动与复制的目标候选直接用它（服务端给的 canCreateDocuments），共用同一份缓存，
  // 连同取到了没有（复制的目标据此说明加载中、没能加载，M2 Codex 评审复验的一般 1）。
  // 由这里取、往下传，而不是在 features/documents 里取：那会让 documents 反向引用 spaces，两个功能成环。
  // refetchOnMount 关掉：这里只是读导航已经加载的那一份，什么时候重新请求由导航决定；
  // 否则每打开一个空间页都会顺带刷新导航，"已打开的页面里再进来才发现看不到"（M2-P2 审查 B1）就走不到了
  const spaces = useQuery({ ...spacesQueryOptions(), refetchOnMount: false })
  const targetSpaces = targetSpacesOf(spaces)
  const missing = isMissingResource(space.error)
  const refreshOrganize = useOrganizeRefreshChecked()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const rescueFocus = useFocusRescue(titleRef)
  useForgetMissingSpace(spaceId, missing)
  // 浏览器标签页的标题：显示出内容之后由内容区按当前的位置给出，看不到时由"空间不存在"给出（M2-P6 复核 S4）；这里只管加载失败
  useDocumentTitle(!space.isPending && !missing && space.data === undefined ? text.pageLoadFailed : undefined)

  /**
   * 页内的操作按访问权限被拒绝（403、404）：页面显示的权限已经过时，重新请求（M2-P2 复验）——
   * 页头与导航（归档的标记），以及这个空间里各层的文件夹与文档（被拒绝的那一行可能已经不在了，它们的 permissions 也过时了，
   * M2-P4 审查建议 2）。空间看不到了（404）时另由 useForgetMissingSpace 去掉这个空间的缓存、页面说明"空间不存在"。
   * 兑现为列表刷新好了没有（最多等 10 秒，M2-P6 复核第五批 G3）：整理面板说"它已经不在这里了"时，据此说"列表已刷新"还是"没能刷新"；
   * 页头与导航照常刷新、不计入
   */
  async function refreshAfterDenied(): Promise<boolean> {
    void refreshQueries(queryClient, [SPACES_QUERY_KEY], { throwOnError: false })
    return refreshWithin(async () => refreshOrganize([spaceId]))
  }

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
      <section className="flex flex-col gap-4" aria-labelledby="space-title">
        <h1 id="space-title" className="text-xl font-semibold">{text.pageLoadFailed}</h1>
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
    <section ref={rescueFocus} className="flex flex-col gap-4" aria-labelledby="space-title">
      <SpaceHeader space={space.data} folderId={folderIds.at(-1) ?? null} titleRef={titleRef} onDenied={refreshAfterDenied} />
      <SpaceContents
        space={space.data}
        folderIds={folderIds}
        targetSpaces={targetSpaces}
        onDenied={refreshAfterDenied}
        titleRef={titleRef}
      />
    </section>
  )
}

/** 首页：本人的个人空间（"我的空间"，US-M1-03 的地址不变）。会话由外层的 RequireSession 加载好了 */
export function HomePage() {
  const session = useQuery(sessionQueryOptions())
  const personal = session.data?.personalSpace
  return personal === undefined ? null : <SpaceContent key={personal.id} spaceId={personal.id} />
}

/**
 * 任意空间：/spaces/{id}，以及它里面的某个文件夹 /spaces/{id}/folders/{id 路径}（M2-P2 设计 §3.10，M2-P4 设计 §3.7）。
 * 换了空间就重新开始（输入框、改名的状态不带到别的空间）；在同一个空间里换文件夹只换内容区，页头不重来
 */
export function SpacePage() {
  const { spaceId = '', '*': splat } = useParams()
  return <SpaceContent key={spaceId} spaceId={spaceId} folderIds={folderIdsFromPath(splat)} />
}
