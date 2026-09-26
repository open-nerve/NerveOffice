// 取自 shadcn/ui 4.21.0 的 radix-nova 风格，按项目规范改写（ADR-008）。
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { Slot } from 'radix-ui'
import { cn } from '../lib/cn.ts'
import { buttonVariants } from './button-variants.ts'

export type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants> & {
  /** 把样式交给唯一的子元素（例如链接） */
  asChild?: boolean
}

export function Button({ className, variant = 'default', size = 'default', asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot.Root : 'button'
  return (
    <Component
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}
