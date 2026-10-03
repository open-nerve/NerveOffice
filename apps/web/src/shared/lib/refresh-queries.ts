// 写操作之后重新请求显示它的查询（M2-P6 复核第三批 G-a；第五批 G6：先取消在路上的请求）。
import type { QueryClient, QueryKey } from '@tanstack/react-query'

export interface RefreshQueriesOptions {
  /**
   * 有一个没能刷新就拒绝（默认）：写操作的结果未知之后用（确认的弹窗等经 shared/api/write-outcome.ts 的 refreshIfUnknown 调用），
   * 刷新失败时页面还是之前的状态，说明里不能说"已刷新"。invalidateQueries 默认吞掉重新请求的失败，所以要明确带上。
   * 成功之后的刷新同样经 shared/api/write-outcome.ts（refreshAfterSuccess：有时限，失败不算这个操作失败，由列表自己说明没能刷新，
   * Codex 对抗评审 CX4、CX5），它接住拒绝。
   * 只在后台照常刷新、不等它也不计入的（void 调用，例如被拒绝之后顺带刷新文档详情与导航）传 false：拒绝了没人接住
   */
  readonly throwOnError?: boolean
}

/**
 * 重新请求这些查询（按前缀）：全部作废，正在显示的立即重新请求（invalidateQueries 的语义：没在显示的等下次显示时再请求，不白白请求）。
 *
 * 先取消在路上的请求（第五批 G6）：TanStack Query 重新请求时，已有数据的查询会取消在路上的那一次、重来，正在请求而还没有数据的
 * 却不会——直接沿用在路上的那一次。它在这次写操作生效之前就发出了，回来的是之前的状态：例如刚换了过滤条件、过滤的请求还在路上时
 * 创建成功，列表仍显示"没有符合条件的"。取消（cancelQueries 默认 revert）让它回到发出之前的状态，随后照常重新请求。
 * 全部前缀都取消完再统一重新请求：前缀有重叠时，后取消的不会把前面刚发出的新请求又取消掉
 */
export async function refreshQueries(queryClient: QueryClient, queryKeys: readonly QueryKey[], { throwOnError = true }: RefreshQueriesOptions = {}): Promise<void> {
  await Promise.all(queryKeys.map(async queryKey => queryClient.cancelQueries({ queryKey })))
  await Promise.all(queryKeys.map(async queryKey => queryClient.invalidateQueries({ queryKey }, { throwOnError })))
}
