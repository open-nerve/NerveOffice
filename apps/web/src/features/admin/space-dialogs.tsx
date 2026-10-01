import type { AdminSpace, SpaceRole } from '@nerve-office/contracts'
import { SPACE_ROLES, spaceNameSchema } from '@nerve-office/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { ApiError, describeError, isUnknownOutcome } from '../../shared/api/index.ts'
import { refreshIfUnknown, writeFailureText } from '../../shared/api/write-outcome.ts'
import { messages } from '../../shared/i18n/index.ts'
import { adminMessages } from '../../shared/i18n/zh-cn/admin.ts'
import { problemOf } from '../../shared/lib/validation.ts'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../shared/ui/dialog.tsx'
import { Alert, AlertDescription, Button, FieldProblem, Input, Label, NativeSelect } from '../../shared/ui/index.ts'
import { sessionQueryOptions, SYSTEM_ADMIN_ONLY } from '../auth/index.ts'
import { addMember, renameSpace } from '../spaces/index.ts'

const text = adminMessages.spaces

interface SpaceDialogProps {
  /** 要操作的团队空间；为空时弹窗关着 */
  readonly space: AdminSpace | undefined
  /** 成功之后（刷新列表） */
  readonly onDone: () => Promise<void>
  readonly onClose: () => void
  /** 打开它的按钮随操作消失时，关闭之后焦点去哪里 */
  readonly returnFocus?: () => void
}

interface SubmissionOptions extends Pick<SpaceDialogProps, 'onDone' | 'onClose'> {
  /** 结果未知之外，失败之后还要刷新列表的情形（例如加入时"已经是成员"：多半就是刚才那一次，M2-P6 复核 S1） */
  readonly refreshAfter?: (error: unknown) => boolean
}

/**
 * 弹窗里的提交（改名、加入空间）。与确认的弹窗一样（审查 B4）：
 * - 进行中拦下关闭（Esc、×、取消都不关），结果不会落到已经关掉的弹窗上，也不会让人以为没有提交；
 * - 成功之后先刷新（onDone），再关闭；失败时弹窗留着，说明原因；结果未知时也刷新、说明可能已经生效（M2-P6 复核第二批 G-2，
 *   shared/api 的共用做法），按 refreshAfter 还有别的情形要刷新（列表显示服务端的实际状态）；
 * - 关闭时清掉上一次的失败，下次打开不带着旧的说明。
 * 服务端逐请求检查；标明只给系统管理员，被拒绝时由全局处理重新确认会话（M2-P1 审查 B4）。
 */
function useDialogSubmission<T>(action: (value: T) => Promise<unknown>, { onDone, onClose, refreshAfter }: SubmissionOptions) {
  const mutation = useMutation({
    mutationFn: action,
    meta: SYSTEM_ADMIN_ONLY,
    onSuccess: async () => onDone(),
    onError: async (error) => {
      if (refreshAfter?.(error) === true)
        await onDone()
      else
        await refreshIfUnknown(error, onDone)
    },
  })

  function close(): void {
    mutation.reset()
    onClose()
  }

  return {
    pending: mutation.isPending,
    error: mutation.error,
    failure: mutation.error === null ? undefined : writeFailureText(mutation.error),
    submit: (value: T): void => {
      if (!mutation.isPending)
        mutation.mutate(value, { onSuccess: close })
    },
    changeOpen: (open: boolean): void => {
      if (!open && !mutation.isPending)
        close()
    },
  }
}

interface FormState {
  readonly pending: boolean
  /** 上一次提交失败的说明 */
  readonly failure: string | undefined
}

/** 弹窗的底部：失败的原因、取消（进行中不可用）、提交 */
function FormFooter({ state, submitLabel, ready, describedBy }: { readonly state: FormState, readonly submitLabel: string, readonly ready: boolean, readonly describedBy?: string }) {
  return (
    <>
      {state.failure !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>{state.failure}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" aria-disabled={state.pending}>{messages.common.cancel}</Button>
        </DialogClose>
        <Button type="submit" aria-disabled={state.pending || !ready} aria-describedby={describedBy}>{state.pending ? messages.common.working : submitLabel}</Button>
      </DialogFooter>
    </>
  )
}

/** 给团队空间改名（M2-P2 设计 §3.10）：名称已被使用时说明原因，弹窗留着；名称不合法时说明原因（M2-P6 复核 S4） */
function RenameForm({ space, state, onSubmit }: { readonly space: AdminSpace, readonly state: FormState, readonly onSubmit: (name: string) => void }) {
  const [name, setName] = useState(space.name)
  const inputId = useId()
  const problemId = useId()
  const parsed = spaceNameSchema.safeParse(name)
  const problem = problemOf(parsed)
  const describedBy = problem === undefined ? undefined : problemId
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (parsed.success)
          onSubmit(parsed.data)
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={inputId}>{text.name}</Label>
        <Input id={inputId} value={name} aria-invalid={!parsed.success} aria-describedby={describedBy} onChange={event => setName(event.target.value)} />
        <FieldProblem id={problemId} problem={problem} empty={name === ''} />
      </div>
      <FormFooter state={state} submitLabel={text.renameSave} ready={parsed.success} describedBy={describedBy} />
    </form>
  )
}

export function RenameSpaceDialog({ space, onDone, onClose, returnFocus }: SpaceDialogProps) {
  const submission = useDialogSubmission(async ({ id, name }: { readonly id: string, readonly name: string }) => renameSpace(id, name), { onDone, onClose })
  return (
    <Dialog open={space !== undefined} onOpenChange={submission.changeOpen}>
      {space !== undefined && (
        <DialogContent fallbackFocus={returnFocus}>
          <DialogHeader>
            <DialogTitle>{text.renameTitle(space.name)}</DialogTitle>
            <DialogDescription>{text.renameDescription}</DialogDescription>
          </DialogHeader>
          <RenameForm space={space} state={submission} onSubmit={name => submission.submit({ id: space.id, name })} />
        </DialogContent>
      )}
    </Dialog>
  )
}

/** 系统管理员把自己加入团队空间（00 号计划书 §5.2）：选角色；加入记入审计 */
function JoinForm({ state, onSubmit }: { readonly state: FormState, readonly onSubmit: (userId: string, role: SpaceRole) => void }) {
  const session = useQuery(sessionQueryOptions())
  const [role, setRole] = useState<SpaceRole>('viewer')
  const roleId = useId()
  const self = session.data?.user.id
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (self !== undefined)
          onSubmit(self, role)
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={roleId}>{text.joinRole}</Label>
        <NativeSelect id={roleId} value={role} onChange={event => setRole(event.target.value as SpaceRole)}>
          {[...SPACE_ROLES].reverse().map(value => <option key={value} value={value}>{messages.spaces.roleName(value)}</option>)}
        </NativeSelect>
      </div>
      <FormFooter state={state} submitLabel={text.join} ready={self !== undefined} />
    </form>
  )
}

/** 已经是这个空间的成员了 */
function isAlreadyMember(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'ALREADY_MEMBER'
}

/**
 * 加入失败时的说明（M2-P6 复核 S1）：结果未知时可能已经加入；已经是成员（多半就是刚才没能确认的那一次）时说清楚；其余按错误码。
 * 这两种情形列表都随即刷新
 */
function joinFailureText(error: Error | null): string | undefined {
  if (error === null)
    return undefined
  if (isAlreadyMember(error))
    return text.joinedEarlier
  if (isUnknownOutcome(error))
    return text.joinOutcomeUnknown(describeError(error).message)
  return describeError(error).message
}

export function JoinSpaceDialog({ space, onDone, onClose, returnFocus }: SpaceDialogProps) {
  // 与成员页的"添加成员"是同一个接口：把自己加入时，审计记为系统管理员加入空间
  const submission = useDialogSubmission(
    async ({ id, userId, role }: { readonly id: string, readonly userId: string, readonly role: SpaceRole }) => addMember(id, { userId, role }),
    { onDone, onClose, refreshAfter: isAlreadyMember },
  )
  return (
    <Dialog open={space !== undefined} onOpenChange={submission.changeOpen}>
      {space !== undefined && (
        <DialogContent fallbackFocus={returnFocus}>
          <DialogHeader>
            <DialogTitle>{text.joinTitle(space.name)}</DialogTitle>
            <DialogDescription>{text.joinDescription}</DialogDescription>
          </DialogHeader>
          <JoinForm state={{ pending: submission.pending, failure: joinFailureText(submission.error) }} onSubmit={(userId, role) => submission.submit({ id: space.id, userId, role })} />
        </DialogContent>
      )}
    </Dialog>
  )
}
