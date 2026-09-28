import { useMutation } from '@tanstack/react-query'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../shared/ui/dialog.tsx'
import { Alert, AlertDescription, Button } from '../../shared/ui/index.ts'
import { SYSTEM_ADMIN_ONLY } from '../auth/index.ts'

export interface PendingConfirmation {
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  /** 危险的操作（停用、取消管理员、作废）用醒目的按钮 */
  readonly destructive?: boolean
  /** 确认之后执行；失败时弹窗留着，显示原因 */
  readonly run: () => Promise<void>
  /** 打开弹窗的按钮随操作消失了（例如作废之后这一行没有"作废"）时，关闭之后焦点去哪里（审查 B9） */
  readonly returnFocus?: () => void
}

/**
 * 危险操作的确认（M2-P1 设计 §3.8）：先说清楚后果，再执行。进行中不能重复提交，也不能关闭；
 * 失败时按错误码说明原因（例如"至少要保留一个有效的系统管理员"），弹窗留着可以取消。
 * 执行经请求缓存，标明只给系统管理员：被拒绝时由全局处理重新确认会话，系统角色已被取消就切到无权限（审查 B4）。
 * 关闭之后焦点回到打开它的按钮；按钮已经不在了，交给 returnFocus，焦点不落到 body（审查 B9）。
 */
export function ConfirmDialog({ pending, onClose }: { readonly pending: PendingConfirmation | undefined, readonly onClose: () => void }) {
  const mutation = useMutation({ mutationFn: async (run: () => Promise<void>) => run(), meta: SYSTEM_ADMIN_ONLY })

  function close(): void {
    mutation.reset()
    onClose()
  }

  function confirm(): void {
    if (pending === undefined || mutation.isPending)
      return
    mutation.mutate(pending.run, { onSuccess: close })
  }

  function changeOpen(open: boolean): void {
    if (!open && !mutation.isPending)
      close()
  }

  return (
    <Dialog open={pending !== undefined} onOpenChange={changeOpen}>
      {pending !== undefined && (
        <DialogContent fallbackFocus={pending.returnFocus}>
          <DialogHeader>
            <DialogTitle>{pending.title}</DialogTitle>
            <DialogDescription>{pending.description}</DialogDescription>
          </DialogHeader>
          {mutation.isError && (
            <Alert variant="destructive">
              <AlertDescription>{describeError(mutation.error).message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" aria-disabled={mutation.isPending}>{messages.common.cancel}</Button>
            </DialogClose>
            <Button variant={pending.destructive === true ? 'destructive' : 'default'} aria-disabled={mutation.isPending} onClick={confirm}>
              {mutation.isPending ? messages.admin.working : pending.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
