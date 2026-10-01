// 写操作的结果未知之后重新请求显示它的查询（M2-P6 复核第三批 G-a）。
import type { QueryClient, QueryKey } from '@tanstack/react-query'

/**
 * 重新请求这些查询里正在显示的：全部成功才兑现，有一个失败就拒绝。写操作的结果未知之后用（确认的弹窗等经 shared/api/write-outcome.ts
 * 的 refreshIfUnknown 调用）：刷新失败时页面还是之前的状态，说明里不能说"已刷新"。invalidateQueries 默认吞掉重新请求的失败，这里带 throwOnError。
 * 成功之后的刷新不用它：那时刷新失败不算这个操作失败，列表自己显示加载失败
 */
export async function refreshQueries(queryClient: QueryClient, queryKeys: readonly QueryKey[]): Promise<void> {
  await Promise.all(queryKeys.map(async queryKey => queryClient.invalidateQueries({ queryKey }, { throwOnError: true })))
}
