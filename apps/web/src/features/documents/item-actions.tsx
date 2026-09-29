import type { SpaceView } from '@nerve-office/contracts'
import type { ReactNode } from 'react'
import type { Destination } from './destination-form.tsx'
import { useMutation } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { describeError, isAccessDenied } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { spaceTrashPath } from '../../shared/lib/space-paths.ts'
import { Alert, AlertDescription, Button, buttonVariants, Input, Label, Skeleton } from '../../shared/ui/index.ts'
import { DestinationForm } from './destination-form.tsx'

const text = messages.organize

/** 做完一件事之后，在列表上方给出的说明：那一行常常随之消失（移走了、删掉了），说明不能挂在行里 */
export interface OrganizeNotice {
  readonly message: string
  /** 接着可以去哪里，例如"打开回收站"、"打开副本" */
  readonly action?: ReactNode
}

/**
 * 调用者能在这个对象上做什么。一律由服务端给（文件夹在列表里就带着 permissions，文档在展开"操作"时按 id 取），
 * 界面不自己按角色推算（M2-P4 设计 §3.7）。
 */
export interface OrganizePermissions {
  readonly canRename: boolean
  /** 在同一个空间里换文件夹 */
  readonly canMoveWithinSpace: boolean
  /** 连同内容移到别的空间：决定目标空间的候选是"全部能新建的空间"还是"只有它现在所在的空间" */
  readonly canMoveAcrossSpaces: boolean
  readonly canCopy: boolean
  readonly canDelete: boolean
}

export interface ItemOperations {
  readonly rename: (name: string) => Promise<unknown>
  readonly move: (destination: Destination) => Promise<unknown>
  /** 只有文档能复制：副本的标题与"打开副本"由它给出 */
  readonly copy?: (destination: Destination) => Promise<OrganizeNotice>
  readonly remove: () => Promise<void>
}

interface ItemActionsProps {
  /** 展开的面板的 id：与“操作”按钮的 aria-controls 对应 */
  readonly panelId: string
  readonly name: string
  /** 名称的校验（文件夹名与文档标题的上限不同）：不合法时不能提交 */
  readonly validateName: (value: string) => boolean
  /** 还没拿到权限时为空：文档要先取一次元数据 */
  readonly permissions: OrganizePermissions | undefined
  readonly loading: boolean
  readonly error: Error | null
  readonly onRetry: () => void
  /** 它现在在哪里 */
  readonly current: Destination
  /** 选目标位置时不列出这个文件夹：移动文件夹时就是它自己（审查建议 6） */
  readonly excludeFolderId?: string
  /** 我能新建内容的空间（服务端给的 canCreateDocuments）：复制与跨空间移动的候选 */
  readonly targetSpaces: readonly SpaceView[]
  readonly operations: ItemOperations
  readonly onDone: (notice: OrganizeNotice | undefined) => void
  /** 操作按访问权限被拒绝（403、404）：页面显示的权限已经过时，重新请求 */
  readonly onDenied: () => void
  /** 关掉操作面板 */
  readonly onClose: () => void
}

type Chosen = 'rename' | 'move' | 'copy'

/** 行内改名（不用弹窗，与空间改名同一个形态） */
function RenameForm({ panelId, name, validate, pending, error, onSubmit, onCancel }: {
  readonly panelId: string
  readonly name: string
  readonly validate: (value: string) => boolean
  readonly pending: boolean
  readonly error: Error | null
  readonly onSubmit: (value: string) => void
  readonly onCancel: () => void
}) {
  const [value, setValue] = useState(name)
  const inputId = useId()
  const valid = validate(value)
  return (
    <form
      id={panelId}
      className="flex flex-wrap items-end gap-2 border-t bg-muted/30 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid && !pending)
          onSubmit(value.trim())
      }}
    >
      <div className="flex min-w-48 flex-1 flex-col gap-2">
        <Label htmlFor={inputId}>{text.renameLabel(name)}</Label>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- 点了改名才出现的输入框：焦点直接给它，不落到 body */}
        <Input id={inputId} value={value} autoFocus aria-invalid={!valid} onChange={event => setValue(event.target.value)} />
      </div>
      <Button type="submit" size="sm" aria-disabled={pending || !valid}>{pending ? text.saving : text.save}</Button>
      <Button type="button" variant="ghost" size="sm" aria-disabled={pending} onClick={() => !pending && onCancel()}>{text.cancel}</Button>
      {error !== null && (
        <Alert variant="destructive" className="basis-full">
          <AlertDescription>{describeError(error).message}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}

/**
 * 一行的操作面板（M2-P4 设计 §3.7）：按服务端给的权限只列出能做的，选中之后在同一处展开行内的表单。
 * 删除直接做（进回收站，30 天内可以恢复，所以不另外确认）；永久删除在回收站页里才有，那里要确认。
 */
export function ItemActions({ panelId, name, validateName, permissions, loading, error, onRetry, current, excludeFolderId, targetSpaces, operations, onDone, onDenied, onClose }: ItemActionsProps) {
  const [chosen, setChosen] = useState<Chosen>()
  // 移动/复制提交时目标位置的可读名称，例如"市场部 / 方案"：做完之后在说明里回述
  const targetLabelRef = useRef('')

  const mutation = useMutation({
    mutationFn: async (run: () => Promise<OrganizeNotice | undefined>) => run(),
    onSuccess: notice => onDone(notice),
    onError: (failure) => {
      if (isAccessDenied(failure))
        onDenied()
    },
  })

  function run(action: () => Promise<OrganizeNotice | undefined>): void {
    if (!mutation.isPending)
      mutation.mutate(action)
  }

  if (loading) {
    return (
      <div id={panelId} className="border-t px-4 py-3">
        <Skeleton className="h-6 w-48" role="status" aria-label={text.loadingActions} />
      </div>
    )
  }
  if (permissions === undefined) {
    return (
      <div id={panelId} className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
        <span role="alert" className="text-sm text-destructive">{text.actionsFailed(describeError(error).message)}</span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>{messages.common.retry}</Button>
      </div>
    )
  }

  const canMove = permissions.canMoveWithinSpace || permissions.canMoveAcrossSpaces
  // 不能跨空间时，目标只有它现在所在的空间；能跨空间时，目标是我能新建内容的空间（服务端给的 canCreateDocuments）
  const spaces = permissions.canMoveAcrossSpaces ? targetSpaces : targetSpaces.filter(space => space.id === current.spaceId)

  if (chosen === 'rename') {
    return (
      <RenameForm
        panelId={panelId}
        name={name}
        validate={validateName}
        pending={mutation.isPending}
        error={mutation.error}
        onSubmit={value => run(async () => {
          await operations.rename(value)
          return undefined
        })}
        onCancel={onClose}
      />
    )
  }
  if (chosen === 'move' || chosen === 'copy') {
    const copy = operations.copy
    return (
      <DestinationForm
        panelId={panelId}
        action={chosen}
        spaces={chosen === 'copy' ? targetSpaces : spaces}
        current={current}
        excludeFolderId={excludeFolderId}
        pending={mutation.isPending}
        error={mutation.error}
        onSubmit={(destination, label) => {
          targetLabelRef.current = label
          run(async () => {
            if (chosen === 'copy' && copy !== undefined)
              return copy(destination)
            await operations.move(destination)
            return { message: text.moved(name, targetLabelRef.current) }
          })
        }}
        onCancel={onClose}
      />
    )
  }

  return (
    <div id={panelId} className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-2">
      {permissions.canRename && <Button type="button" variant="outline" size="sm" onClick={() => setChosen('rename')}>{text.rename}</Button>}
      {canMove && <Button type="button" variant="outline" size="sm" onClick={() => setChosen('move')}>{text.move}</Button>}
      {permissions.canCopy && operations.copy !== undefined && <Button type="button" variant="outline" size="sm" onClick={() => setChosen('copy')}>{text.copy}</Button>}
      {permissions.canDelete && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-disabled={mutation.isPending}
          onClick={() => run(async () => {
            await operations.remove()
            return { message: text.deleted(name), action: <Link to={spaceTrashPath(current.spaceId)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{text.goToTrash}</Link> }
          })}
        >
          {mutation.isPending ? text.deleting : text.delete}
        </Button>
      )}
      <Button type="button" variant="ghost" size="sm" onClick={onClose}>{text.cancel}</Button>
      {/* 删除失败的说明一律按错误码给（shared/i18n）：例如"文件夹里有别人创建的文档"与"空间已归档"是两个不同的 403，
          界面不在这里按错误码分支，免得把其中一种的说法安到另一种头上（M2-P4 审查 B2） */}
      {mutation.isError && (
        <Alert variant="destructive" className="basis-full">
          <AlertDescription>{describeError(mutation.error).message}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
