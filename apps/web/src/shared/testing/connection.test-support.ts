import { connectionState } from '../lib/connection-state.ts'

/** 浏览器 online 只恢复尝试资格；测试也须用一次实际成功事实才能恢复操作。 */
export function restoreConnection(): void {
  connectionState.setBrowserOnline(true)
  connectionState.succeeded(connectionState.beginRequest())
}
