// 写操作成功之后的刷新到了时限还在后台（Codex 对抗评审 CX4，shared/api/write-outcome.ts 的 refreshAfterSuccess）：
// 界面据此说列表还在刷新，有了结果（成功或失败）之后不再说（说明里的一句：shared/ui/still-refreshing.tsx；管理界面表格上方的一行）
import type { BackgroundRefresh } from '../api/write-outcome.ts'
import { useCallback, useSyncExternalStore } from 'react'

/** 不在后台刷新时的订阅：没有要通知的 */
function noSubscription(): () => void {
  return () => {}
}

/** 这次刷新还在后台进行：到了时限还没有结果，现在也还没有。没有在后台的刷新（undefined：在时限之内有了结果）时为 false */
export function useStillRefreshing(refresh: BackgroundRefresh | undefined): boolean {
  const subscribe = useCallback((listener: () => void) => refresh?.subscribe(listener) ?? noSubscription(), [refresh])
  return useSyncExternalStore(subscribe, () => refresh !== undefined && !refresh.settled())
}
