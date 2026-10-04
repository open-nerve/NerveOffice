// 页面开头的元素（M3-P2 收尾）：需要登录的外层路由（require-session.tsx）经 Outlet 把它交给下一层的页面框架（app/layout 的 AppShell）。
import type { RefObject } from 'react'
import { useOutletContext } from 'react-router'

/** 页面开头的元素：页面框架把它挂在页头的产品名称上 */
export type PageStartRef = RefObject<HTMLAnchorElement | null>

/**
 * 页面开头的元素（页头里的产品名称）挂上它：会话确认失败、按"重试"确认之后，整页的说明连同"重试"一起换成页面，
 * 焦点交给这个一直在的页头开头，不落到 body（规范 §2.4）。不在需要登录的外层路由之下时为 undefined
 */
export function usePageStartRef(): PageStartRef | undefined {
  return useOutletContext<PageStartRef | undefined>()
}
