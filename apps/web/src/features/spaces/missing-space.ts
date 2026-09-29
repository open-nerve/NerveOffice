import type { QueryClient } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { spaceDocumentsQueryKey } from '../documents/index.ts'
import { membersQueryOptions, spaceQueryOptions, spacesQueryOptions } from './spaces-api.ts'

/**
 * 去掉一个空间在请求缓存里的内容（页头、成员、文档列表）：下次打开从加载开始，不先显示旧的内容。
 * 默认只去掉没有页面在用的：正在显示的查询被去掉，它的页面一重新渲染就会再请求（留给离开时再去掉）。
 * 马上要离开正在显示它的页面时（leaving，例如移出了自己之后回到首页），连同正在显示的一起去掉：不等页面卸载，免得与路由切换抢先后。
 */
export function forgetSpace(queryClient: QueryClient, spaceId: string, options: { readonly leaving?: boolean } = {}): void {
  for (const queryKey of [spaceQueryOptions(spaceId).queryKey, membersQueryOptions(spaceId).queryKey, spaceDocumentsQueryKey(spaceId)])
    queryClient.removeQueries({ queryKey, exact: true, type: options.leaving === true ? 'all' : 'inactive' })
}

/**
 * 空间看不到了（请求得到 404：被移出、取消了全员可见，或者本来就不存在）时由空间页与成员页调用（M2-P2 审查 B1）：
 * - 导航列表随之重新请求，被移出的空间从导航里消失；
 * - 这个空间的页头、成员与文档列表的缓存去掉，下次进来不先闪出旧的内容（例如成员页里还能管理的控件）；
 *   正在显示的那一个（页头或成员）在离开时去掉。
 * 在 effect 里做，不在渲染时改缓存。
 */
export function useForgetMissingSpace(spaceId: string, missing: boolean): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!missing)
      return undefined
    void queryClient.invalidateQueries({ queryKey: spacesQueryOptions().queryKey })
    forgetSpace(queryClient, spaceId)
    return () => forgetSpace(queryClient, spaceId)
  }, [queryClient, spaceId, missing])
}
