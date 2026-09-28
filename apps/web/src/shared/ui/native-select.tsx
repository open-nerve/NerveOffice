// 原生的下拉选择，样式与 Input 一致（M2-P1）：选项少、不需要搜索时用它，键盘、读屏与移动端都是浏览器自带的行为。
import type { ComponentProps } from 'react'
import { cn } from '../lib/cn.ts'

export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        className,
      )}
      {...props}
    />
  )
}
