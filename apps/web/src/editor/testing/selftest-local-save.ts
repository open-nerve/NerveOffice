import type { LocalSaveConfig, LocalSaveSample } from './local-save-report.ts'
import type { SelftestReport } from './selftest-report.ts'
import type { Session } from './selftest-session.ts'
import { runLocalSaveMeasurement } from './selftest-local-save-run.ts'
import { observeSelftestWrites } from './selftest-persistence.ts'

export interface LocalSaveSelftest {
  readonly config: LocalSaveConfig
  readonly run: (session: Session) => Promise<void>
  readonly report: (report: SelftestReport) => Promise<void>
  readonly dispose: () => void
}

export function localSaveControlFrom(href: string): { readonly endpoint: string, readonly runId: string, readonly network: 'online' | 'offline' } | undefined {
  try {
    const page = new URL(href)
    const scenario = page.searchParams.get('selftest')
    const endpoint = new URL(page.searchParams.get('next') ?? '')
    const runId = /^\/__nerve-local-save\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(endpoint.pathname)?.[1]
    if ((scenario !== 'local-save-online' && scenario !== 'local-save-offline') || endpoint.origin !== page.origin || endpoint.username !== '' || endpoint.password !== '' || endpoint.search !== '' || endpoint.hash !== '' || runId === undefined)
      return undefined
    return { endpoint: endpoint.href, runId, network: scenario === 'local-save-online' ? 'online' : 'offline' }
  }
  catch { return undefined }
}

export async function prepareLocalSaveSelftest(documentId: string): Promise<LocalSaveSelftest> {
  const control = localSaveControlFrom(location.href)
  if (control === undefined)
    throw new Error('本机保存测量缺少合法同源控制入口')
  const common = { runId: control.runId, documentId, bootId: crypto.randomUUID() }
  const writes = observeSelftestWrites()
  const abort = new AbortController()
  const samples: LocalSaveSample[] = []
  const dispose = (): void => {
    abort.abort()
    writes.dispose()
  }
  const post = async (kind: string, facts: Record<string, unknown> = {}): Promise<unknown> => {
    const response = await fetch(control.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, ...common, ...facts }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]) })
    if (!response.ok)
      throw new Error(`测量控制通道拒绝消息：${response.status}`)
    return response.json()
  }
  try {
    const reply = await post('boot') as { kind?: unknown, config?: Partial<LocalSaveConfig> }
    const config = reply?.config
    if (reply?.kind !== 'prepare' || config === undefined || config === null || Object.keys(config).length !== 3
      || !['1m', '5m', 'perf-50k'].includes(config.sample ?? '') || config.network !== control.network
      || !Number.isSafeInteger(config.rounds) || Number(config.rounds) < 2 || Number(config.rounds) > 20) {
      throw new Error('测量配置无效或与本轮场景不符')
    }
    return {
      config: config as LocalSaveConfig,
      run: async session => runLocalSaveMeasurement(session, { config: config as LocalSaveConfig, documentId, writes, post, samples, signal: abort.signal }),
      report: async (report) => {
        try {
          const result = await post('complete', { report, measurement: { config, samples } }) as { kind?: unknown }
          if (result?.kind !== 'wait' && result?.kind !== 'stop')
            throw new Error('测量报告未取得驱动回执')
        }
        finally { dispose() }
      },
      dispose,
    }
  }
  catch (error) {
    dispose()
    throw error
  }
}
