// 复制与跨空间移动的目标候选（M2 Codex 评审复验的一般 1）：页面从导航的"我能看到的空间"得出、往下传给整理面板的选目标位置的表单。
import type { SpaceListResponse, SpaceView } from '@nerve-office/contracts'
import type { UseQueryResult } from '@tanstack/react-query'
import type { FirstLoadQuery } from '../../shared/lib/use-first-load-retry.ts'

/**
 * 我能新建内容的空间（服务端给的 canCreateDocuments），连同它们取到了没有。
 * 由页面从导航的"我能看到的空间"那一份缓存得出、往下传（targetSpacesOf；features/documents 不反向引用 features/spaces）。
 * 复制的目标据此说明"正在加载""没能加载（重试）""一个也没有"，不回落到不在候选里的空间（destination-form.tsx）
 */
export interface TargetSpaces {
  /** 取到的候选；还没取到、取不到时为 undefined */
  readonly items: readonly SpaceView[] | undefined
  /** 取不到时的错误；还没取过、正在取时为 null */
  readonly error: Error | null
  /** 再取一次 */
  readonly retry: () => void
  /** 取候选的那一份请求：没能加载、按了"重试"之后，说明与"重试"据此留着（shared/lib/use-first-load-retry.ts） */
  readonly request: FirstLoadQuery
}

/** 由导航的"我能看到的空间"（页面取的那一份查询）得出目标候选：能新建内容的那些，连同取到了没有 */
export function targetSpacesOf(spaces: Pick<UseQueryResult<SpaceListResponse>, 'data' | 'error' | 'refetch' | 'isPending' | 'isError' | 'isFetching' | 'errorUpdateCount'>): TargetSpaces {
  return {
    items: spaces.data?.items.filter(space => space.permissions.canCreateDocuments),
    error: spaces.error,
    retry: () => void spaces.refetch(),
    request: spaces,
  }
}
