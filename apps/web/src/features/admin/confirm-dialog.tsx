import { useState } from 'react'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { Alert, AlertDescription, Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../shared/ui/index.ts'

export interface PendingConfirmation {
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  /** 危险的操作（停用、取消管理员、作废）用醒目的按钮 */
  readonly destructive?: boolean
  /** 确认之后执行；失败时弹窗留着，显示原因 */
  readonly run: () => Promise<void>
}

/**
 * 危险操作的确认（M2-P1 设计 §3.8）：先说清楚后果，再执行。进行中不能重复提交，也不能关闭；
 * 失败时按错误码说明原因（例如"至少要保留一个有效的系统管理员"），弹窗留着可以取消。
 */
export function ConfirmDialog({ pending, onClose }: { readonly pending: PendingConfirmation | undefined, readonly onClose: () => void }) {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string>()

  async function confirm(): Promise<void> {
    if (pending === undefined || running)
      return
    setRunning(true)
    setError(undefined)
    try {
      await pending.run()
      onClose()
    }
    catch (caught) {
      setError(describeError(caught).message)
    }
    finally {
      setRunning(false)
    }
  }

  function changeOpen(open: boolean): void {
    if (!open && !running) {
      setError(undefined)
      onClose()
    }
  }

  return (
    <Dialog open={pending !== undefined} onOpenChange={changeOpen}>
      {pending !== undefined && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending.title}</DialogTitle>
            <DialogDescription>{pending.description}</DialogDescription>
          </DialogHeader>
          {error !== undefined && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" aria-disabled={running}>{messages.common.cancel}</Button>
            </DialogClose>
            <Button variant={pending.destructive === true ? 'destructive' : 'default'} aria-disabled={running} onClick={() => void confirm()}>
              {running ? messages.admin.working : pending.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
