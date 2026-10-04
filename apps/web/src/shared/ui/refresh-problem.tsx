// 列表留着之前的数据、重新请求却失败了（Codex 对抗评审 CX5）：TanStack Query 刷新失败时保留上一次的数据，界面照旧显示旧的内容；
// 原来只有"第一次就没取到"有失败的说明与重试（例如分享的授权列表），刷新失败时看不出列表已经过时，也没有重试。
// 各个列表共用这一处，不逐个列表各写一遍：明说"…没能刷新"与原因、给一个重试，旧的内容照常留着显示。
// 第一次就没取到（没有数据）仍由各列表自己的"加载失败"说明；加载下一页失败不在这里（isRefetchError 不含它，各列表另有说明）；
// 按访问权限被拒绝（403、404）由各列表先处理（例如换成"空间不存在"），不走到这里。按路径引用（不经桶文件）。
// 详情（页头的空间与账户、行内操作取的文档权限）同一个说明，经 DetailRefreshProblem（DEF-040）。
import type { RefObject } from 'react'
import { isAccessDenied, isMissingResource } from '../api/client.ts'
import { describeError } from '../api/describe-error.ts'
import { messages } from '../i18n/index.ts'
import { useFocusHandOff } from '../lib/use-focus-hand-off.ts'
import { Alert, AlertDescription } from './alert.tsx'
import { Button } from './button.tsx'

/** 列表的请求：用到 TanStack Query 结果里的这几项，useQuery 与 useInfiniteQuery 的结果都合用 */
export interface RefreshableQuery {
  /** 有数据、重新请求失败了（无限列表不含加载下一页的失败：TanStack Query 另算 isFetchNextPageError） */
  readonly isRefetchError: boolean
  readonly error: unknown
  readonly refetch: () => Promise<unknown>
}

interface RefreshProblemProps {
  readonly query: RefreshableQuery
  /** 列表叫什么（默认"列表"），例如"成员列表"、"分享的情况"；详情是它的名称，例如"空间信息" */
  readonly list?: string
  readonly className?: string
  /**
   * 说明消失时（重试成功了，或者别处的刷新成功了）焦点还在它里面（刚按过"重试"）：交给这个一直在的元素，不落到 body（规范 §2.4）。
   * 不给时由页面自己接住（useFocusRescue 交给页面的标题）
   */
  readonly fallbackFocus?: RefObject<HTMLElement | null>
}

/**
 * 留着旧数据、刷新失败了：醒目的提示（role="alert"，出现时读屏读出）、原因与重试；重试成功之后随之消失。
 * 说明连同"重试"一起消失时焦点交给 fallbackFocus，不落到 body（shared/lib/use-focus-hand-off.ts，DEF-040）
 */
export function RefreshProblem({ query, list, className, fallbackFocus }: RefreshProblemProps) {
  const focus = useFocusHandOff(query.isRefetchError, fallbackFocus)
  if (!query.isRefetchError)
    return null
  return (
    <Alert variant="destructive" className={className} onFocus={focus.onFocus} onBlur={focus.onBlur}>
      <AlertDescription>
        <p>{messages.common.refreshFailed(list)}</p>
        <p>{describeError(query.error).message}</p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}>{messages.common.retry}</Button>
      </AlertDescription>
    </Alert>
  )
}

interface DetailRefreshProblemProps {
  /** 详情的请求（useQuery 的结果，或者按同样的意思拼出来的） */
  readonly query: RefreshableQuery
  /** 详情叫什么，例如"空间信息"："空间信息没能刷新，显示的还是之前的内容" */
  readonly detail: string
  readonly className?: string
  /** 重试成功、说明随之消失时焦点交给谁（通常是页面的标题；行内的操作面板是面板里的"取消"） */
  readonly fallbackFocus: RefObject<HTMLElement | null>
}

/**
 * 详情留着上一次的数据、重新请求却失败了（DEF-040）：空间页与回收站页的页头、成员页（成员表与空间信息同一个请求）、
 * 转移页的账户、面包屑、行内操作展开时取的文档权限。说法、原因与重试与列表相同（RefreshProblem）。
 * 与列表不同的一点：详情决定页面的访问状态，按访问权限被拒绝（403，以及看不到、不存在的 404 与地址里的 id 不合法的 400）时
 * 页面按现在的做法说明——空间不存在、不能查看成员、账户不存在、回到列表；那不是"没能刷新"，重试也不会好，说成没能刷新还会盖住页面该给的说明。
 * 页面先处理这几种的这里本来就走不到；没有先处理的（例如操作面板留着之前的权限，等下一次操作被拒绝时再说明）也不会说成没能刷新。
 * 第一次就没取到（没有数据）照旧由各页面自己的"加载失败"说明。
 */
export function DetailRefreshProblem({ query, detail, className, fallbackFocus }: DetailRefreshProblemProps) {
  const failed = query.isRefetchError && !isAccessDenied(query.error) && !isMissingResource(query.error)
  return (
    <RefreshProblem
      query={{ isRefetchError: failed, error: query.error, refetch: query.refetch }}
      list={detail}
      className={className}
      fallbackFocus={fallbackFocus}
    />
  )
}
