import type { MutationMeta } from '@tanstack/react-query'
import { useMutation } from '@tanstack/react-query'
import { writeFailureText } from '../../shared/api/write-outcome.ts'
import { messages } from '../../shared/i18n/index.ts'
import { useOutcomeRefresh } from '../../shared/lib/use-outcome-refresh.ts'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../shared/ui/dialog.tsx'
import { Alert, AlertDescription, Button } from '../../shared/ui/index.ts'

export interface PendingConfirmation {
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  /** 危险的操作（停用、取消管理员、作废）用醒目的按钮 */
  readonly destructive?: boolean
  /** 确认之后执行；失败时弹窗留着，显示原因 */
  readonly run: () => Promise<void>
  /**
   * 这个操作改变的是哪些查询显示的状态，重新请求它们（M2-P6 复核第二批 G-2）：结果未知时弹窗先调用它（操作可能已经生效），
   * 页面随之是服务端现在的状态，再说明"可能已经生效"。必填：每个确认的操作都要说清楚，免得哪一处漏了、表格停在旧的状态。
   * 刷新失败时要拒绝（shared/lib/refresh-queries.ts 的 refreshQueries）：弹窗据此说明页面没能刷新，而不是说"已刷新"（第三批 G-a）。
   * 弹窗等它有时限（第三批 S-a，shared/api/write-outcome.ts）：一直不回来时到了时限就先说明，弹窗随之可以关掉
   */
  readonly refresh: () => Promise<unknown>
  /**
   * 结果未知之外也要按 refresh 刷新的失败（M2-P6 复核第四批）：之后的拒绝说明上一次多半已经生效，例如重新生成邀请的结果未知之后
   * 再点得到"已被占用"。同样在时限之内刷新，describeFailure 的 refreshed 同样是刷新好了没有
   */
  readonly refreshAfter?: (error: unknown) => boolean
  /** 打开弹窗的按钮随操作消失了（例如作废之后这一行没有"作废"）时，关闭之后焦点去哪里（审查 B9） */
  readonly returnFocus?: () => void
  /**
   * 失败的说明：不给时，结果未知说"可能已经生效"，其余按错误码（shared/api 的 writeFailureText）。结果未知时链接可能已经签发、
   * 文档可能已经转移（M2-P6 复核 S1：重新生成邀请、生成重置链接；第二批 G-3：转移），或者之后的拒绝其实说明上一次已经生效，
   * 由页面给出对应的引导。refreshed：结果未知之后页面刷新好了没有（refresh 失败或者到了时限为 false，第三批 G-a），
   * 说明里提到"已刷新"的要按它说
   */
  readonly describeFailure?: (error: unknown, refreshed: boolean) => string
}

interface ConfirmDialogProps {
  readonly pending: PendingConfirmation | undefined
  readonly onClose: () => void
  /** 执行时请求缓存的元数据：管理界面标明只给系统管理员（SYSTEM_ADMIN_ONLY） */
  readonly meta?: MutationMeta
}

/**
 * 危险操作的确认（M2-P1 设计 §3.8；M2-P2 起管理界面与成员页共用）：先说清楚后果，再执行。进行中不能重复提交，也不能关闭；
 * 失败时按错误码说明原因（例如"至少要保留一个有效的系统管理员"），弹窗留着可以取消。
 * 结果未知时（M2-P6 复核第二批 G-2）：操作可能已经生效，先按 refresh 刷新页面上的状态，再说明"可能已经生效"——停用、启用、
 * 改系统角色、解除锁定、归档与恢复、全员可见、作废邀请、移出成员、转移、永久删除都经这里，一处做完。
 * 刷新最多等 10 秒（第三批 S-a）：一直不回来时到了时限先给出说明，弹窗不再卡在"正在处理…"；刷新失败或者超时，说明页面没能刷新（第三批 G-a）。
 * 超时之后刷新在后台继续，回来了（表格随之更新）就把说明改回"已刷新"（第五批 G4，shared/lib/use-outcome-refresh.ts）。
 * refreshAfter 认出的失败（上一次多半已经生效）同样这样刷新（第四批）。
 * 执行经请求缓存：管理界面标明只给系统管理员，被拒绝时由全局处理重新确认会话，系统角色已被取消就切到无权限（审查 B4）。
 * 关闭之后焦点回到打开它的按钮；按钮已经不在了，交给 returnFocus，焦点不落到 body（审查 B9）。
 * 带着 Radix Dialog：只由按需加载的页面引用，不进首屏（ADR-008）。
 */
export function ConfirmDialog({ pending, onClose, meta }: ConfirmDialogProps) {
  /** 上一次失败是结果未知、而且页面已经刷新好了：说明据此说"已刷新"还是"没能刷新"（第三批 G-a）；晚到的刷新随后改过来（第五批 G4） */
  const { refreshed, refreshAfterFailure } = useOutcomeRefresh()
  const mutation = useMutation({
    mutationFn: async (confirmation: PendingConfirmation) => confirmation.run(),
    // 刷新完成（或者到了时限）之后才显示失败：说明与页面上的状态对得上（第二批 G-2，第三批 S-a）
    onError: async (error, confirmation) => {
      await refreshAfterFailure(error, confirmation.refresh, { also: confirmation.refreshAfter })
    },
    ...(meta === undefined ? {} : { meta }),
  })

  function close(): void {
    mutation.reset()
    onClose()
  }

  function confirm(): void {
    if (pending === undefined || mutation.isPending)
      return
    mutation.mutate(pending, { onSuccess: close })
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
              <AlertDescription>{pending.describeFailure?.(mutation.error, refreshed) ?? writeFailureText(mutation.error, refreshed)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" aria-disabled={mutation.isPending}>{messages.common.cancel}</Button>
            </DialogClose>
            <Button variant={pending.destructive === true ? 'destructive' : 'default'} aria-disabled={mutation.isPending} onClick={confirm}>
              {mutation.isPending ? messages.common.working : pending.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
