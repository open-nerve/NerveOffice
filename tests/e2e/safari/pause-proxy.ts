// 暂停页面保持在原标签页用 POST 交回完整报告；没有崩溃后的重新登录入口。
import { startScenarioProxy } from './scenario-proxy.ts'

export async function startPauseProxy(options: { readonly runId: string, readonly backendOrigin: string }) {
  const proxy = await startScenarioProxy({ ...options, purpose: 'pause' })
  return {
    origin: proxy.origin,
    startUrl: proxy.startUrl,
    controlPath: proxy.controlPath,
    entryPath: proxy.entryPath,
    commandPath: proxy.commandPath,
    configure: (scenario: Parameters<typeof proxy.configure>[0]) => proxy.configure(scenario),
    arm: () => proxy.arm(),
    observe: () => proxy.observeRecovery(),
    evidence: () => proxy.evidence(),
    close: async () => proxy.close(),
  }
}
