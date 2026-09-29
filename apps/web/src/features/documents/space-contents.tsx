import type { SpaceView } from '@nerve-office/contracts'
import type { OrganizeNotice } from './item-actions.tsx'
import { FOLDER_LIST_MAX_ITEMS, folderNameSchema } from '@nerve-office/contracts'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { describeError, isAccessDenied } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { spaceFolderPath, spacePath, spaceTrashPath } from '../../shared/lib/space-paths.ts'
import { useFocusAfterRender } from '../../shared/lib/use-focus-after-render.ts'
import { Alert, AlertDescription, Button, buttonVariants, Input, Label, Skeleton } from '../../shared/ui/index.ts'
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

/** 面包屑：空间名 → 路径上的每个文件夹；当前这一级不是链接（aria-current） */
function Breadcrumb({ space, folderIds, crumbs }: {
  readonly space: SpaceView
  readonly folderIds: readonly string[]
  readonly crumbs: readonly { readonly id: string, readonly name: string | undefined }[]
}) {
  const spaceName = space.type === 'personal' ? messages.documents.title : space.name
  return (
    <nav aria-label={text.breadcrumbLabel}>
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <li>
          <Link to={spacePath(space.id)} className="rounded outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">{spaceName}</Link>
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

/** 在当前位置新建文件夹：行内表单（首屏页面不用弹窗）；同一个 requestId 重试只建一个 */
function NewFolderForm({ spaceId, parentId, onDone, onCancel, onDenied }: {
  readonly spaceId: string
  readonly parentId: string | undefined
  readonly onDone: () => void
  readonly onCancel: () => void
  readonly onDenied: () => void
}) {
  const refresh = useOrganizeRefresh()
  const [name, setName] = useState('')
  const inputId = useId()
  const requestIdRef = useRef<string>(undefined)
  const parsed = folderNameSchema.safeParse(name)
  const mutation = useMutation({
    mutationFn: async (value: string) => {
      requestIdRef.current ??= crypto.randomUUID()
      return createFolder({ spaceId, name: value, requestId: requestIdRef.current, ...(parentId === undefined ? {} : { parentId }) })
    },
    onSuccess: async () => {
      await refresh([spaceId])
      onDone()
    },
    onError: (error) => {
      if (isAccessDenied(error))
        onDenied()
    },
  })

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
        <Input id={inputId} value={name} autoFocus aria-invalid={name !== '' && !parsed.success} onChange={event => setName(event.target.value)} />
      </div>
      <Button type="submit" aria-disabled={mutation.isPending || !parsed.success}>{mutation.isPending ? text.creatingFolder : text.newFolder}</Button>
      <Button type="button" variant="ghost" aria-disabled={mutation.isPending} onClick={() => !mutation.isPending && onCancel()}>{text.cancel}</Button>
      {mutation.isError && (
        <Alert variant="destructive" className="basis-full">
          <AlertDescription>{text.createFolderFailed(describeError(mutation.error).message)}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}

/** 做完一件事之后的说明（那一行常常随之消失）：出现时接住焦点，不落到 body */
function Notice({ notice, onClose }: { readonly notice: OrganizeNotice, readonly onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [notice])
  return (
    <Alert ref={ref} tabIndex={-1}>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        <span>{notice.message}</span>
        {notice.action}
        <Button variant="ghost" size="sm" onClick={onClose}>{messages.common.close}</Button>
      </AlertDescription>
    </Alert>
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
}

/**
 * 空间页的内容区（M2-P4 设计 §3.7）：面包屑、新建文件夹与回收站的入口、子文件夹（在前）与文档。
 * 地址里带着从空间根目录到当前文件夹的整条 id 路径，所以直接打开深层地址与一层层点进去看到的一样（shared/lib/space-paths.ts）。
 */
export function SpaceContents({ space, folderIds, targetSpaces, onDenied }: SpaceContentsProps) {
  const trail = useFolderTrail(space.id, folderIds)
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<OpenItem>()
  const [notice, setNotice] = useState<OrganizeNotice>()
  const newFolderRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useFocusAfterRender()
  const parentId = folderIds.at(-1)

  function toggle(kind: OpenItem['kind'], id: string): void {
    setOpen(open?.kind === kind && open.id === id ? undefined : { kind, id })
  }

  function finish(done: OrganizeNotice | undefined): void {
    setOpen(undefined)
    setNotice(done)
  }

  function doneCreating(): void {
    setCreating(false)
    focusAfterRender(newFolderRef)
  }

  if (trail.missing) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>{text.locationNotFound}</span>
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
      {creating && <NewFolderForm spaceId={space.id} parentId={parentId} onDone={doneCreating} onCancel={doneCreating} onDenied={onDenied} />}
      {notice !== undefined && <Notice notice={notice} onClose={() => setNotice(undefined)} />}
      {trail.children.isPending && <Skeleton className="h-12 w-full" role="status" aria-label={text.folderLoading} />}
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
        onToggle={id => toggle('folder', id)}
        onDone={finish}
        onDenied={onDenied}
      />
      <DocumentList
        spaceId={space.id}
        folderId={parentId ?? null}
        targetSpaces={targetSpaces}
        openId={open?.kind === 'document' ? open.id : undefined}
        onToggle={id => toggle('document', id)}
        onDone={finish}
        onDenied={onDenied}
        hasFolders={(trail.children.data?.items.length ?? 0) > 0}
      />
    </div>
  )
}
