// 第一次就没取到（没有数据）时的"重试"（规范 §2.4：进行中的操作的按钮不卸载，说明连同按钮消失时焦点交给一直在的元素）。
// 用到的地方：管理界面的分页表格、左侧导航的团队空间、搜索结果、空间页（页头、子文件夹、文档列表）、回收站页（页头、列表）、成员页、
// "与我共享"、转移页的账户、审计页与按关键词选一项的候选、分享对话框的授权列表、需要登录的外层路由（会话）、一次性链接的查看、
// 行内操作取的文档权限、复制的目标空间。"重试"本身是共用的 RetryButton（shared/ui/retry-button.tsx）。
// 留着旧数据的"没能刷新"是另一回事（shared/ui/refresh-problem.tsx）：那时请求失败了状态照旧是 error，说明本来就留到有结果。
import type { RefObject } from 'react'
import type { FocusHandOffHandlers } from './use-focus-hand-off.ts'
import { useState } from 'react'
import { useFocusHandOff } from './use-focus-hand-off.ts'

/** 用到的请求结果（TanStack Query）：useQuery 与 useInfiniteQuery 的结果都合用 */
export interface FirstLoadQuery {
  readonly data: unknown
  readonly error: unknown
  readonly isPending: boolean
  readonly isError: boolean
  readonly isFetching: boolean
  /** 这个请求失败过几次：换了请求键的是另一个请求，有自己的计数 */
  readonly errorUpdateCount: number
}

export interface FirstLoadRetryOptions {
  /**
   * 能不能重试：页面另有说明、重试也不会好的错误（例如 404 时说"空间不存在"、链接已经不能用、没有登录）返回 false。
   * 这时 failed 为假，页面按自己的说明显示；重试之后得到的是这种错误时，加载失败的说明连同"重试"一起消失，焦点同样交给 fallbackFocus。
   * 默认每一种错误都可以重试
   */
  readonly retryable?: (error: unknown) => boolean
  /**
   * 失败时不显示之前取到的数据，只给失败的说明与"重试"：按关键词查找的候选（同一个关键词之前找到过、这次重新查找失败了）、
   * 需要登录的外层路由（会话确认失败时整页说明）。有数据时同样按这里算——那时重新请求期间状态照旧是 error（TanStack Query 只在
   * 没有数据时把状态改回 pending、清掉 error）
   */
  readonly hidesDataOnError?: boolean
}

export interface FirstLoadRetry {
  /** 显示加载失败的说明：失败了（可以重试的那种），或者说明显示着、又在重新请求（说明与"重试"留着） */
  readonly failed: boolean
  /** 说明显示着、又在重新请求："重试"不可用、说正在重试，说明里不再给上一次的原因（没有数据时 TanStack Query 已经清掉了它） */
  readonly retrying: boolean
  /** 挂在说明的外层上：记下焦点在不在里面 */
  readonly focus: FocusHandOffHandlers
}

function anyError(): boolean {
  return true
}

/**
 * 第一次就没取到时的说明与"重试"。TanStack Query 在没有数据时重新请求，会把状态改回 pending、清掉 error：页面若按 isPending 显示
 * 骨架屏，说明连同刚按过的"重试"随之卸载，焦点落到 body，取到之后也没有人接（与 M3-P2 审查 A2 同一类）。所以说明显示着、又在请求时
 * （按了"重试"，或者别处让它重新请求）照旧显示说明，"重试"留着、不可用、说正在重试；取到之后说明连同"重试"一起消失，焦点交给
 * fallbackFocus（一直在的元素）；又失败了，说明换成新的原因，焦点还在"重试"上（同一个按钮）；得到页面另有说明的错误（retryable）
 * 同样交给 fallbackFocus。焦点不在说明里时不抢。
 * 只认这个组件里显示过的说明：重新挂上时缓存里留着的失败（例如离开再回来，TanStack Query 随即重新请求）、页面另有说明的错误之后的
 * 重新请求，照常是加载中——那时没有人按过"重试"，也说不上"正在重试"。
 * "重试"照旧调用 refetch：正在重试时再按，没有数据的请求交回在途的那一次（TanStack Query 只在有数据时才取消在途的、从头再来），不重复请求
 */
export function useFirstLoadRetry(query: FirstLoadQuery, fallbackFocus: RefObject<HTMLElement | null>, { retryable = anyError, hidesDataOnError = false }: FirstLoadRetryOptions = {}): FirstLoadRetry {
  const applies = query.data === undefined || hidesDataOnError
  // 失败过、又在请求：没有数据时状态改回了 pending（errorUpdateCount 记着失败过，换了请求键的另算）；有数据时状态照旧是 error
  const refetching = query.data === undefined ? query.isPending && query.errorUpdateCount > 0 : query.isError && query.isFetching
  // 上一次渲染时说明在不在（渲染中按上一次的结果调整状态，React 的写法：随即重新渲染，不经 effect 多渲染一轮）
  const [shown, setShown] = useState(false)
  const retrying = applies && refetching && shown
  const failed = retrying || (applies && query.isError && !refetching && retryable(query.error))
  if (failed !== shown)
    setShown(failed)
  const focus = useFocusHandOff(failed, fallbackFocus)
  return { failed, retrying, focus }
}
