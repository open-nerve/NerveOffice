// 按确定的写入结果直接改分页列表的缓存（Codex 对抗评审 CX4）：写操作成功之后的刷新有时限（shared/api/write-outcome.ts 的
// refreshAfterSuccess），到了时限还没回来时操作照常结束。界面要依赖刷新的结果才对的地方先改缓存——那一行先换成写入之后的样子、
// 或者先去掉（打开确认框的按钮随之不在，焦点交给 returnFocus），再在后台刷新；刷新回来之后以服务端为准。
import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query'

/** 一页：条目之外的字段（游标等）原样留着 */
interface Page<T> {
  readonly items: readonly T[]
}

/**
 * 按前缀匹配的每一份分页列表（useInfiniteQuery 的缓存，例如各种过滤条件下的账户列表）：每一页的每一条按 change 处理——
 * 返回新的条目就换上，返回 undefined 就去掉。还没有数据的不动
 */
export function updatePagedItems<T>(queryClient: QueryClient, queryKey: QueryKey, change: (item: T) => T | undefined): void {
  queryClient.setQueriesData<InfiniteData<Page<T>>>({ queryKey }, data => data === undefined
    ? undefined
    : {
        ...data,
        pages: data.pages.map(page => ({
          ...page,
          items: page.items.flatMap((item) => {
            const next = change(item)
            return next === undefined ? [] : [next]
          }),
        })),
      })
}
