import { startScenarioProxy } from './scenario-proxy.ts'

export async function startLocalSaveProxy(options: { readonly runId: string, readonly backendOrigin: string }) {
  const proxy = await startScenarioProxy({ ...options, purpose: 'local-save' })
  return {
    origin: proxy.origin,
    startUrl: proxy.startUrl,
    controlPath: proxy.controlPath,
    commandPath: proxy.commandPath,
    entryPath: proxy.entryPath,
    configure: (scenario: Parameters<typeof proxy.configure>[0]) => proxy.configure(scenario),
    arm: () => proxy.arm(),
    cutApi: () => proxy.cutApi(),
    network: proxy.network,
    evidence: proxy.evidence,
    close: proxy.close,
  }
}
