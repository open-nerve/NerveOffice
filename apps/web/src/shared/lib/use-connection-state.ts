import type { ConnectionView } from './connection-state.ts'
import { useSyncExternalStore } from 'react'
import { messages } from '../i18n/index.ts'
import { connectionState } from './connection-state.ts'

export function useConnectionState(): ConnectionView {
  return useSyncExternalStore(connectionState.subscribe, connectionState.view)
}

/** 展示可传本次快照；执行操作时省略参数，读取最新事实，避免旧闭包放行。 */
export function connectionUnavailable(view = connectionState.view()): string | undefined {
  return view.available ? undefined : messages.common.connectionRequired
}
