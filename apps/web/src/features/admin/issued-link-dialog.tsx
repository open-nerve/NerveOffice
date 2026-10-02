import { useId, useState } from 'react'
import { adminMessages } from '../../shared/i18n/zh-cn/admin.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../shared/ui/dialog.tsx'
import { Alert, AlertDescription, Button, Input, Label, PersonName, Phrase } from '../../shared/ui/index.ts'

export interface IssuedLink {
  readonly title: string
  /** 发给谁：显示名与登录名分开呈现（M2-P6 复核 M2） */
  readonly recipient: { readonly displayName: string, readonly username: string }
  readonly url: string
  readonly expiresAt: string
  /** 另外的说明（例如给自己生成的重置链接：关闭之后回到登录页） */
  readonly note?: string
  /**
   * 关闭之后焦点去哪里（审查 B9）：弹窗由程序打开（签发成功、确认之后），打开之前的焦点没有意义，
   * 例如签发表单回到登录名、行里的重新生成回到新的那一行
   */
  readonly returnFocus: () => void
}

/**
 * 一次性链接只显示这一次（M2-P1 设计 §3.4、§3.8）：签发之后弹出，带复制按钮与"经受控的渠道发给本人"的提示；
 * 关闭之后再也取不到（服务端只存摘要）。
 */
export function IssuedLinkDialog({ link, onClose }: { readonly link: IssuedLink | undefined, readonly onClose: () => void }) {
  const [copy, setCopy] = useState<'copied' | 'failed'>()
  const inputId = useId()

  async function copyLink(): Promise<void> {
    if (link === undefined)
      return
    try {
      await navigator.clipboard.writeText(link.url)
      setCopy('copied')
    }
    catch {
      setCopy('failed')
    }
  }

  function changeOpen(open: boolean): void {
    if (!open) {
      setCopy(undefined)
      onClose()
    }
  }

  return (
    <Dialog open={link !== undefined} onOpenChange={changeOpen}>
      {link !== undefined && (
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            link.returnFocus()
          }}
        >
          <DialogHeader>
            <DialogTitle><Phrase parts={adminMessages.link.title(link.title, <PersonName person={link.recipient} />)} /></DialogTitle>
            <DialogDescription>{adminMessages.link.once}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={inputId}>{adminMessages.link.label}</Label>
            {/* 只读的输入框：可以全选、手动复制；点一下就选中全部 */}
            <Input id={inputId} readOnly value={link.url} onFocus={event => event.currentTarget.select()} />
            <p className="text-sm text-muted-foreground">{adminMessages.link.expiresAt(formatDateTime(link.expiresAt))}</p>
            {link.note !== undefined && <p className="text-sm font-medium">{link.note}</p>}
          </div>
          {copy === 'copied' && (
            <Alert>
              <AlertDescription>{adminMessages.link.copied}</AlertDescription>
            </Alert>
          )}
          {copy === 'failed' && (
            <Alert variant="destructive">
              <AlertDescription>{adminMessages.link.copyFailed}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button onClick={() => void copyLink()}>{adminMessages.link.copy}</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
