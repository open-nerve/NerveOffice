import type { SpaceView } from '@nerve-office/contracts'
import type { RefObject } from 'react'
import type { OrganizeNotice } from './item-actions.tsx'
import { FOLDER_LIST_MAX_ITEMS, folderNameSchema } from '@nerve-office/contracts'
import { useMutation } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { describeError, isAccessDenied, isUnknownOutcome } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { useRequestIdLedger } from '../../shared/lib/request-id-ledger.ts'
import { spaceFolderPath, spacePath, spaceTrashPath } from '../../shared/lib/space-paths.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { useFocusAfterRender } from '../../shared/lib/use-focus-after-render.ts'
import { problemOf } from '../../shared/lib/validation.ts'
import { Alert, AlertDescription, Button, buttonVariants, FieldProblem, Input, Label, Notice, Skeleton } from '../../shared/ui/index.ts'
import { DocumentList } from './document-list.tsx'
import { FolderList } from './folder-list.tsx'
import { useFolderTrail } from './folder-trail.ts'
import { createFolder } from './folders-api.ts'
import { useOrganizeRefresh } from './organize-refresh.ts'

const text = messages.organize

/** 展开了操作面板的那一个对象（整页只有一个：同时开几个面板既分散注意，也会白白多取几次元数据） */
interface OpenItem {
  readonly kind: 'folder' | 'document'
  readonly id: string
}

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
  readonly onDone: () => void
  readonly onCancel: () => void
  /** 新建按访问权限被拒绝：表单关掉，原因交给列表上方的说明（这个表单随新的权限不再显示） */
  readonly onDenied: (notice: OrganizeNotice) => void
}

/**
 * 在当前位置新建文件夹：行内表单（首屏页面不用弹窗）。
 * requestId 按"在这个位置新建文件夹"记账（shared/api/request-ids.ts，M2-P6 复核 M1），名称不在其中：
 * 结果未知之后原样再提交，沿用同一个、服务端只建一个；改了名再提交，服务端认出那个 requestId 已经用掉了（REQUEST_ID_CONFLICT），
 * 说明上一次多半已经建好并刷新列表，requestId 随之换新，再提交就建这个新名字的（P1）。结果未知时列表同样刷新。
 * 名称不合法时说明原因（WCAG 3.3.1，M2-P6 复核 S4）。
 */
function NewFolderForm({ spaceId, parentId, onDone, onCancel, onDenied }: NewFolderFormProps) {
  const refresh = useOrganizeRefresh()
  const ledger = useRequestIdLedger()
  const [name, setName] = useState('')
  const inputId = useId()
  const problemId = useId()
  const parsed = folderNameSchema.safeParse(name)
  const problem = problemOf(parsed)
  const mutation = useMutation({
    mutationFn: async (value: string) => ledger.send(`folder:${spaceId}/${parentId ?? ''}`, async requestId => createFolder({ spaceId, name: value, requestId, ...(parentId === undefined ? {} : { parentId }) })),
    onSuccess: async () => {
      await refresh([spaceId])
      onDone()
    },
    onError: async (error) => {
      if (isAccessDenied(error)) {
        onDenied({ message: text.createFolderDenied(describeError(error).message), problem: true })
        return
      }
      // 结果未知，或者上一次已经建好：列表刷新出来，看得到它
      if (isUnknownOutcome(error) || ledger.earlierAttemptDone(error))
        await refresh([spaceId])
    },
  })

  let failure: string | undefined
  if (mutation.isError) {
    const reason = describeError(mutation.error).message
    if (ledger.earlierAttemptDone(mutation.error))
      failure = text.createFolderEarlier
    else if (isUnknownOutcome(mutation.error))
      failure = text.createFolderOutcomeUnknown(reason)
    else
      failure = text.createFolderFailed(reason)
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-lg border p-4"
      aria-label={text.newFolder}
      onSubmit={(event) => {
        event.preventDefault()
        if (parsed.success && !mutation.isPending)
          mutation.mutate(parsed.data)
      }}
    >
      <div className="flex min-w-48 flex-1 flex-col gap-2">
        <Label htmlFor={inputId}>{text.newFolderName}</Label>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- 点了新建才出现的输入框：焦点直接给它，不落到 body */}
        <Input id={inputId} value={name} autoFocus aria-invalid={name !== '' && !parsed.success} aria-describedby={problem === undefined ? undefined : problemId} onChange={event => setName(event.target.value)} />
      </div>
      <Button type="submit" aria-disabled={mutation.isPending || !parsed.success} aria-describedby={problem === undefined ? undefined : problemId}>{mutation.isPending ? text.creatingFolder : text.newFolder}</Button>
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
  /** 我能新建内容的空间（服务端给的 canCreateDocuments）：移动与复制的目标候选。由空间页传入，避免与 features/spaces 成环 */
  readonly targetSpaces: readonly SpaceView[]
  /** 页内的操作按访问权限被拒绝：由空间页重新请求页头与导航 */
  readonly onDenied: () => void
  /** 页面的标题（h1，tabIndex -1）：关掉说明时那一行已经不在了，焦点交给它（M2-P6 复核 S3） */
  readonly titleRef: RefObject<HTMLElement | null>
}

/**
 * 空间页的内容区（M2-P4 设计 §3.7）：面包屑、新建文件夹与回收站的入口、子文件夹（在前）与文档。
 * 地址里带着从空间根目录到当前文件夹的整条 id 路径，所以直接打开深层地址与一层层点进去看到的一样（shared/lib/space-paths.ts）。
 * 浏览器标签页的标题按当前的位置给出（M2-P6 复核 S4）：空间的根目录是空间名，文件夹里是"文件夹名 - 空间名"。
 */
export function SpaceContents({ space, folderIds, targetSpaces, onDenied, titleRef }: SpaceContentsProps) {
  const trail = useFolderTrail(space.id, folderIds)
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<OpenItem>()
  // 列表上方的说明：每次一条新的对象（它本身就是这条说明的标识，换了一条就再接一次焦点）
  const [notice, setNotice] = useState<OrganizeNotice>()
  const newFolderRef = useRef<HTMLButtonElement>(null)
  // 最后一次被点开的那一行的"操作"按钮：面板收起、说明关掉之后焦点回到它身上，不落到 body（M2-P4 审查建议 1）。
  // 由行在点击时记下这个元素，不用 React 的 ref：面板一收起，绑在"展开的那一行"上的 ref 就被置空了，那时已经晚了
  const openTriggerRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useFocusAfterRender()
  const parentId = folderIds.at(-1)
  const folderName = trail.crumbs.at(-1)?.name
  useDocumentTitle(folderName === undefined ? spaceNameOf(space) : `${folderName} - ${spaceNameOf(space)}`)

  /** 焦点还给那一行的"操作"；那一行已经不在了（删掉了、移走了、随新的权限不再有"操作"）时交给页面的标题 */
  function focusTrigger(): void {
    focusAfterRender(openTriggerRef.current?.isConnected === true ? openTriggerRef : titleRef)
  }

  function toggle(kind: OpenItem['kind'], id: string): void {
    const same = open?.kind === kind && open.id === id
    setOpen(same ? undefined : { kind, id })
    // 收起面板（再点一次"操作"，或者面板里点"取消"）：面板里的按钮随之消失，焦点还给这一行的"操作"
    if (same)
      focusTrigger()
  }

  function finish(done: OrganizeNotice | undefined): void {
    setOpen(undefined)
    setNotice(done)
    // 没有说明条时（例如改名成功）焦点还给这一行的"操作"；有说明条时由它接住（那一行常常随之消失）
    if (done === undefined)
      focusTrigger()
  }

  function closeNotice(): void {
    setNotice(undefined)
    focusTrigger()
  }

  function doneCreating(): void {
    setCreating(false)
    // 新建按钮随新的权限不再显示时（例如空间刚被归档）交给标题
    focusAfterRender(space.permissions.canCreateFolders ? newFolderRef : titleRef)
  }

  /** 新建文件夹被拒绝：表单关掉，原因写在列表上方（说明接住焦点），页面按新的权限重新请求 */
  function creationDenied(denied: OrganizeNotice): void {
    setCreating(false)
    setNotice(denied)
    onDenied()
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
      <div className="flex flex-wrap items-center gap-2">
        {space.permissions.canCreateFolders && !creating && (
          <Button ref={newFolderRef} variant="outline" size="sm" onClick={() => setCreating(true)}>{text.newFolder}</Button>
        )}
        {/* 看得到空间内容的人都看得到回收站的列表，能不能动由每一条的 permissions 决定（P4-S3 spec §5） */}
        <Link to={spaceTrashPath(space.id)} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>{text.trash}</Link>
      </div>
      {/* 刷新之后不能在这里新建了（例如空间刚被归档）：表单不再显示（M2-P6 复核 S2） */}
      {creating && space.permissions.canCreateFolders && (
        <NewFolderForm spaceId={space.id} parentId={parentId} onDone={doneCreating} onCancel={doneCreating} onDenied={creationDenied} />
      )}
      {notice !== undefined && (
        <Notice focusKey={notice} action={notice.action} onClose={closeNotice} variant={notice.problem === true ? 'destructive' : 'default'}>
          {notice.message}
        </Notice>
      )}
      {trail.children.isPending && (
        <div role="status" aria-label={text.folderLoading}>
          <Skeleton className="h-12 w-full" />
        </div>
      )}
      {!trail.children.isPending && trail.children.data === undefined && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{text.folderLoadFailed}</p>
            <p>{describeError(trail.children.error).message}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void trail.children.refetch()}>{messages.common.retry}</Button>
          </AlertDescription>
        </Alert>
      )}
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
        openTriggerRef={openTriggerRef}
        onToggle={id => toggle('folder', id)}
        onDone={finish}
        onDenied={onDenied}
      />
      <DocumentList
        spaceId={space.id}
        folderId={parentId ?? null}
        targetSpaces={targetSpaces}
        openId={open?.kind === 'document' ? open.id : undefined}
        openTriggerRef={openTriggerRef}
        onToggle={id => toggle('document', id)}
        onDone={finish}
        onDenied={onDenied}
        hasFolders={(trail.children.data?.items.length ?? 0) > 0}
      />
    </div>
  )
}
