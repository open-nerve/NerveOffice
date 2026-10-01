import type { AdminSpace, SpaceRole } from '@nerve-office/contracts'
import { SPACE_ROLES, spaceNameSchema } from '@nerve-office/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { ApiError, describeError, isUnknownOutcome } from '../../shared/api/index.ts'
import { writeFailureText } from '../../shared/api/write-outcome.ts'
import { messages } from '../../shared/i18n/index.ts'
import { adminMessages } from '../../shared/i18n/zh-cn/admin.ts'
import { useOutcomeRefresh } from '../../shared/lib/use-outcome-refresh.ts'
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
  /**
   * 结果未知（以及 refreshAfter 认出的情形）之后刷新列表：刷新失败时拒绝，弹窗据此说明页面没能刷新（M2-P6 复核第三批 G-a）；
   * 弹窗等它有时限（第三批 S-a）
   */
  readonly refresh: () => Promise<void>
  readonly onClose: () => void
  /** 打开它的按钮随操作消失时，关闭之后焦点去哪里 */
  readonly returnFocus?: () => void
}

interface SubmissionOptions extends Pick<SpaceDialogProps, 'onDone' | 'refresh' | 'onClose'> {
  /** 结果未知之外，失败之后还要刷新列表的情形（例如加入时"已经是成员"：列表显示的已经过时，可能就是刚才那一次，M2-P6 复核 S1） */
  readonly refreshAfter?: (error: unknown) => boolean
  /**
   * 失败的说明：不给时，结果未知说"可能已经生效"，其余按错误码（writeFailureText）。refreshed：刷新好了没有，
   * 说明里提到"已刷新"的要按它说（加入空间的两条说明，M2-P6 复核第四批）
   */
  readonly describeFailure?: (error: unknown, refreshed: boolean) => string
}

/**
 * 弹窗里的提交（改名、加入空间）。与确认的弹窗一样（审查 B4）：
 * - 进行中拦下关闭（Esc、×、取消都不关），结果不会落到已经关掉的弹窗上，也不会让人以为没有提交；
 * - 成功之后先刷新（onDone），再关闭；失败时弹窗留着，说明原因；结果未知时也刷新（refresh）、说明可能已经生效（M2-P6 复核第二批 G-2，
 *   shared/api 的共用做法），按 refreshAfter 还有别的情形要刷新（列表显示服务端的实际状态）。这两种刷新最多等 10 秒（第三批 S-a）：
 *   一直不回来时先给出说明，弹窗不再卡在"正在处理…"；刷新失败或者超时，说明页面没能刷新（第三批 G-a）；
 *   超时之后刷新才回来的，说明随后改过来（第五批 G4）；
 * - 关闭时清掉上一次的失败，下次打开不带着旧的说明。
 * 服务端逐请求检查；标明只给系统管理员，被拒绝时由全局处理重新确认会话（M2-P1 审查 B4）。
 */
function useDialogSubmission<T>(action: (value: T) => Promise<unknown>, { onDone, refresh, onClose, refreshAfter, describeFailure }: SubmissionOptions) {
  /** 上一次失败之后页面刷新好了没有：说明据此说"已刷新"还是"没能刷新"（第三批 G-a）。每次失败都重新记下 */
  const { refreshed, refreshAfterFailure } = useOutcomeRefresh()
  const mutation = useMutation({
    mutationFn: action,
    meta: SYSTEM_ADMIN_ONLY,
    onSuccess: async () => onDone(),
    onError: async (error) => {
      await refreshAfterFailure(error, refresh, { also: refreshAfter })
    },
  })

  function close(): void {
    mutation.reset()
    onClose()
  }

  return {
    pending: mutation.isPending,
    failure: mutation.error === null ? undefined : (describeFailure?.(mutation.error, refreshed) ?? writeFailureText(mutation.error, refreshed)),
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

export function RenameSpaceDialog({ space, onDone, refresh, onClose, returnFocus }: SpaceDialogProps) {
  const submission = useDialogSubmission(async ({ id, name }: { readonly id: string, readonly name: string }) => renameSpace(id, name), { onDone, refresh, onClose })
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
 * 加入失败时的说明（M2-P6 复核 S1）：结果未知时可能已经加入；已经是成员时说清楚——这个空间之前有过结果未知的加入（unsure），
 * 才说"可能就是刚才没能确认的那一次"，否则只说已经是成员（第五批 G5：别人刚把你加进去、列表还没刷新时，并没有"刚才那一次"）；
 * 其余按错误码。前两种情形列表都随即刷新，说明按刷新好了没有说"已刷新"还是"没能刷新"（第四批）
 */
function joinFailureText(error: unknown, refreshed: boolean, unsure: boolean): string {
  if (isAlreadyMember(error))
    return unsure ? text.joinedEarlier(refreshed) : text.alreadyJoined(refreshed)
  if (isUnknownOutcome(error))
    return text.joinOutcomeUnknown(describeError(error).message, refreshed)
  return describeError(error).message
}

export function JoinSpaceDialog({ space, onDone, refresh, onClose, returnFocus }: SpaceDialogProps) {
  /**
   * 结果未知的那一次加入是哪个空间（第五批 G5，与创建团队空间记下那一次的名称一样）：之后再加入它得到"已经是成员"，才说多半就是那一次。
   * 弹窗关掉时不清（再打开、加入同一个空间时仍然记得），加入这个空间成功时清掉
   */
  const [unsureSpaceId, setUnsureSpaceId] = useState<string>()
  // 与成员页的"添加成员"是同一个接口：把自己加入时，审计记为系统管理员加入空间
  const submission = useDialogSubmission(
    async ({ id, userId, role }: { readonly id: string, readonly userId: string, readonly role: SpaceRole }) => {
      try {
        await addMember(id, { userId, role })
      }
      catch (error) {
        if (isUnknownOutcome(error))
          setUnsureSpaceId(id)
        throw error
      }
      setUnsureSpaceId(current => (current === id ? undefined : current))
    },
    {
      onDone,
      refresh,
      onClose,
      refreshAfter: isAlreadyMember,
      describeFailure: (error, refreshed) => joinFailureText(error, refreshed, space !== undefined && space.id === unsureSpaceId),
    },
  )
  return (
    <Dialog open={space !== undefined} onOpenChange={submission.changeOpen}>
      {space !== undefined && (
        <DialogContent fallbackFocus={returnFocus}>
          <DialogHeader>
            <DialogTitle>{text.joinTitle(space.name)}</DialogTitle>
            <DialogDescription>{text.joinDescription}</DialogDescription>
          </DialogHeader>
          <JoinForm state={submission} onSubmit={(userId, role) => submission.submit({ id: space.id, userId, role })} />
        </DialogContent>
      )}
    </Dialog>
  )
}
