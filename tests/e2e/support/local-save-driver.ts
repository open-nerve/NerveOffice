// 页面只能提交事实；网络切断与独立数据库确认由串行宿主执行。
import type { LocalSaveConfig } from '../../../apps/web/src/editor/testing/local-save-report.ts'
import type { MeasuredEdit } from '../../../apps/web/src/editor/testing/local-save-timing.ts'
import type { startLocalSaveProxy } from '../safari/local-save-proxy.ts'
import type { LocalSaveCloud } from './local-save-evidence.ts'
import type { createLocalSaveSession } from './local-save-session.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { perfIncrementalEdit } from '../../../apps/web/src/editor/testing/capture-samples.ts'
import { localSaveCloudProblems, localSaveNetworkProblems, readLocalSaveCloud } from './local-save-evidence.ts'

export function localSaveEdit(config: LocalSaveConfig, round: number): MeasuredEdit {
  return config.sample === 'perf-50k' ? { ...perfIncrementalEdit(round - 1), formula: true } : { cell: 'B2', value: `实测第 ${round} 次修改`, formula: false }
}

export function createLocalSaveDriver(options: {
  readonly config: LocalSaveConfig
  readonly documentId: string
  readonly userId: string
  readonly baseline: LocalSaveCloud
  readonly session: ReturnType<typeof createLocalSaveSession>
  readonly proxy: Awaited<ReturnType<typeof startLocalSaveProxy>>
}) {
  const { config, documentId, userId, baseline, session, proxy } = options
  const cloudChecks: { readonly round: number, readonly at: number, readonly cloud: LocalSaveCloud, readonly problems: readonly string[] }[] = []
  const driver = {
    async tick(): Promise<void> {
      const state = session.snapshot()
      if (state.phase === 'ready') {
        if (proxy.network().inFlight !== 0)
          return
        const cloud = await readLocalSaveCloud(documentId)
        const lease = cloud.lease
        if (lease === null || lease.ended || lease.holderId !== userId || lease.writeEpoch !== state.ready?.writeEpoch) {
          session.fail('数据库中没有本页同一写代次的编辑租约')
          return
        }
        // 数据库读取让出过事件循环；切断之前再确认一次，没有在途就同步切断。
        if (proxy.network().inFlight !== 0)
          return
        if (config.network === 'offline')
          proxy.cutApi()
        session.confirmNetwork({ ...proxy.network(), clientInstanceId: lease.clientInstanceId, revision: cloud.revision, contentHash: cloud.snapshotHash }, Date.now())
      }
      else if (state.phase === 'checking') {
        const sample = state.samples.at(-1)
        if (sample === undefined) {
          session.fail('逐轮检查缺少对应样本')
          return
        }
        const cloud = await readLocalSaveCloud(documentId, config.network === 'online' ? localSaveEdit(config, sample.round) : undefined)
        const problems = localSaveCloudProblems(config, sample, cloud, baseline)
        cloudChecks.push({ round: sample.round, at: Date.now(), cloud, problems })
        session.confirmRound(sample.round, problems, Date.now())
      }
      else if (state.phase === 'reported') {
        const sample = state.samples.at(-1)
        if (sample === undefined || proxy.network().inFlight !== 0)
          return
        const cloud = await readLocalSaveCloud(documentId, config.network === 'online' ? localSaveEdit(config, sample.round) : undefined)
        if (proxy.network().inFlight !== 0)
          return
        const problems = [...localSaveCloudProblems(config, sample, cloud, baseline), ...localSaveNetworkProblems(config, documentId, state.networkAt, proxy.network()), ...proxy.evidence().problems]
        cloudChecks.push({ round: sample.round, at: Date.now(), cloud, problems })
        session.finish(problems, Date.now())
      }
    },
    snapshot: () => structuredClone({ cloudChecks, network: proxy.network(), proxy: proxy.evidence() }),
  }
  return {
    ...driver,
    async run(deadline: number, guard: () => void): Promise<void> {
      while (!['passed', 'failed'].includes(session.snapshot().phase) && Date.now() < deadline) {
        guard()
        await driver.tick()
        await delay(50)
      }
      if (!['passed', 'failed'].includes(session.snapshot().phase))
        session.fail('宿主等待本组测量结果超时')
    },
  }
}
