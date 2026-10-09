// 真实浏览器的前置复核在本机的持久上下文里的实测（M4-P1 设计 §3.6、§1 偏差 7）：Playwright 默认的浏览器上下文不落盘（Chromium 是无痕式的上下文、
// WebKit 用临时的数据存储），M0 的写入耗时、strict 的开销与写满都是在内存里的 IndexedDB 上测的；这里在持久化的浏览器目录里、按足够的次数
// 跑与真实 Safari 同一套页面自检（apps/web/src/editor/testing/ 的复核场景），作三个浏览器的对照。不进常规的 E2E 与 CI：
// pnpm --filter @nerve-office/e2e run measure:probe（先构建后端与测试构建；三个浏览器依次跑、一个工作进程，每个浏览器约 15 分钟）。
// 每个浏览器一条用例：
// 1. 一个持久上下文里依次跑首屏与公式冻结（Worker、主线程、再一次 Worker：第一步是这个资料目录里第一次打开编辑器页，冷的）、捕获成本（约 1 MiB、
//    约 5 MiB）、存储、密钥交给 Worker、Worker 的停顿（探针 Worker），以及生产的发件箱（主会话把 S8 的第二轮并进来）：生产 Worker 的停顿、
//    磁盘上的管道各段与恢复路径；Chromium 系另经 CDP 造出"已授予持久保存"再跑一次存储（第 1 项的另一条路）；
// 2. 另一个持久上下文（新的资料目录）里跑写满：Chromium 系经 CDP 把配额覆盖成 12 MiB；WebKit 没有这个接口，只记下配额、不写。
// 运行次数 MEASURE_PROBE_RUNS（默认 40，与真实 Safari 的驱动脚本相同）。各步的原始结果与逐项的判定（support/probe-verdicts.ts）写在
// measure/test-results/probe/<浏览器>.json 与 .md（下一次实测覆盖）。用例只要求每一步都交回了结果、各项的数据齐；判定的结论写进复核报告
import type { BrowserContext, Page, TestInfo } from '@playwright/test'
import type { ProbeReport } from '../support/probe-verdicts.ts'
import type { SelftestStep, SelftestStepDefinition } from '../support/selftest-plan.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { e2eOrigin } from '../support/environment.ts'
import { expect, test } from '../support/fixtures.ts'
import { firstPage, grantDurableStorage, launchPersistentProfile, overrideQuota } from '../support/persistent-profile.ts'
import { probeVerdicts, verdictLines } from '../support/probe-verdicts.ts'
import { SELFTEST_STEPS, selftestScene } from '../support/selftest-plan.ts'
import { runSelftestStep } from '../support/selftest-run.ts'

const RUNS = Number(process.env.MEASURE_PROBE_RUNS ?? '40')
const RESULTS_DIR = join(import.meta.dirname, 'test-results', 'probe')

/** 一步最多等多久交回：Worker 的停顿在 runs 40 时约 5–6 分钟的空闲加上各次的计算 */
const STEP_TIMEOUT_MS = 30 * 60_000

test.describe.configure({ timeout: 90 * 60_000 })

/** 一个持久上下文里依次跑的几步（与真实 Safari 的步骤相同，按 SELFTEST_STEPS 的先后） */
const STEP_IDS = ['perf-worker', 'perf-main', 'perf-worker-warm', 'capture-1m', 'capture-5m', 'storage', 'key-transfer', 'worker-stall', 'outbox-stall', 'outbox-pipeline'] as const

/** Chromium 系在"已授予持久保存"之后再跑一次存储 */
const GRANTED_STORAGE: SelftestStepDefinition = { id: 'storage-granted', scenario: 'storage', role: 'viewer', sample: 'template' }

/** 写满（新的资料目录） */
const QUOTA: SelftestStepDefinition = { id: 'storage-quota', scenario: 'storage-quota', role: 'viewer', sample: 'template' }

/** Chromium 系经 CDP 把配额覆盖成多少（设计 §3.6 第 4 项：8–16 MiB） */
const QUOTA_OVERRIDE_BYTES = 12 * 1024 * 1024

function definitionOf(id: string): SelftestStepDefinition {
  const definition = SELFTEST_STEPS.find(item => item.id === id)
  if (definition === undefined)
    throw new Error(`没有 ${id} 这一步`)
  return definition
}

function stepNamed(steps: readonly SelftestStep[], id: string): SelftestStep {
  const step = steps.find(item => item.id === id)
  if (step === undefined)
    throw new Error(`场景里没有 ${id} 这一步`)
  return step
}

/** Chromium 系（chromium、chrome）能经 CDP 覆盖配额、造出"已授予持久保存"；WebKit 不能 */
function chromiumFamily(browserName: string): boolean {
  return browserName === 'chromium'
}

/** 第 1 步起依次跑；第一步是这个资料目录里第一次打开编辑器页（冷的）。Chromium 系最后造出"已授予持久保存"再跑一次存储 */
async function runInProfile(context: BrowserContext, page: Page, steps: readonly SelftestStep[], browserName: string): Promise<ProbeReport[]> {
  const reports: ProbeReport[] = []
  for (const [index, id] of STEP_IDS.entries()) {
    const step = stepNamed(steps, id)
    reports.push({ stepId: step.id, report: await runSelftestStep(page, step, STEP_TIMEOUT_MS), cold: index === 0 })
  }
  if (chromiumFamily(browserName)) {
    const release = await grantDurableStorage(context, page, e2eOrigin())
    const step = stepNamed(steps, GRANTED_STORAGE.id)
    reports.push({ stepId: step.id, report: await runSelftestStep(page, step, STEP_TIMEOUT_MS), cold: false })
    await release()
  }
  return reports
}

/** 写满：新的资料目录（这个源还没有写过 IndexedDB），Chromium 系先覆盖配额（CDP 的会话开着才生效） */
async function runQuota(context: BrowserContext, page: Page, step: SelftestStep, browserName: string): Promise<ProbeReport> {
  const release = chromiumFamily(browserName) ? await overrideQuota(context, page, e2eOrigin(), QUOTA_OVERRIDE_BYTES) : async () => {}
  const report = await runSelftestStep(page, step, STEP_TIMEOUT_MS)
  await release()
  return { stepId: step.id, report, cold: false }
}

/** 写下这个浏览器的结果：原始的各步与逐项的判定（"已授予"的那一次存储单独判定第 1 项） */
function writeResults(testInfo: TestInfo, startedAt: string, loadBefore: readonly number[], reports: readonly ProbeReport[]): string[] {
  const main = reports.filter(entry => entry.stepId !== GRANTED_STORAGE.id)
  const verdicts = probeVerdicts(main)
  const granted = reports.filter(entry => entry.stepId === GRANTED_STORAGE.id)
  const grantedVerdicts = granted.length === 0 ? [] : probeVerdicts(granted).filter(verdict => verdict.id === '1')
  const lines = [
    `# ${testInfo.project.name}（持久上下文，运行次数 ${RUNS}）`,
    '',
    `- 浏览器：${reports[0]?.report.userAgent ?? '—'}`,
    `- 开始 ${startedAt}，负载（1、5、15 分钟）${loadBefore.map(value => value.toFixed(2)).join(' ')} → ${loadavg().map(value => value.toFixed(2)).join(' ')}`,
    '',
    ...verdictLines(verdicts),
    ...(grantedVerdicts.length === 0 ? [] : ['', '经 CDP 造出"已授予持久保存"之后再跑一次存储：', ...verdictLines(grantedVerdicts)]),
  ]
  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(join(RESULTS_DIR, `${testInfo.project.name}.json`), `${JSON.stringify({ format: 'nerve-office.probe-measure.v1', project: testInfo.project.name, runs: RUNS, startedAt, finishedAt: new Date().toISOString(), load: { before: loadBefore, after: loadavg() }, verdicts, grantedVerdicts, reports }, null, 2)}\n`)
  writeFileSync(join(RESULTS_DIR, `${testInfo.project.name}.md`), `${lines.join('\n')}\n`)
  return [...verdicts, ...grantedVerdicts].filter(verdict => verdict.status === 'missing').map(verdict => `第 ${verdict.item} 项：缺 ${verdict.missing.join('、')}`)
}

test(`真实浏览器的前置复核（M4-P1 §3.6）：持久上下文里跑首屏与公式冻结、捕获成本、存储、密钥交给 Worker、Worker 的停顿（各 ${RUNS} 次一档），另一个资料目录里跑写满`, async ({ playwright, browserName, cspViolations, pageErrors }, testInfo) => {
  expect(RUNS, 'MEASURE_PROBE_RUNS 是 1 到 400 的整数').toBeGreaterThanOrEqual(1)
  const loadBefore = loadavg()
  const startedAt = new Date().toISOString()
  const scene = await selftestScene(`mp-${testInfo.project.name}`, [...STEP_IDS.map(definitionOf), GRANTED_STORAGE, QUOTA], RUNS)
  const watchers = { cspViolations, pageErrors }
  const profile = await launchPersistentProfile(playwright[browserName], testInfo, 'profile', watchers)
  let reports: ProbeReport[]
  try {
    reports = await runInProfile(profile, await firstPage(profile), scene.steps, browserName)
  }
  finally {
    await profile.close()
  }
  const quotaProfile = await launchPersistentProfile(playwright[browserName], testInfo, 'quota-profile', watchers)
  try {
    reports.push(await runQuota(quotaProfile, await firstPage(quotaProfile), stepNamed(scene.steps, QUOTA.id), browserName))
  }
  finally {
    await quotaProfile.close()
  }
  const missing = writeResults(testInfo, startedAt, loadBefore, reports)
  await testInfo.attach('probe-measure', { path: join(RESULTS_DIR, `${testInfo.project.name}.md`), contentType: 'text/markdown' })
  expect(reports.map(entry => entry.report.failure ?? 'ok'), '每一步都跑完了').toEqual(reports.map(() => 'ok'))
  expect(missing, '各项的数据都齐').toEqual([])
})
