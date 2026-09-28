import { useId, useState } from 'react'
import { messages } from '../../shared/i18n/index.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '../../shared/ui/index.ts'

export interface IssuedLink {
  readonly title: string
  /** 发给谁：登录名或显示名 */
  readonly recipient: string
  readonly url: string
  readonly expiresAt: string
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{`${link.title}：${link.recipient}`}</DialogTitle>
            <DialogDescription>{messages.admin.link.once}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={inputId}>{messages.admin.link.label}</Label>
            {/* 只读的输入框：可以全选、手动复制；点一下就选中全部 */}
            <Input id={inputId} readOnly value={link.url} onFocus={event => event.currentTarget.select()} />
            <p className="text-sm text-muted-foreground">{messages.admin.link.expiresAt(formatDateTime(link.expiresAt))}</p>
          </div>
          {copy === 'copied' && (
            <Alert>
              <AlertDescription>{messages.admin.link.copied}</AlertDescription>
            </Alert>
          )}
          {copy === 'failed' && (
            <Alert variant="destructive">
              <AlertDescription>{messages.admin.link.copyFailed}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button onClick={() => void copyLink()}>{messages.admin.link.copy}</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
