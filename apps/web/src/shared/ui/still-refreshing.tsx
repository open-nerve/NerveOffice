// 写操作成功之后的刷新到了时限还没回来（Codex 对抗评审 CX4，shared/api/write-outcome.ts 的 refreshAfterSuccess）：操作照常结束，
// 说明里说列表还在刷新；刷新有了结果（成功或失败）之后不再说——成功时列表随之更新，失败时列表自己说明没能刷新（refresh-problem.tsx，CX5）。
// 与失败之后"到了时限先说明页面没能刷新、晚到的刷新随后改过来"（shared/lib/use-outcome-refresh.ts）对应。按路径引用（不经桶文件）。
import type { BackgroundRefresh } from '../api/write-outcome.ts'
import { messages } from '../i18n/index.ts'
import { useStillRefreshing } from '../lib/use-still-refreshing.ts'

interface StillRefreshingProps {
  readonly refresh: BackgroundRefresh | undefined
  /** 刷新的是什么（默认"列表"） */
  readonly list?: string
  /** 前面的说明已经是完整的一句（以句号结尾，例如"上一次其实已经完成……"）：另起一句，不接分号 */
  readonly sentence?: boolean
}

/**
 * 接在做完一件事的说明后面，同一句话（分号隔开）："已取消分享给…；列表还在刷新，…"；前面已经是完整的一句时另起一句。
 * 刷新有了结果之后什么也不显示，说明回到原样。说明写进去的时机照旧（确认框里做完的，等它关掉之后才写，ConfirmDialog 的 AfterConfirmed）：
 * 这一句随说明一起写进去
 */
export function StillRefreshing({ refresh, list, sentence = false }: StillRefreshingProps) {
  const refreshing = useStillRefreshing(refresh)
  if (!refreshing)
    return null
  const note = messages.common.stillRefreshing(list)
  return sentence ? `${note}。` : `；${note}`
}
