import type { MutationMeta } from '@tanstack/react-query'
import { useMutation } from '@tanstack/react-query'
import { useRef } from 'react'
import { writeFailureText } from '../../shared/api/write-outcome.ts'
import { messages } from '../../shared/i18n/index.ts'
import { useOutcomeRefresh } from '../../shared/lib/use-outcome-refresh.ts'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../shared/ui/dialog.tsx'
import { Alert, AlertDescription, Button } from '../../shared/ui/index.ts'

/**
 * 确认的操作成功之后、弹窗关掉之后才做的事：往页面的状态区写说明、显示说明条这一类（M2-P5 复验 S1）。
 * 弹窗开着时 Radix 把弹窗之外的内容都标为 aria-hidden（只跳过打开那一刻已经在的、显式写了 aria-live 的元素，状态区不在此列）：
 * 这时写进状态区的说明，写进去的那一刻在 aria-hidden 之下，读屏多半不播报；
 * 弹窗关掉之后文字不再变化，也不会补播。所以 run 不直接写，把要做的交回来，由弹窗在关掉、aria-hidden 解除、焦点交还之后执行
 */
export type AfterConfirmed = () => void

export interface PendingConfirmation {
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  /** 危险的操作（停用、取消管理员、作废）用醒目的按钮 */
  readonly destructive?: boolean
  /**
   * 确认之后执行；失败时弹窗留着，显示原因。成功之后要告诉用户的（往页面的状态区写说明、显示说明条、在按钮旁说明）不在这里直接写：
   * 作为返回值交回来（AfterConfirmed），弹窗关掉、aria-hidden 解除、焦点交还之后才执行（M2-P5 复验 S1）。
   * 失败的说明照旧在弹窗里（role="alert"）。
   * 约定：run 自己换成别的模态弹窗（例如签发链接的弹窗：先关掉这个确认的弹窗，再打开那个）时不交回说明，结果由那个弹窗自己说明
   * （生成重置链接、重新生成邀请就是这样）。交回的话，确认的弹窗已经关掉、交回的事随即执行，那一刻页面在新弹窗的 aria-hidden 之下、
   * 焦点在新弹窗里，写进去的读屏多半不播报（M2-P5 复验第二轮 S2）。
   * 约定：run 自己关掉弹窗的，放在最后一次 await 之后（关掉之后不再等别的）：页面上的确认共用这一个弹窗的执行状态，关掉之后还在等的话，
   * 这期间打开的别的确认会显示"正在处理…"、关不掉，之后的失败也会带到下一次打开的弹窗里（第三批修复时发现，现有的流程都是最后才关）
   */
  readonly run: () => Promise<AfterConfirmed | void>
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
 * 危险操作的确认（M2-P1 设计 §3.8；M2-P2 起管理界面与成员页共用）：先说清楚后果，再执行。进行中（从点确认的那一刻起，M2-P5 复验第二轮 G3）
 * 不能重复提交，也不能关闭；
 * 失败时按错误码说明原因（例如"至少要保留一个有效的系统管理员"），弹窗留着可以取消。
 * 结果未知时（M2-P6 复核第二批 G-2）：操作可能已经生效，先按 refresh 刷新页面上的状态，再说明"可能已经生效"——停用、启用、
 * 改系统角色、解除锁定、归档与恢复、全员可见、作废邀请、移出成员、转移、永久删除都经这里，一处做完。
 * 刷新最多等 10 秒（第三批 S-a）：一直不回来时到了时限先给出说明，弹窗不再卡在"正在处理…"；刷新失败或者超时，说明页面没能刷新（第三批 G-a）。
 * 超时之后刷新在后台继续，回来了（表格随之更新）就把说明改回"已刷新"（第五批 G4，shared/lib/use-outcome-refresh.ts）。
 * refreshAfter 认出的失败（上一次多半已经生效）同样这样刷新（第四批）。
 * 执行经请求缓存：管理界面标明只给系统管理员，被拒绝时由全局处理重新确认会话，系统角色已被取消就切到无权限（审查 B4）。
 * 关闭之后焦点回到打开它的按钮；按钮已经不在了，交给 returnFocus，焦点不落到 body（审查 B9）。
 * 成功之后要告诉用户的由 run 交回（AfterConfirmed），等弹窗关掉、aria-hidden 解除、焦点交还之后才执行（M2-P5 复验 S1）：
 * 取消分享、转移、移出成员、永久删除这些流程都经这里，一处做完。打开它的按钮会随操作消失的，要给 returnFocus（审查 B9）：
 * 不给的话焦点落在 body，交回的说明也就不是在焦点交还之后写的（M2-P5 复验第二轮 G6）。
 * 带着 Radix Dialog：只由按需加载的页面引用，不进首屏（ADR-008）。
 */
export function ConfirmDialog({ pending, onClose, meta }: ConfirmDialogProps) {
  /** 上一次失败是结果未知、而且页面已经刷新好了：说明据此说"已刷新"还是"没能刷新"（第三批 G-a）；晚到的刷新随后改过来（第五批 G4） */
  const { refreshed, refreshAfterFailure } = useOutcomeRefresh()
  /** run 交回的、等弹窗关掉之后才做的事（M2-P5 复验 S1）：弹窗关掉时（closed）执行并清掉 */
  const afterClosedRef = useRef<AfterConfirmed>(undefined)
  /**
   * 确认之后弹窗已经关掉了：run 自己先关掉了弹窗（没有换成别的模态弹窗，这时 aria-hidden 已经解除、焦点已经交还）、之后才成功时，
   * 交回的事随即执行，不留到下一次关掉（那时执行就是在别的弹窗关掉时说上一次的事）。每次确认时重新记为没关。
   * run 换成别的模态弹窗的不交回说明（见 PendingConfirmation.run，M2-P5 复验第二轮 S2）
   */
  const closedRef = useRef(false)
  /**
   * 确认之后、结果出来之前（M2-P5 复验第二轮 G3）：确认时同步记下，confirm() 的防重复与 changeOpen 的防关闭都读它；
   * 界面上的不可用样式照旧按 mutation.isPending。mutation.isPending 要等请求缓存的通知（setTimeout）之后重新渲染才变：
   * 点确认之后、重新渲染之前（同一个任务里）按 Esc、点外面或取消，读到的还是没在进行——弹窗关掉、观察者被 reset，操作照常完成，
   * 交回的事却丢了；这时再点一次确认，run 会执行两次。清掉的时机：
   * - 成功：在 close() 之前（mutate 的 onSuccess；之后的关掉、执行交回的事出了错，也不会把标记留下）；
   * - 失败：失败显示出来时（mutate 的 onError）。结果未知时 useMutation 级的 onError 先等刷新、最长到时限，这期间仍是进行中、
   *   关不掉（与 isPending 一致）；到了时限说明出来、随即清掉，取消关得掉；
   * - run 自己先关掉了弹窗：同样在结果出来时清掉，这期间没有弹窗可关；
   * - 组件卸下：标记随组件一起丢掉，不用清。
   * 组件在时观察者一直挂在这次操作上（进行中不 reset、不再 mutate），结果总会以成功或失败二者之一通知到（回调本身出错也一样），
   * 标记不会一直留着、弹窗不会再也关不掉
   */
  const confirmingRef = useRef(false)
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
    if (pending === undefined || confirmingRef.current)
      return
    confirmingRef.current = true
    closedRef.current = false
    mutation.mutate(pending, {
      onSuccess: (afterConfirmed) => {
        confirmingRef.current = false
        close()
        if (typeof afterConfirmed !== 'function')
          return
        if (closedRef.current)
          afterConfirmed()
        else
          afterClosedRef.current = afterConfirmed
      },
      onError: () => {
        confirmingRef.current = false
      },
    })
  }

  /** 弹窗关掉、aria-hidden 解除、焦点交还之后（DialogContent 的 onClosed）：执行 run 交回的事 */
  function closed(): void {
    closedRef.current = true
    const afterConfirmed = afterClosedRef.current
    afterClosedRef.current = undefined
    afterConfirmed?.()
  }

  function changeOpen(open: boolean): void {
    if (!open && !confirmingRef.current)
      close()
  }

  return (
    <Dialog open={pending !== undefined} onOpenChange={changeOpen}>
      {pending !== undefined && (
        <DialogContent fallbackFocus={pending.returnFocus} onClosed={closed}>
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
