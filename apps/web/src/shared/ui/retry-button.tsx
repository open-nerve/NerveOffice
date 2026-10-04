// 第一次就没取到时的"重试"（shared/lib/use-first-load-retry.ts）：各处的加载失败说明共用，说法、状态与不重复请求的做法一致。
import { messages } from '../i18n/index.ts'
import { Button } from './button.tsx'

interface RetryButtonProps {
  /** 正在重试：按钮留着、不可用、说正在重试（规范 §2.4：进行中的操作的按钮不卸载） */
  readonly retrying: boolean
  /** 重新请求（refetch）：正在重试时再按，没有数据的请求交回在途的那一次，不重复请求 */
  readonly onRetry: () => void
  readonly className?: string
  /** 整页的说明里用默认大小，列表与面板里的用小号（默认） */
  readonly size?: 'sm' | 'default'
}

/**
 * "重试"：进行中用 aria-disabled 而不是 disabled（按钮变成 disabled 时浏览器把焦点丢到 body，M1 审查 B13），同时标为忙碌（aria-busy）。
 * type="button"：说明常常在表单里（选同事、选目标位置），不能顺带提交表单
 */
export function RetryButton({ retrying, onRetry, className, size = 'sm' }: RetryButtonProps) {
  return (
    <Button type="button" variant="outline" size={size} className={className} aria-disabled={retrying} aria-busy={retrying} onClick={onRetry}>
      {retrying ? messages.common.retrying : messages.common.retry}
    </Button>
  )
}
