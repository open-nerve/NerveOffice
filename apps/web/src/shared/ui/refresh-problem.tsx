// 列表留着之前的数据、重新请求却失败了（Codex 对抗评审 CX5）：TanStack Query 刷新失败时保留上一次的数据，界面照旧显示旧的内容；
// 原来只有"第一次就没取到"有失败的说明与重试（例如分享的授权列表），刷新失败时看不出列表已经过时，也没有重试。
// 各个列表共用这一处，不逐个列表各写一遍：明说"…没能刷新"与原因、给一个重试，旧的内容照常留着显示。
// 第一次就没取到（没有数据）仍由各列表自己的"加载失败"说明；加载下一页失败不在这里（isRefetchError 不含它，各列表另有说明）；
// 按访问权限被拒绝（403、404）由各列表先处理（例如换成"空间不存在"），不走到这里。按路径引用（不经桶文件）。
import { describeError } from '../api/describe-error.ts'
import { messages } from '../i18n/index.ts'
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
  /** 列表叫什么（默认"列表"），例如"成员列表"、"分享的情况" */
  readonly list?: string
  readonly className?: string
}

/** 留着旧数据、刷新失败了：醒目的提示（role="alert"，出现时读屏读出）、原因与重试；重试成功之后随之消失 */
export function RefreshProblem({ query, list, className }: RefreshProblemProps) {
  if (!query.isRefetchError)
    return null
  return (
    <Alert variant="destructive" className={className}>
      <AlertDescription>
        <p>{messages.common.refreshFailed(list)}</p>
        <p>{describeError(query.error).message}</p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}>{messages.common.retry}</Button>
      </AlertDescription>
    </Alert>
  )
}
