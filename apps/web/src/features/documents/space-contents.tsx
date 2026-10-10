import type { SpaceView } from '@nerve-office/contracts'
import type { RefObject } from 'react'
import type { OrganizeNotice } from './item-actions.tsx'
import type { TargetSpaces } from './target-spaces.ts'
import { FOLDER_LIST_MAX_ITEMS, folderNameSchema } from '@nerve-office/contracts'
import { useMutation } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { describeError, isAccessDenied, isMissingResource, isUnknownOutcome } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { useRequestIdLedger } from '../../shared/lib/request-id-ledger.ts'
import { spaceFolderPath, spacePath, spaceTrashPath } from '../../shared/lib/space-paths.ts'
import { connectionUnavailable, useConnectionState } from '../../shared/lib/use-connection-state.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { useFirstLoadRetry } from '../../shared/lib/use-first-load-retry.ts'
import { useFocusAfterRender } from '../../shared/lib/use-focus-after-render.ts'
import { useOutcomeRefresh } from '../../shared/lib/use-outcome-refresh.ts'
import { problemOf } from '../../shared/lib/validation.ts'
import { Alert, AlertDescription, Button, buttonVariants, FieldProblem, Input, Label, RetryButton, Skeleton } from '../../shared/ui/index.ts'
import { DetailRefreshProblem, RefreshProblem } from '../../shared/ui/refresh-problem.tsx'
import { DocumentList } from './document-list.tsx'
import { FolderList } from './folder-list.tsx'
import { useFolderTrail } from './folder-trail.ts'
import { createFolder } from './folders-api.ts'
import { OrganizeNoticeBar } from './organize-notice-bar.tsx'
import { useOrganizePanels } from './organize-panels.ts'
import { useOrganizeRefresh, useOrganizeRefreshChecked } from './organize-refresh.ts'

const text = messages.organize

/** 空间在界面上的名字：个人空间是"我的空间" */
function spaceNameOf(space: SpaceView): string {
  return space.type === 'personal' ? messages.documents.title : space.name
}

/** 面包屑：空间名 → 路径上的每个文件夹；当前这一级不是链接（aria-current） */
function Breadcrumb({ space, folderIds, crumbs }: {
  readonly space: SpaceView
  readonly folderIds: readonly string[]
  readonly crumbs: readonly { readonly id: string, readonly name: string | undefined }[]
}) {
  return (
    <nav aria-label={text.breadcrumbLabel}>
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <li>
          <Link to={spacePath(space.id)} className="rounded outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">{spaceNameOf(space)}</Link>
        </li>
        {crumbs.map((crumb, level) => {
          const last = level === crumbs.length - 1
          // 名称要从"它父亲那一层的列表"里读出来，还没读到时先留空位，位置本身照样能点
          const name = crumb.name ?? '…'
          return (
            <li key={crumb.id} className="flex items-center gap-1">
              <span aria-hidden="true">/</span>
              {last
                ? <span aria-current="page" className="font-medium text-foreground">{name}</span>
                : <Link to={spaceFolderPath(space.id, folderIds.slice(0, level + 1))} className="rounded outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">{name}</Link>}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

interface NewFolderFormProps {
  readonly spaceId: string
  readonly parentId: string | undefined
  /** 建好了；replayed 时给出说明（服务端说这次是重放：之前那一次已经建好了），由列表上方的说明条接住焦点 */
  readonly onDone: (notice?: OrganizeNotice) => void
  readonly onCancel: () => void
  /** 新建按访问权限被拒绝：表单关掉，原因交给列表上方的说明（这个表单随新的权限不再显示） */
  readonly onDenied: (notice: OrganizeNotice) => void
}

/**
 * 在当前位置新建文件夹：行内表单（首屏页面不用弹窗）。
 * requestId 按"在这个位置新建文件夹"记账（shared/api/request-ids.ts，M2-P6 复核 M1），名称不在其中：
 * 结果未知之后原样再提交，沿用同一个、服务端只建一个；改了名再提交，服务端认出那个 requestId 已经用掉了（REQUEST_ID_CONFLICT），
 * 说明上一次多半已经建好并刷新列表，requestId 随之换新，再提交就建这个新名字的（P1）。结果未知时列表同样刷新。
 * 这两种情形的刷新经共用的做法（shared/api/write-outcome.ts，M2-P6 复核第四批）：最多等 10 秒，刷新失败或者到了时限还没回来，
 * 说明里说"列表没能刷新"，表单也不一直停在"正在新建…"；超时之后刷新才回来的，说明随后改过来（第五批 G4）。
 * 服务端说这次是重放（replayed，M2-P6 复核第二批 S-1）：结果未知的那一次其实已经建好了（同一个位置、同一个名称），表单关掉，
 * 在列表上方说明"上一次其实已经完成"，不当成这一次新建的；这件事随之了结，再新建就是另一个。
 * 成功之后的刷新最多等到时限（Codex 对抗评审 CX4）：一直不回来时表单照常关掉，在列表上方说明建好了、列表还在刷新。
 * 名称不合法时说明原因（WCAG 3.3.1，M2-P6 复核 S4）。
 */
function NewFolderForm({ spaceId, parentId, onDone, onCancel, onDenied }: NewFolderFormProps) {
  const unavailable = connectionUnavailable(useConnectionState())
  const refresh = useOrganizeRefresh()
  const refreshAfterUnknown = useOrganizeRefreshChecked()
  const ledger = useRequestIdLedger()
  const [name, setName] = useState('')
  /** 上一次失败之后列表刷新好了没有：说明据此说"已刷新"还是"没能刷新"（第四批）。每次失败都重新记下 */
  const { refreshed, refreshAfterFailure } = useOutcomeRefresh()
  const inputId = useId()
  const problemId = useId()
  const parsed = folderNameSchema.safeParse(name)
  const problem = problemOf(parsed)
  const mutation = useMutation({
    mutationFn: async (value: string) => ledger.send(`folder:${spaceId}/${parentId ?? ''}`, async requestId => createFolder({ spaceId, name: value, requestId, ...(parentId === undefined ? {} : { parentId }) })),
    onSuccess: async (folder) => {
      const refreshing = await refresh([spaceId])
      if (folder.replayed)
        onDone({ message: text.createFolderReplayed(folder.name), refreshing })
      else
        onDone(refreshing === undefined ? undefined : { message: text.folderCreated(folder.name), refreshing })
    },
    onError: async (error) => {
      if (isAccessDenied(error)) {
        onDenied({ message: text.createFolderDenied(describeError(error).message), problem: true })
        return
      }
      // 结果未知，或者上一次已经建好：在时限之内刷新列表，看得到它
      await refreshAfterFailure(error, async () => refreshAfterUnknown([spaceId]), { also: ledger.earlierAttemptDone })
    },
  })

  let failure: string | undefined
  if (mutation.isError) {
    const reason = describeError(mutation.error).message
    if (ledger.earlierAttemptDone(mutation.error))
      failure = text.createFolderEarlier(refreshed)
    else if (isUnknownOutcome(mutation.error))
      failure = text.createFolderOutcomeUnknown(reason, refreshed)
    else
      failure = text.createFolderFailed(reason)
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-lg border p-4"
      aria-label={text.newFolder}
      onSubmit={(event) => {
        event.preventDefault()
        if (parsed.success && !mutation.isPending && connectionUnavailable() === undefined)
          mutation.mutate(parsed.data)
      }}
    >
      <div className="flex min-w-48 flex-1 flex-col gap-2">
        <Label htmlFor={inputId}>{text.newFolderName}</Label>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- 点了新建才出现的输入框：焦点直接给它，不落到 body */}
        <Input id={inputId} value={name} autoFocus aria-invalid={name !== '' && !parsed.success} aria-describedby={problem === undefined ? undefined : problemId} onChange={event => setName(event.target.value)} />
      </div>
      <Button type="submit" aria-disabled={mutation.isPending || !parsed.success || unavailable !== undefined} aria-describedby={problem === undefined ? undefined : problemId}>{mutation.isPending ? text.creatingFolder : text.newFolder}</Button>
      {unavailable !== undefined && <p className="basis-full text-sm text-muted-foreground">{unavailable}</p>}
      <Button type="button" variant="ghost" aria-disabled={mutation.isPending} onClick={() => !mutation.isPending && onCancel()}>{text.cancel}</Button>
      {/* 还什么都没输入时只是说明规则 */}
      <FieldProblem id={problemId} problem={problem} empty={name === ''} />
      {failure !== undefined && (
        <Alert variant="destructive" className="basis-full">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}

interface SpaceContentsProps {
  readonly space: SpaceView
  /** 地址里的 id 路径：空数组就是空间的根目录 */
  readonly folderIds: readonly string[]
  /**
   * 我能新建内容的空间（服务端给的 canCreateDocuments），连同取到了没有：移动与复制的目标候选。
   * 由空间页传入（targetSpacesOf），避免与 features/spaces 成环
   */
  readonly targetSpaces: TargetSpaces
  /**
   * 页内的操作按访问权限被拒绝：由空间页重新请求页头、导航与各层的列表，兑现为列表刷新好了没有（最多等 10 秒）：
   * 整理面板的说明据此说"列表已刷新"还是"没能刷新"（M2-P6 复核第五批 G3）
   */
  readonly onDenied: () => Promise<boolean>
  /** 页面的标题（h1，tabIndex -1）：关掉说明时那一行已经不在了，焦点交给它（M2-P6 复核 S3） */
  readonly titleRef: RefObject<HTMLElement | null>
}

/** 这一层看不到了（404）：由"这个文件夹不存在"说明（trail.missing），重试也不会好 */
function notRetryable(error: unknown): boolean {
  return !isMissingResource(error)
}

/**
 * 空间页的内容区（M2-P4 设计 §3.7）：面包屑、新建文件夹与回收站的入口、子文件夹（在前）与文档。
 * 地址里带着从空间根目录到当前文件夹的整条 id 路径，所以直接打开深层地址与一层层点进去看到的一样（shared/lib/space-paths.ts）。
 * 浏览器标签页的标题按当前的位置给出（M2-P6 复核 S4）：空间的根目录是空间名，文件夹里是"文件夹名 - 空间名"。
 * 子文件夹第一次就没取到时按"重试"：重试期间说明与按钮留着（不可用、说正在重试）；取到之后焦点交给页面的标题，不落到 body
 * （规范 §2.4，shared/lib/use-first-load-retry.ts）
 */
export function SpaceContents({ space, folderIds, targetSpaces, onDenied, titleRef }: SpaceContentsProps) {
  const unavailable = connectionUnavailable(useConnectionState())
  const trail = useFolderTrail(space.id, folderIds)
  const folders = useFirstLoadRetry(trail.children, titleRef, { retryable: notRetryable })
  const [creating, setCreating] = useState(false)
  // 哪一行展开了操作面板、列表上方的说明与焦点的去处（与"与我共享"共用，organize-panels.tsx）
  const panels = useOrganizePanels(titleRef)
  const { open, notice } = panels
  const newFolderRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useFocusAfterRender()
  const parentId = folderIds.at(-1)
  const folderName = trail.crumbs.at(-1)?.name
  useDocumentTitle(folderName === undefined ? spaceNameOf(space) : `${folderName} - ${spaceNameOf(space)}`)

  function doneCreating(done?: OrganizeNotice): void {
    setCreating(false)
    // 有说明时（服务端说这次是重放、刷新到了时限还在后台）由说明条接住焦点
    if (done !== undefined) {
      panels.showNotice(done)
      return
    }
    // 新建按钮随新的权限不再显示时（例如空间刚被归档）交给标题
    focusAfterRender(space.permissions.canCreateFolders ? newFolderRef : titleRef)
  }

  /** 新建文件夹被拒绝：表单关掉，原因写在列表上方（说明接住焦点），页面按新的权限重新请求 */
  function creationDenied(denied: OrganizeNotice): void {
    setCreating(false)
    panels.showNotice(denied)
    void onDenied()
  }

  if (trail.missing || trail.moved) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>{trail.missing ? text.locationNotFound : text.locationMoved}</span>
          <Link to={spacePath(space.id)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{text.backToSpaceRoot}</Link>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {folderIds.length > 0 && <Breadcrumb space={space} folderIds={folderIds} crumbs={trail.crumbs} />}
      {/* 面包屑的名称取自上面各层的列表：有一层留着之前的、刷新却失败了（DEF-040）时明说位置没能刷新、给出重试；
          有一层看不到了（404）时上面已经换成"这个文件夹不存在"，不走到这里 */}
      <DetailRefreshProblem query={trail.location} detail={text.breadcrumbLabel} fallbackFocus={titleRef} />
      <div className="flex flex-wrap items-center gap-2">
        {space.permissions.canCreateFolders && !creating && (
          <Button ref={newFolderRef} variant="outline" size="sm" aria-disabled={unavailable !== undefined} onClick={() => connectionUnavailable() === undefined && setCreating(true)}>{text.newFolder}</Button>
        )}
        {/* 看得到空间内容的人都看得到回收站的列表，能不能动由每一条的 permissions 决定（P4-S3 spec §5） */}
        <Link to={spaceTrashPath(space.id)} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>{text.trash}</Link>
      </div>
      {space.permissions.canCreateFolders && !creating && unavailable !== undefined && <p className="text-sm text-muted-foreground">{unavailable}</p>}
      {/* 刷新之后不能在这里新建了（例如空间刚被归档）：表单不再显示（M2-P6 复核 S2） */}
      {creating && space.permissions.canCreateFolders && (
        <NewFolderForm spaceId={space.id} parentId={parentId} onDone={doneCreating} onCancel={() => doneCreating()} onDenied={creationDenied} />
      )}
      {notice !== undefined && <OrganizeNoticeBar notice={notice} onClose={panels.closeNotice} />}
      {!folders.failed && trail.children.isPending && (
        <div role="status" aria-label={text.folderLoading}>
          <Skeleton className="h-12 w-full" />
        </div>
      )}
      {/* 重试期间说明与按钮留着（不可用、说正在重试），上一次的原因不再给（请求缓存已经清掉了它） */}
      {folders.failed && (
        <Alert variant="destructive" onFocus={folders.focus.onFocus} onBlur={folders.focus.onBlur}>
          <AlertDescription>
            <p>{text.folderLoadFailed}</p>
            {!folders.retrying && <p>{describeError(trail.children.error).message}</p>}
            <RetryButton retrying={folders.retrying} onRetry={() => void trail.children.refetch()} className="mt-2" />
          </AlertDescription>
        </Alert>
      )}
      {/* 留着之前的子文件夹、刷新却失败了（Codex 对抗评审 CX5）：明说没能刷新、给出重试，之前的照常显示 */}
      <RefreshProblem query={trail.children} list={text.folderListLabel} />
      {trail.children.data?.truncated === true && (
        <Alert>
          <AlertDescription>{text.folderTruncated(FOLDER_LIST_MAX_ITEMS)}</AlertDescription>
        </Alert>
      )}
      <FolderList
        folders={trail.children.data?.items ?? []}
        folderIds={folderIds}
        targetSpaces={targetSpaces}
        openId={open?.kind === 'folder' ? open.id : undefined}
        openTriggerRef={panels.openTriggerRef}
        onToggle={id => panels.toggle('folder', id)}
        onDone={panels.finish}
        onDenied={onDenied}
      />
      <DocumentList
        spaceId={space.id}
        folderId={parentId ?? null}
        targetSpaces={targetSpaces}
        openId={open?.kind === 'document' ? open.id : undefined}
        openTriggerRef={panels.openTriggerRef}
        onToggle={id => panels.toggle('document', id)}
        onDone={panels.finish}
        onDenied={onDenied}
        hasFolders={(trail.children.data?.items.length ?? 0) > 0}
        titleRef={titleRef}
      />
    </div>
  )
}
