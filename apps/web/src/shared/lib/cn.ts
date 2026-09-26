import type { ClassValue } from 'clsx'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 拼接类名；后面的 Tailwind 类覆盖前面冲突的（shadcn/ui 的约定）。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
