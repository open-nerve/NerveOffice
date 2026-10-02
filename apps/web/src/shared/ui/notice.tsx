// 做完一件事、或者操作被拒绝之后的说明（M2-P4 审查建议 1，M2-P6 复核 S2、S3）：空间页、页头与回收站页共用。
import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { messages } from '../i18n/index.ts'
import { Alert, AlertDescription } from './alert.tsx'
import { Button } from './button.tsx'

interface NoticeProps {
  readonly children: ReactNode
  /** 接着可以去哪里，例如"打开回收站"、"打开副本" */
  readonly action?: ReactNode
  /** 有它就显示"关闭" */
  readonly onClose?: () => void
  /** 这一条说明本身（每次一个新的对象）：换了一条就再接一次焦点 */
  readonly focusKey: unknown
  /** 被拒绝、出错时用醒目的样式（role="alert"），做完了的说明用普通的（role="status"） */
  readonly variant?: 'default' | 'destructive'
}

/**
 * 一条说明：那一行、那个按钮常常随之消失（移走了、删掉了、按新的权限不再显示），说明出现时接住焦点，不落到 body。
 * tabIndex -1：只能由程序聚焦，Tab 键不经过它。
 */
export function Notice({ children, action, onClose, focusKey, variant = 'default' }: NoticeProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [focusKey])
  return (
    <Alert ref={ref} tabIndex={-1} variant={variant} className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      <AlertDescription className="flex flex-wrap items-center gap-2">
        <span>{children}</span>
        {action}
        {onClose !== undefined && <Button variant="ghost" size="sm" onClick={onClose}>{messages.common.close}</Button>}
      </AlertDescription>
    </Alert>
  )
}
