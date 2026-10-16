// M4-P5：Worker 让出间隔的串行实测，不进常规 E2E/CI，不给性能添加机器相关门槛。
// 每轮全量重算 → 计算中停止 → 再重算，记录真实命令时序与按定义核对的结果。
// MEASURE_FORMULA_INTERVAL 只是预期值：实际 stageInfo 的相邻计数必须证明产物使用了该间隔。
// 候选由外部脚本备份源码、改 Worker 配置并构建；页面没有配置或故障开关。
import type { Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, cpus, loadavg, platform, release } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { verifyFormulaSnapshot } from '../../../apps/web/src/editor/testing/capture-samples.ts'
import { AUTOSAVE_STOP_SAMPLE, autosaveStopSampleFor } from '../support/capture-samples.ts'
import { createDocument, createUser } from '../support/database.ts'
import { probeFormulaMode, probeFormulasSettled, probeSnapshot } from '../support/editor-probe.ts'
import { expect, test } from '../support/fixtures.ts'
import { loginThroughApi } from '../support/session.ts'
import { EDITOR_TEST_TIMEOUT, openReader } from '../support/sheet.ts'

// 只读测量不需要 OPFS；保持原生上下文，不安装常规 WebKit 存储命名空间的脚本路由。
test.use({ webkitStorage: 'temporary' })
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })
const ROUNDS = Number(process.env.MEASURE_FORMULA_ROUNDS ?? '10')
const INTERVAL = Number(process.env.MEASURE_FORMULA_INTERVAL ?? '20')
if (!Number.isSafeInteger(ROUNDS) || ROUNDS < 1 || ![20, 50, 100, 500].includes(INTERVAL))
  throw new Error('公式测量的轮数或间隔不合法')
const RESULTS = join(import.meta.dirname, 'test-results', 'formula')

interface Stage {
  readonly at: number
  readonly stage: number
  readonly completed: number
  readonly total: number
}

interface Round {
  readonly requestedAt: number
  readonly starts: readonly number[]
  readonly stopAt: number | undefined
  readonly endedAt: number
  readonly endedState: number
  readonly results: readonly number[]
  readonly stages: readonly Stage[]
}

/** 与 SDK 的进度事件同一时钟；第一次实际计算进度（stage=4）之后请求 stop，不在依赖准备之前抢停。 */
async function measureRound(page: Page, stop: boolean): Promise<Round> {
  return page.evaluate(async stop => new Promise<Round>((resolve, reject) => {
    interface Events {
      readonly Event: { readonly CommandExecuted: string }
      readonly addEvent: (event: string, listener: (event: { id: string, params?: { stageInfo?: { stage: number, completedFormulasCount: number, totalFormulasToCalculate: number }, functionsExecutedState?: number } }) => void) => { dispose: () => void }
      readonly executeCommand: (id: string, params: object, options: object) => Promise<boolean>
    }
    const api = window.__nerveEditorProbe?.univerAPI as unknown as Events | undefined
    if (api === undefined) {
      reject(new Error('没有编辑器探针'))
      return
    }
    const requestedAt = performance.now()
    const starts: number[] = []
    const results: number[] = []
    const stages: Stage[] = []
    let stopAt: number | undefined
    let done = false
    let endedState = -1
    let timer: ReturnType<typeof setTimeout> | undefined
    let subscription: { dispose: () => void } | undefined
    const finish = (error?: unknown): void => {
      if (done)
        return
      done = true
      clearTimeout(timer)
      subscription?.dispose()
      if (error !== undefined)
        reject(error)
      else
        resolve({ requestedAt, starts, stopAt, endedAt: performance.now(), endedState, results, stages })
    }
    subscription = api.addEvent(api.Event.CommandExecuted, (event) => {
      const at = performance.now()
      if (event.id === 'formula.mutation.set-formula-calculation-start')
        starts.push(at)
      if (event.id === 'formula.mutation.set-formula-calculation-result')
        results.push(at)
      if (event.id !== 'formula.mutation.set-formula-calculation-notification' || starts.length === 0)
        return
      const progress = event.params?.stageInfo
      if (progress !== undefined) {
        stages.push({ at, stage: progress.stage, completed: progress.completedFormulasCount, total: progress.totalFormulasToCalculate })
        if (stop && stopAt === undefined && progress.stage === 4 && progress.completedFormulasCount > 0) {
          stopAt = at
          void api.executeCommand('formula.mutation.set-formula-calculation-stop', {}, { onlyLocal: true }).then((accepted) => {
            if (!accepted)
              finish(new Error('停止命令被拒绝'))
          }, finish)
        }
      }
      const state = event.params?.functionsExecutedState
      // 1/2/3 = STOP_EXECUTION/NOT_EXECUTED/SUCCESS，和 formula-protocol 登记的 SDK 枚举一致。
      if (state !== undefined && [1, 2, 3].includes(state)) {
        endedState = state
        finish()
      }
    })
    // 沿用重建回归的重型公式轮次上限；不是性能阈值。
    timer = setTimeout(() => finish(new Error('90 秒内未收到公式结束通知')), 90_000)
    void api.executeCommand('formula.mutation.set-trigger-formula-calculation-start', { forceCalculation: true }, { onlyLocal: true }).then((accepted) => {
      if (!accepted)
        finish(new Error('强制计算命令被拒绝'))
    }, finish)
  }), stop)
}

/** 实际逐段计数的正向间隔；重启一轮/阶段时重置的计数不算一个让出间隔。 */
function yieldSteps(round: Round): number[] {
  const counts = round.stages.filter(stage => stage.stage === 4).map(stage => stage.completed)
  return counts.slice(1).map((value, index) => value - (counts[index] ?? 0)).filter(value => value > 0)
}

async function checkSnapshot(page: Page): Promise<ReturnType<typeof verifyFormulaSnapshot>> {
  await expect.poll(async () => probeFormulasSettled(page), { timeout: 90_000 }).toBe(true)
  const verdict = verifyFormulaSnapshot(await probeSnapshot(page), 8, AUTOSAVE_STOP_SAMPLE)
  expect(verdict.checked).toBeGreaterThan(800)
  expect({ staleCount: verdict.staleCount, errors: verdict.errors }).toEqual({ staleCount: 0, errors: {} })
  return verdict
}

test('公式 Worker 的全量计算和计算中 stop：实际间隔、逐轮时序与重算正确性', async ({ page }, info) => {
  const owner = await createUser('measure-formula')
  // 原默认间隔 500 时也要在计算中保留至少两个让出机会，消息往返才不会晚于整轮结束。
  const id = await createDocument(owner, '公式间隔测量', autosaveStopSampleFor)
  await loginThroughApi(page, owner)
  await openReader(page, id, 'steady')
  expect(await probeFormulaMode(page)).toBe('worker')
  await checkSnapshot(page)
  const samples: { full: Round, stopped: Round, recovered: Round }[] = []
  const report = {
    browser: info.project.name,
    interval: INTERVAL,
    rounds: ROUNDS,
    startedAt: new Date().toISOString(),
    environment: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, loadavg: loadavg(), node: process.version },
    samples,
  }
  mkdirSync(RESULTS, { recursive: true })
  const output = join(RESULTS, `${info.project.name}-${INTERVAL}.json`)
  try {
    for (let index = 0; index < ROUNDS; index += 1) {
      const full = await measureRound(page, false)
      await checkSnapshot(page)
      const stopped = await measureRound(page, true)
      const recovered = await measureRound(page, false)
      samples.push({ full, stopped, recovered })
      writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
      expect(full.starts).toHaveLength(1)
      expect(full.endedState).toBe(3)
      expect(full.results).not.toHaveLength(0)
      expect([...new Set(yieldSteps(full))], '实际进度计数证明配置生效').toEqual([INTERVAL])
      expect(stopped.starts).toHaveLength(1)
      expect(stopped.stopAt).toBeGreaterThan(stopped.starts[0] ?? Infinity)
      expect(stopped.endedState, '必须确实停在计算中').toBe(1)
      expect(stopped.results, '被停轮不能算作已完成的性能样本').toHaveLength(0)
      expect(recovered.endedState).toBe(3)
      await checkSnapshot(page)
    }
  }
  finally {
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    await info.attach('formula-measurement', { path: output, contentType: 'application/json' })
  }
})
