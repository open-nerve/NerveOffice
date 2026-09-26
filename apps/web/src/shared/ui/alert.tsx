// 取自 shadcn/ui 4.21.0 的 radix-nova 风格，按项目规范改写（ADR-008）。
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../lib/cn.ts'

const alertVariants = cva(
  'group/alert relative grid w-full gap-0.5 rounded-lg border px-2.5 py-2 text-left text-sm has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*=\'size-\'])]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        destructive: 'bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

/** 提示条。错误提示用 role="alert"（读屏软件会立即读出）；普通说明用 role="status"。 */
export function Alert({ className, variant, role, ...props }: ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role={role ?? (variant === 'destructive' ? 'alert' : 'status')}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

export function AlertTitle({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="alert-title" className={cn('font-medium group-has-[>svg]/alert:col-start-2', className)} {...props} />
}

export function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="alert-description" className={cn('text-sm text-balance text-muted-foreground md:text-pretty [&_p:not(:last-child)]:mb-4', className)} {...props} />
}
