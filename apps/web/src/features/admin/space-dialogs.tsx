import type { AdminSpace, SpaceRole } from '@nerve-office/contracts'
import { SPACE_ROLES, spaceNameSchema } from '@nerve-office/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../shared/ui/dialog.tsx'
import { Alert, AlertDescription, Button, Input, Label, NativeSelect } from '../../shared/ui/index.ts'
import { sessionQueryOptions, SYSTEM_ADMIN_ONLY } from '../auth/index.ts'
import { joinSpace, renameTeamSpace } from './admin-api.ts'

const text = messages.admin.spaces

interface SpaceDialogProps {
  /** 要操作的团队空间；为空时弹窗关着 */
  readonly space: AdminSpace | undefined
  /** 成功之后（刷新列表） */
  readonly onDone: () => Promise<void>
  readonly onClose: () => void
  /** 打开它的按钮随操作消失时，关闭之后焦点去哪里 */
  readonly returnFocus?: () => void
}

/** 给团队空间改名（M2-P2 设计 §3.10）：名称已被使用时说明原因，弹窗留着 */
function RenameForm({ space, onDone, onClose }: { readonly space: AdminSpace, readonly onDone: () => Promise<void>, readonly onClose: () => void }) {
  const [name, setName] = useState(space.name)
  const inputId = useId()
  const mutation = useMutation({
    mutationFn: async (value: string) => renameTeamSpace(space.id, value),
    meta: SYSTEM_ADMIN_ONLY,
    onSuccess: async () => {
      await onDone()
      onClose()
    },
  })
  const parsed = spaceNameSchema.safeParse(name)
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (parsed.success && !mutation.isPending)
          mutation.mutate(parsed.data)
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={inputId}>{text.name}</Label>
        <Input id={inputId} value={name} aria-invalid={!parsed.success} onChange={event => setName(event.target.value)} />
      </div>
      {mutation.isError && (
        <Alert variant="destructive">
          <AlertDescription>{describeError(mutation.error).message}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" aria-disabled={mutation.isPending}>{messages.common.cancel}</Button>
        </DialogClose>
        <Button type="submit" aria-disabled={mutation.isPending || !parsed.success}>{mutation.isPending ? messages.common.working : text.renameSave}</Button>
      </DialogFooter>
    </form>
  )
}

export function RenameSpaceDialog({ space, onDone, onClose, returnFocus }: SpaceDialogProps) {
  return (
    <Dialog open={space !== undefined} onOpenChange={open => !open && onClose()}>
      {space !== undefined && (
        <DialogContent fallbackFocus={returnFocus}>
          <DialogHeader>
            <DialogTitle>{text.renameTitle(space.name)}</DialogTitle>
            <DialogDescription>{text.renameDescription}</DialogDescription>
          </DialogHeader>
          <RenameForm space={space} onDone={onDone} onClose={onClose} />
        </DialogContent>
      )}
    </Dialog>
  )
}

/** 系统管理员把自己加入团队空间（00 号计划书 §5.2）：选角色；加入记入审计 */
function JoinForm({ space, onDone, onClose }: { readonly space: AdminSpace, readonly onDone: () => Promise<void>, readonly onClose: () => void }) {
  const session = useQuery(sessionQueryOptions())
  const [role, setRole] = useState<SpaceRole>('viewer')
  const roleId = useId()
  const mutation = useMutation({
    mutationFn: async (userId: string) => joinSpace(space.id, userId, role),
    meta: SYSTEM_ADMIN_ONLY,
    onSuccess: async () => {
      await onDone()
      onClose()
    },
  })
  const self = session.data?.user.id
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (self !== undefined && !mutation.isPending)
          mutation.mutate(self)
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={roleId}>{text.joinRole}</Label>
        <NativeSelect id={roleId} value={role} onChange={event => setRole(event.target.value as SpaceRole)}>
          {[...SPACE_ROLES].reverse().map(value => <option key={value} value={value}>{messages.spaces.roleName(value)}</option>)}
        </NativeSelect>
      </div>
      {mutation.isError && (
        <Alert variant="destructive">
          <AlertDescription>{describeError(mutation.error).message}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" aria-disabled={mutation.isPending}>{messages.common.cancel}</Button>
        </DialogClose>
        <Button type="submit" aria-disabled={mutation.isPending || self === undefined}>{mutation.isPending ? messages.common.working : text.join}</Button>
      </DialogFooter>
    </form>
  )
}

export function JoinSpaceDialog({ space, onDone, onClose, returnFocus }: SpaceDialogProps) {
  return (
    <Dialog open={space !== undefined} onOpenChange={open => !open && onClose()}>
      {space !== undefined && (
        <DialogContent fallbackFocus={returnFocus}>
          <DialogHeader>
            <DialogTitle>{text.joinTitle(space.name)}</DialogTitle>
            <DialogDescription>{text.joinDescription}</DialogDescription>
          </DialogHeader>
          <JoinForm space={space} onDone={onDone} onClose={onClose} />
        </DialogContent>
      )}
    </Dialog>
  )
}
