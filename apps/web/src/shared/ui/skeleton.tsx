// 取自 shadcn/ui 4.21.0 的 radix-nova 风格，按项目规范改写（ADR-008）。
import type { ComponentProps } from 'react'
import { cn } from '../lib/cn.ts'

/**
 * 骨架屏本身对读屏软件不可见（aria-hidden）。"正在加载…"的状态写在包住它的容器上（role="status" 加可读名称）：
 * 写在它自己身上会随 aria-hidden 一起被藏起来，读屏读不出来（M2-P6 复核 S4），所以不接受 role 与 aria-label
 */
export function Skeleton({ className, ...props }: Omit<ComponentProps<'div'>, 'role' | 'aria-label' | 'aria-labelledby'>) {
  return <div data-slot="skeleton" aria-hidden="true" className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />
}
