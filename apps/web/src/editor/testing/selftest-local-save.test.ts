import { describe, expect, it, vi } from 'vitest'
import { localSaveControlFrom, prepareLocalSaveSelftest } from './selftest-local-save.ts'

const ORIGIN = 'http://127.0.0.1:40567'
const RUN = '1f1f40c3-1579-4657-9902-9f1f804fdde1'
const endpoint = `${ORIGIN}/__nerve-local-save/${RUN}`
const href = (next = endpoint, scenario = 'local-save-online') => `${ORIGIN}/documents/d?selftest=${scenario}&next=${encodeURIComponent(next)}`

describe('本机保存测量的页面准备', () => {
  it('只接受本场景同源专用控制路径', () => {
    expect(localSaveControlFrom(href())).toEqual({ endpoint, runId: RUN, network: 'online' })
    expect(localSaveControlFrom(href(endpoint, 'local-save-offline'))?.network).toBe('offline')
    for (const next of [`${endpoint}?x=1`, `${endpoint}#x`, `${endpoint}/extra`, endpoint.replace('40567', '40568'), endpoint.replace('__nerve-local-save', '__nerve-pause'), endpoint.replace('127.0.0.1', 'user:password@127.0.0.1')])
      expect(localSaveControlFrom(href(next))).toBeUndefined()
    expect(localSaveControlFrom(href(endpoint, 'paused-holder'))).toBeUndefined()
  })

  it('载入页面前安装实际 Worker 观察，取得固定配置后允许继续，释放时恢复构造器', async () => {
    vi.stubGlobal('location', { href: href(), origin: ORIGIN })
    const NativeWorker = class {}
    vi.stubGlobal('Worker', NativeWorker)
    const fetcher = vi.fn(async () => Response.json({ kind: 'prepare', config: { sample: '1m', network: 'online', rounds: 2 } }))
    vi.stubGlobal('fetch', fetcher)
    const control = await prepareLocalSaveSelftest('d')
    expect(control.config).toEqual({ sample: '1m', network: 'online', rounds: 2 })
    expect(window.Worker).not.toBe(NativeWorker)
    control.dispose()
    expect(window.Worker).toBe(NativeWorker)
  })

  it.each([
    { sample: '1m', network: 'offline', rounds: 2 },
    { sample: 'unknown', network: 'online', rounds: 2 },
    { sample: '1m', network: 'online', rounds: 1 },
    { sample: '1m', network: 'online', rounds: 21 },
    { sample: '1m', network: 'online', rounds: 2.5 },
  ])('配置不符时拒绝载入并释放观察 %j', async (config) => {
    vi.stubGlobal('location', { href: href(), origin: ORIGIN })
    const NativeWorker = class {}
    vi.stubGlobal('Worker', NativeWorker)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ kind: 'prepare', config })))
    await expect(prepareLocalSaveSelftest('d')).rejects.toThrow('测量配置')
    expect(window.Worker).toBe(NativeWorker)
  })
})
