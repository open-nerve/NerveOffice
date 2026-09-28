// 取自 shadcn/ui 4.21.0 的 radix-nova 风格，按项目规范改写（ADR-008）。M2-P1 加入：危险操作的确认、一次性链接的显示。
// 焦点困在弹窗里、Esc 关闭由 Radix 处理；关闭按钮的读屏文字取自界面文字。
// 不经 shared/ui 的桶文件导出：Radix Dialog 约 12 KiB（gzip），只有按需加载的管理界面用它，用到的地方直接引用这个文件（M2-P1 审查 B2）。
import type { ComponentProps } from 'react'
import { XIcon } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useRef } from 'react'
import { messages } from '../i18n/index.ts'
import { cn } from '../lib/cn.ts'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

type DialogContentProps = ComponentProps<typeof DialogPrimitive.Content> & {
  /** 关闭之后，打开之前有焦点的元素已经不在了（例如随操作消失的按钮）或者不能聚焦时，焦点去哪里 */
  readonly fallbackFocus?: () => void
}

/**
 * 弹窗的内容。关闭之后焦点回到打开之前有焦点的元素：Radix 的模态弹窗只把焦点还给 DialogTrigger，
 * 由程序打开的弹窗（确认、签发的链接）没有它，焦点就落到 body（M2-P1 审查 B9）。使用方的 onCloseAutoFocus 先执行，阻止默认时不再处理。
 */
export function DialogContent({ className, children, onOpenAutoFocus, onCloseAutoFocus, fallbackFocus, ...props }: DialogContentProps) {
  const openerRef = useRef<HTMLElement | null>(null)

  function rememberOpener(event: Event): void {
    const active = document.activeElement
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null
    onOpenAutoFocus?.(event)
  }

  function restoreFocus(event: Event): void {
    onCloseAutoFocus?.(event)
    if (event.defaultPrevented)
      return
    const opener = openerRef.current
    if (opener !== null && opener.isConnected && !opener.matches(':disabled')) {
      event.preventDefault()
      opener.focus()
    }
    else if (fallbackFocus !== undefined) {
      event.preventDefault()
      fallbackFocus()
    }
  }

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-slot="dialog-overlay" className="fixed inset-0 z-50 bg-black/40" />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn('fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border bg-background p-6 shadow-lg outline-none sm:max-w-lg', className)}
        onOpenAutoFocus={rememberOpener}
        onCloseAutoFocus={restoreFocus}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute top-4 right-4 rounded-sm opacity-70 transition-opacity outline-none hover:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4">
          <XIcon aria-hidden />
          <span className="sr-only">{messages.common.close}</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-2 text-left', className)} {...props} />
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="dialog-footer" className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn('text-base leading-none font-medium', className)} {...props} />
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn('text-sm text-muted-foreground', className)} {...props} />
}
