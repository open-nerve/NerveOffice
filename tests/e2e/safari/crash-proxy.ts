// 保留旧崩溃驱动 API、8 KiB 控制上限与重启后续发入口规则。
import { startScenarioProxy } from './scenario-proxy.ts'

export async function startCrashProxy(options: { readonly runId: string, readonly backendOrigin: string }) {
  return startScenarioProxy({ ...options, purpose: 'crash' })
}
