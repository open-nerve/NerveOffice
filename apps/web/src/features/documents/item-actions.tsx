import type { SpaceView } from '@nerve-office/contracts'
import type { ReactNode } from 'react'
import type { Destination } from './destination-form.tsx'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { describeError, isAccessDenied, isMissingResource, isUnknownOutcome } from '../../shared/api/index.ts'
import { refreshIfUnknown } from '../../shared/api/write-outcome.ts'
import { messages } from '../../shared/i18n/index.ts'
import { useRequestIdLedger } from '../../shared/lib/request-id-ledger.ts'
import { spaceTrashPath } from '../../shared/lib/space-paths.ts'
import { Alert, AlertDescription, Button, buttonVariants, FieldProblem, Input, Label, Skeleton } from '../../shared/ui/index.ts'
import { DestinationForm } from './destination-form.tsx'

const text = messages.organize

/** 做完一件事、或者操作没能完成之后，在列表上方给出的说明：那一行常常随之消失（移走了、删掉了），说明不能挂在行里 */
export interface OrganizeNotice {
  readonly message: string
  /** 接着可以去哪里，例如"打开回收站"、"打开副本" */
  readonly action?: ReactNode
  /** 说明的是没能完成（被拒绝、结果未知）：醒目的样式 */
  readonly problem?: boolean
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
  /**
   * 结果未知之后重新请求相关的列表：它所在的空间，加上这次的目标位置所在的空间（移动、复制）。有一个没能刷新就拒绝
   * （organize-refresh.ts 的 useOrganizeRefreshAfterUnknown）：面板经共用的做法在时限之内等它，说明据此说"已刷新"还是"没能刷新"（第四批）
   */
  readonly refresh: (destination?: Destination) => Promise<void>
}

interface ItemActionsProps {
  /** 展开的面板的 id：与“操作”按钮的 aria-controls 对应 */
  readonly panelId: string
  readonly name: string
  /** 名称的校验（文件夹名与文档标题的上限不同）：给出第一条不满足的规则，不合法时不能提交，并说明原因 */
  readonly validateName: (value: string) => string | undefined
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
  /** 收起面板；notice 是要在列表上方给出的说明 */
  readonly onDone: (notice: OrganizeNotice | undefined) => void
  /** 操作按访问权限被拒绝（403、404）：页面显示的权限已经过时，重新请求页头、导航与这个空间里的列表 */
  readonly onDenied: () => void
  /** 关掉操作面板 */
  readonly onClose: () => void
}

type Operation = 'rename' | 'move' | 'copy' | 'delete'

/** 按服务端给的权限，这一种操作现在还能不能做（复制另外要这一行支持复制：文件夹不能复制） */
function allows(permissions: OrganizePermissions, operations: ItemOperations, operation: Exclude<Operation, 'delete'>): boolean {
  switch (operation) {
    case 'rename':
      return permissions.canRename
    case 'move':
      return permissions.canMoveWithinSpace || permissions.canMoveAcrossSpaces
    case 'copy':
      return permissions.canCopy && operations.copy !== undefined
  }
}

/** 一次提交：做的是哪种操作、目标位置（移动、复制），以及做这件事的函数（成功时给出列表上方的说明） */
interface Attempt {
  readonly operation: Operation
  readonly destination?: Destination
  readonly run: () => Promise<OrganizeNotice | undefined>
}

/** 行内改名（不用弹窗，与空间改名同一个形态）：名称不合法时说明原因（WCAG 3.3.1，M2-P6 复核 S4） */
function RenameForm({ panelId, name, validate, pending, error, onSubmit, onCancel }: {
  readonly panelId: string
  readonly name: string
  readonly validate: (value: string) => string | undefined
  readonly pending: boolean
  readonly error: string | undefined
  readonly onSubmit: (value: string) => void
  readonly onCancel: () => void
}) {
  const [value, setValue] = useState(name)
  const inputId = useId()
  const problemId = useId()
  const problem = validate(value)
  const valid = problem === undefined
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
        <Input id={inputId} value={value} autoFocus aria-invalid={!valid} aria-describedby={valid ? undefined : problemId} onChange={event => setValue(event.target.value)} />
      </div>
      <Button type="submit" size="sm" aria-disabled={pending || !valid} aria-describedby={valid ? undefined : problemId}>{pending ? text.saving : text.save}</Button>
      <Button type="button" variant="ghost" size="sm" aria-disabled={pending} onClick={() => !pending && onCancel()}>{text.cancel}</Button>
      <FieldProblem id={problemId} problem={problem} />
      {error !== undefined && (
        <Alert variant="destructive" className="basis-full">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}

/**
 * 一行的操作面板（M2-P4 设计 §3.7）：按服务端给的权限只列出能做的，选中之后在同一处展开行内的表单。
 * 删除直接做（进回收站，30 天内可以恢复，所以不另外确认）；永久删除在回收站页里才有，那里要确认。
 *
 * 没能完成时（M2-P6 复核 S1、S2、S3）：
 * - 按访问权限被拒绝（403、404）：页面按新的权限重新请求；面板收起，原因写在列表上方的说明里（403 用服务端说的原因，S5）。
 *   那一行可能随之消失，按钮可能随新的权限不再显示，说明接住焦点；
 * - 结果未知（网络、5xx）：相关的列表随即刷新。删除与移动会让那一行消失，面板收起，说明写在列表上方（可能已经生效）；
 *   改名与复制留在面板里，可以原样再提交（改名是幂等的，复制带着 requestId）。这时的刷新经共用的做法（shared/api/write-outcome.ts，
 *   第四批）：最多等 10 秒，刷新失败或者到了时限还没回来，说明里说"列表没能刷新"，面板也不一直停在"正在…"；
 * - 其余（同名之类）：留在面板里说明。
 * 展开时取元数据得到 404（文档已经不在了）：同样收起、刷新、说明，不给一个永远失败的"重试"（P15）。
 * 已经打开的改名、移动、复制表单，刷新之后这一种操作不能做了（例如别处的操作被拒绝、页面按新的权限重新请求，空间刚被归档、
 * 自己刚被降为查看者）：表单随之收起，回到按新权限列出的操作（M2-P6 复核第二批 G-6；文件夹一个操作都做不了时整个面板收起）。
 */
export function ItemActions({ panelId, name, validateName, permissions, loading, error, onRetry, current, excludeFolderId, targetSpaces, operations, onDone, onDenied, onClose }: ItemActionsProps) {
  const [chosen, setChosen] = useState<Exclude<Operation, 'delete'>>()
  /** 上一次失败之后列表刷新好了没有：留在面板里的说明（改名、复制）据此说"已刷新"还是"没能刷新"（第四批）。每次失败都重新记下 */
  const [refreshed, setRefreshed] = useState(false)
  const ledger = useRequestIdLedger()
  // 移动/复制提交时目标位置的可读名称，例如"市场部 / 方案"：做完之后在说明里回述
  const targetLabelRef = useRef('')
  const trashLink = <Link to={spaceTrashPath(current.spaceId)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{text.goToTrash}</Link>

  /** 按访问权限被拒绝时的说明：404 说它（或者目标位置）已经不在了，403 用服务端说的原因 */
  function deniedNotice(operation: Operation, failure: unknown): OrganizeNotice {
    if (!isMissingResource(failure))
      return { message: text.denied(name, describeError(failure).message), problem: true }
    // 移动、复制的 404 也可能是目标文件夹没了：两种都说
    if (operation === 'move' || operation === 'copy')
      return { message: text.targetOrItemGone(name), problem: true }
    return { message: text.gone(name), action: trashLink, problem: true }
  }

  const mutation = useMutation({
    mutationFn: async (attempt: Attempt) => attempt.run(),
    onSuccess: notice => onDone(notice),
    onError: async (failure, attempt) => {
      if (isAccessDenied(failure)) {
        onDenied()
        onDone(deniedNotice(attempt.operation, failure))
        return
      }
      // 结果未知，或者复制的上一次已经完成：在时限之内刷新相关的列表
      const listRefreshed = await refreshIfUnknown(failure, async () => operations.refresh(attempt.destination), { also: ledger.earlierAttemptDone })
      setRefreshed(listRefreshed)
      if (!isUnknownOutcome(failure))
        return
      const reason = describeError(failure).message
      if (attempt.operation === 'delete')
        onDone({ message: text.deleteOutcomeUnknown(name, reason, listRefreshed), action: trashLink, problem: true })
      else if (attempt.operation === 'move')
        onDone({ message: text.moveOutcomeUnknown(name, reason, listRefreshed), problem: true })
    },
  })

  // 展开时取元数据就得到 404：它已经不在了。刷新列表，收起面板并说明（在 effect 里做，不在渲染时改缓存与父组件的状态；
  // 只在"已经不在了"出现的那一次做，回调与链接每次渲染都是新的，用 effect 事件读它们）
  const gone = !loading && permissions === undefined && isMissingResource(error)
  const reportGone = useEffectEvent(() => {
    onDenied()
    onDone({ message: text.gone(name), action: trashLink, problem: true })
  })
  useEffect(() => {
    if (gone)
      reportGone()
  }, [gone])

  function run(attempt: Attempt): void {
    if (!mutation.isPending)
      mutation.mutate(attempt)
  }

  /** 选一种操作：上一次操作的失败不带进新打开的表单（三种操作共用一个变更，M2-P6 复核 G1） */
  function choose(operation: Exclude<Operation, 'delete'>): void {
    mutation.reset()
    setChosen(operation)
  }

  // 打开着的表单对应的操作，按刷新之后的权限已经不能做了（G-6）：表单收起，不留着一个提交了只会被拒绝的表单。
  // 在渲染中清掉选择（React 随即按新的状态重新渲染这一个组件，不用 effect 多渲染一轮）：权限之后又回来时表单也不会自己冒出来
  const revoked = chosen !== undefined && permissions !== undefined && !allows(permissions, operations, chosen)
  if (revoked)
    setChosen(undefined)
  const shown = revoked ? undefined : chosen

  /**
   * 留在面板里的失败说明：复制的上一次可能已经完成、改名与复制的结果未知（可以原样再提交），其余按错误码。
   * 提到列表的按刷新好了没有说（第四批）
   */
  function panelError(): string | undefined {
    if (!mutation.isError)
      return undefined
    const failure = mutation.error
    const operation = mutation.variables?.operation
    if (operation === 'copy' && ledger.earlierAttemptDone(failure))
      return text.copiedEarlier(refreshed)
    const reason = describeError(failure).message
    if (isUnknownOutcome(failure) && operation === 'rename')
      return text.renameOutcomeUnknown(reason, refreshed)
    if (isUnknownOutcome(failure) && operation === 'copy')
      return text.copyOutcomeUnknown(reason)
    return reason
  }

  if (loading || gone) {
    return (
      <div id={panelId} className="border-t px-4 py-3">
        <div role="status" aria-label={text.loadingActions}>
          <Skeleton className="h-6 w-48" />
        </div>
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

  // 不能跨空间时，目标只有它现在所在的空间；能跨空间时，目标是我能新建内容的空间（服务端给的 canCreateDocuments）
  const spaces = permissions.canMoveAcrossSpaces ? targetSpaces : targetSpaces.filter(space => space.id === current.spaceId)

  if (shown === 'rename') {
    return (
      <RenameForm
        panelId={panelId}
        name={name}
        validate={validateName}
        pending={mutation.isPending}
        error={panelError()}
        onSubmit={value => run({
          operation: 'rename',
          run: async () => {
            await operations.rename(value)
            return undefined
          },
        })}
        onCancel={onClose}
      />
    )
  }
  if (shown === 'move' || shown === 'copy') {
    const copy = operations.copy
    return (
      <DestinationForm
        panelId={panelId}
        action={shown}
        spaces={shown === 'copy' ? targetSpaces : spaces}
        current={current}
        excludeFolderId={excludeFolderId}
        pending={mutation.isPending}
        error={panelError()}
        onSubmit={(destination, label) => {
          targetLabelRef.current = label
          run({
            operation: shown,
            destination,
            run: async () => {
              if (shown === 'copy' && copy !== undefined)
                return copy(destination)
              await operations.move(destination)
              return { message: text.moved(name, targetLabelRef.current) }
            },
          })
        }}
        onCancel={onClose}
      />
    )
  }

  return (
    <div id={panelId} className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-2">
      {allows(permissions, operations, 'rename') && <Button type="button" variant="outline" size="sm" onClick={() => choose('rename')}>{text.rename}</Button>}
      {allows(permissions, operations, 'move') && <Button type="button" variant="outline" size="sm" onClick={() => choose('move')}>{text.move}</Button>}
      {allows(permissions, operations, 'copy') && <Button type="button" variant="outline" size="sm" onClick={() => choose('copy')}>{text.copy}</Button>}
      {permissions.canDelete && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-disabled={mutation.isPending}
          onClick={() => run({
            operation: 'delete',
            run: async () => {
              await operations.remove()
              return { message: text.deleted(name), action: trashLink }
            },
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
          <AlertDescription>{panelError()}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
