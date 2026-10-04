// 第一次就没取到（没有数据）时的"重试"（规范 §2.4：进行中的操作的按钮不卸载，说明连同按钮消失时焦点交给一直在的元素）：
// 管理界面的分页表格（features/admin/paged-table.tsx）与左侧导航的团队空间（features/spaces/space-nav.tsx）。
// 留着旧数据的"没能刷新"是另一回事（shared/ui/refresh-problem.tsx）：那时请求失败了状态照旧是 error，说明本来就留到有结果。
import type { RefObject } from 'react'
import type { FocusHandOffHandlers } from './use-focus-hand-off.ts'
import { useFocusHandOff } from './use-focus-hand-off.ts'

/** 用到的请求结果（TanStack Query）：useQuery 与 useInfiniteQuery 的结果都合用 */
export interface FirstLoadQuery {
  readonly data: unknown
  readonly isPending: boolean
  readonly isError: boolean
  /** 这个请求失败过几次：换了请求键的是另一个请求，有自己的计数 */
  readonly errorUpdateCount: number
}

export interface FirstLoadRetry {
  /** 显示加载失败的说明：失败了，或者失败之后正在重新请求（说明与"重试"留着） */
  readonly failed: boolean
  /** 失败之后正在重新请求："重试"不可用、说正在重试，说明里不再给上一次的原因（TanStack Query 已经清掉了它） */
  readonly retrying: boolean
  /** 挂在说明的外层上：记下焦点在不在里面 */
  readonly focus: FocusHandOffHandlers
}

/**
 * 第一次就没取到时的说明与"重试"。TanStack Query 在没有数据时重新请求，会把状态改回 pending、清掉 error：页面若按 isPending 显示
 * 骨架屏，说明连同刚按过的"重试"随之卸载，焦点落到 body，取到之后也没有人接（与 M3-P2 审查 A2 同一类）。所以失败过、又在请求时
 * （按了"重试"，或者别处让它重新请求）照旧显示说明，"重试"留着、不可用、说正在重试；取到之后说明连同"重试"一起消失，焦点交给
 * fallbackFocus（一直在的元素）；又失败了，说明换成新的原因，焦点还在"重试"上（同一个按钮）。
 * "重试"照旧调用 refetch：正在重试时再按，没有数据的请求交回在途的那一次（TanStack Query 只在有数据时才取消在途的、从头再来），不重复请求
 */
export function useFirstLoadRetry(query: FirstLoadQuery, fallbackFocus: RefObject<HTMLElement | null>): FirstLoadRetry {
  const retrying = query.data === undefined && query.isPending && query.errorUpdateCount > 0
  const failed = query.data === undefined && (query.isError || retrying)
  const focus = useFocusHandOff(failed, fallbackFocus)
  return { failed, retrying, focus }
}
