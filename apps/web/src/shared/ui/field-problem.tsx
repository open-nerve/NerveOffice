// 输入不合法时的文字说明（WCAG 3.3.1，M2-P6 复核 S4）：只标 aria-invalid、按钮不可用，读屏与看的人都不知道为什么。
import { cn } from '../lib/cn.ts'

interface FieldProblemProps {
  /** 输入框与提交按钮经 aria-describedby 指向它 */
  readonly id: string
  /** 第一条不满足的规则（契约的结构里写好的说明）；为空时不显示 */
  readonly problem: string | undefined
  /** 还什么都没输入：只是说明规则，不用出错的样式 */
  readonly empty?: boolean
}

export function FieldProblem({ id, problem, empty = false }: FieldProblemProps) {
  if (problem === undefined)
    return null
  return <p id={id} className={cn('basis-full text-sm', empty ? 'text-muted-foreground' : 'text-destructive')}>{problem}</p>
}
