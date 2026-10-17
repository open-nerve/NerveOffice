import type { LocalSaveSample } from '../../../apps/web/src/editor/testing/local-save-report.ts'
import type { LocalSaveCloud, LocalSaveNetwork } from './local-save-evidence.ts'
import { describe, expect, it } from 'vitest'
import { localSaveCloudProblems, localSaveNetworkProblems } from './local-save-evidence.ts'

const config = { sample: '1m', network: 'online', rounds: 2 } as const
const baseline: LocalSaveCloud = { revision: 1, snapshotHash: 'a'.repeat(64), formulasPending: false, contentProblems: [], lease: null }
const sample = { baseRevision: 1, cloudRevision: 2, snapshotHash: 'b'.repeat(64) } as LocalSaveSample
const cloud: LocalSaveCloud = { ...baseline, revision: 2, snapshotHash: sample.snapshotHash }
const request = { method: 'PUT', path: '/api/documents/d/content', startedAt: 150, completedAt: 160, status: 200, forwarded: true }

describe('本机保存的独立云端与传输判定', () => {
  it('在线必须是本轮完整字节、正确单元格和紧接上一轮的修订', () => {
    expect(localSaveCloudProblems(config, sample, cloud, baseline)).toEqual([])
    for (const changed of [{ revision: 1 }, { revision: 3 }, { snapshotHash: baseline.snapshotHash }, { formulasPending: true }, { contentProblems: ['错单元格'] }])
      expect(localSaveCloudProblems(config, sample, { ...cloud, ...changed }, baseline).length).toBeGreaterThan(0)
  })
  it('离线数据库必须始终保持原基线', () => {
    const offline = { ...config, network: 'offline' } as const
    expect(localSaveCloudProblems(offline, sample, baseline, baseline)).toEqual([])
    expect(localSaveCloudProblems(offline, sample, cloud, baseline).length).toBeGreaterThan(0)
    expect(localSaveCloudProblems(offline, sample, { ...baseline, formulasPending: true }, baseline).length).toBeGreaterThan(0)
  })
  it('在线要有真实成功保存、零在途且从未切断', () => {
    const network: LocalSaveNetwork = { cutAt: null, inFlight: 0, requests: [request, { ...request, startedAt: 170, completedAt: 180 }] }
    expect(localSaveNetworkProblems(config, 'd', 100, network)).toEqual([])
    for (const changed of [{ cutAt: 99 }, { inFlight: 1 }, { requests: [] }, { requests: [request] }, { requests: [{ ...request, status: 500 }] }, { requests: [{ ...request, completedAt: null }] }])
      expect(localSaveNetworkProblems(config, 'd', 100, { ...network, ...changed }).length).toBeGreaterThan(0)
  })
  it('离线要有实际被断开的应用请求，任何切断后上游传输或跨界在途都失败', () => {
    const offline = { ...config, network: 'offline' } as const
    const network: LocalSaveNetwork = { cutAt: 90, inFlight: 0, requests: [{ ...request, forwarded: false, status: null }] }
    expect(localSaveNetworkProblems(offline, 'd', 100, network)).toEqual([])
    for (const changed of [
      { cutAt: null },
      { cutAt: 101 },
      { inFlight: 1 },
      { requests: [] },
      { requests: [request] },
      { requests: [...network.requests, { ...request, startedAt: 80, completedAt: 91 }] },
      { requests: [...network.requests, { ...request, method: 'GET', path: '/api/auth/session' }] },
      { requests: [{ ...request, forwarded: false, status: 200 }] },
    ])
      expect(localSaveNetworkProblems(offline, 'd', 100, { ...network, ...changed }).length).toBeGreaterThan(0)
  })
  it('连续编辑超过心跳间隔，先断开租约续约且产品暂停上传时也提供实际断网证据', () => {
    const offline = { ...config, network: 'offline' } as const
    const network: LocalSaveNetwork = { cutAt: 90, inFlight: 0, requests: [{ ...request, path: '/api/documents/d/edit-lease', forwarded: false, status: null }] }
    expect(localSaveNetworkProblems(offline, 'd', 100, network)).toEqual([])
    expect(localSaveNetworkProblems(offline, 'd', 100, { ...network, requests: [{ ...network.requests[0]!, path: '/__nerve-local-save/control' }] }).length).toBeGreaterThan(0)
  })
})
