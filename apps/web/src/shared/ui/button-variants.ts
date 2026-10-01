// 取自 shadcn/ui 4.21.0 的 radix-nova 风格，按项目规范改写（ADR-008）。单独成文件：链接等非按钮元素也要用按钮的样式。
// 与生成结果的差别：aria-disabled 的按钮与 disabled 的一样变淡。操作进行中的按钮用 aria-disabled，焦点不会丢（审查 B13）。
// 图标的默认尺寸（没有自己写 size-* 的图标，按钮 16px、小按钮 14px）的选择器写成不带引号的 [class*=size-]（M2-P6 复核第四批）：
// 生成结果在双引号的字符串里写 [class*='size-']，改成单引号的字符串之后要转义成 \'，而 Tailwind 扫描的是源码，连反斜杠一起读进去，
// 生成的规则永远匹配不上，按钮里的图标都是 lucide 默认的 24px。E2E（documents/document-list.spec.ts）按实际的尺寸检查
import { cva } from 'class-variance-authority'
import { cn } from '../lib/cn.ts'

const variants = cva(
  'group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/80',
        outline: 'border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost: 'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
        destructive: 'bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        sm: 'h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*=size-])]:size-3.5',
        lg: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        icon: 'size-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

/**
 * 按钮的样式：Button 与做成按钮样子的链接共用，经 tailwind-merge（cn）合并之后给出（M2-P6 复核第四批）。尺寸的类与基础的类有冲突
 * （小按钮的图标 14px 与默认的 16px、小按钮的圆角），不合并时两条规则同时在，谁生效看生成的 CSS 里谁在后面：Button 原来自己合并，
 * 直接用这里的链接（页头的"修改密码"、编辑器页的"返回"、管理界面的"成员"）却是 16px 的图标与默认的圆角
 */
export function buttonVariants(props?: Parameters<typeof variants>[0]): string {
  return cn(variants(props))
}
