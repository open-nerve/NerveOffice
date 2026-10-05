// 模式切换的耗时实测（M3-P2 设计 §3.1 第 4 条：一律重建的代价，明显超过 1 秒要与需求方商量；§6 的 S5）。不进常规的 E2E 与 CI：
// pnpm --filter @nerve-office/e2e run measure:switch（先构建后端与测试构建；三个浏览器依次跑、一个工作进程；跑完打印汇总的表）。
// 每个浏览器、每份文档一个用例：
// 1. 作者打开（新的浏览器上下文里第一次打开），再刷新一次：起点是导航开始，到阅读的 steady（对照）；
// 2. 进入编辑、退出编辑交替 ROUNDS 次（没有修改：退出时不保存，只有释放）；
// 3. 查看者打开；作者存一版（直接写库，measure-scene.ts）、页面立即读一次编辑状态，出现"有更新，点击刷新"之后点它，ROUNDS 次。
// 起点是页面收到点击（捕获阶段）；各个时刻与各段的含义见 apps/web/src/editor/testing/switch-timing.ts。
// 结果写在 measure/test-results/switch/<浏览器>-<文档>.json（下一次实测覆盖），measure/summarize.ts 汇总成 p50、p95、最大值的表。
// 次数：MEASURE_ROUNDS（默认 12，设计要求每个方向至少 10 次）。
import type { SnapshotFor } from '../support/database.ts'
import type { SwitchRun, SwitchSample } from '../support/measure-stats.ts'
import { Buffer } from 'node:buffer'
import { mkdirSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { expect, test } from '../support/fixtures.ts'
import { largeSheetFor, largeSheetScale } from '../support/large-sheet.ts'
import { authorVersions, checkEditStatusNow, installTiming, measureOpen, measureScene, measureSwitch, updateButton } from '../support/measure-scene.ts'
import { readOnlySampleFor } from '../support/read-only-sample.ts'
import { loginThroughApi } from '../support/session.ts'
import { editorSurface, enterEditButton, exitEditButton } from '../support/sheet.ts'

const ROUNDS = Number(process.env.MEASURE_ROUNDS ?? '12')
const RESULTS_DIR = join(import.meta.dirname, 'test-results', 'switch')

// 一份文档的用例要切换几十次（每次等到 steady，SDK 固定 3 秒）
test.describe.configure({ timeout: 20 * 60_000 })

interface MeasuredDocument {
  readonly id: string
  readonly title: string
  readonly snapshotFor: SnapshotFor
  /** 规模的说明（报告里写） */
  readonly scale: (snapshot: string) => string
}

const DOCUMENTS: readonly MeasuredDocument[] = [
  { id: 'small', title: '新建表格的模板', snapshotFor: sheetSnapshotFor, scale: () => '空白的一张表（1,000 行 × 20 列）' },
  { id: 'medium', title: '只读样本', snapshotFor: readOnlySampleFor, scale: () => '5 张表，公式（含跨表、定义名称）、两张图片、批注、超链接、数据验证、条件格式、筛选、冻结' },
  {
    id: 'large',
    title: '生成的大表',
    snapshotFor: largeSheetFor,
    scale: (snapshot) => {
      const scale = largeSheetScale(snapshot)
      return `2 张表，${scale.cells} 个单元格：数值 ${scale.numberCells}、公式 ${scale.formulaCells}（每行一个求和、跨表的汇总）、文字 ${scale.textCells}`
    },
  },
]

for (const measured of DOCUMENTS) {
  test(`${measured.title}：打开，进入编辑、退出编辑与"有更新，点击刷新"各 ${ROUNDS} 次`, async ({ page, browser }, testInfo) => {
    expect(ROUNDS, 'MEASURE_ROUNDS 至少 1').toBeGreaterThanOrEqual(1)
    const loadBefore = loadavg()
    const startedAt = new Date().toISOString()
    const scene = await measureScene(`ms-${measured.id}`, measured.title, measured.snapshotFor)
    const samples: SwitchSample[] = []
    await installTiming(page)

    // 1. 作者打开：第一次（这个浏览器上下文里没有缓存），再刷新一次
    await loginThroughApi(page, scene.author)
    samples.push({ direction: 'open', round: 1, timing: await measureOpen(page, async () => page.goto(`/documents/${scene.documentId}`)) })
    samples.push({ direction: 'open', round: 2, timing: await measureOpen(page, async () => page.reload()) })
    await expect(enterEditButton(page)).toBeVisible()

    // 2. 进入编辑、退出编辑：没有修改，进入时修订号没变（不读内容），退出时不保存
    for (let round = 1; round <= ROUNDS; round += 1) {
      const entered = await measureSwitch(page, 'enter', async () => enterEditButton(page).click())
      await expect(editorSurface(page)).toHaveAttribute('data-editor-access', 'edit')
      expect(entered.requests.map(request => request.role).filter(role => role !== 'status' && role !== 'renew'), '进入编辑只申请编辑权').toEqual(['acquire'])
      samples.push({ direction: 'enter', round, timing: entered })
      const exited = await measureSwitch(page, 'exit', async () => exitEditButton(page).click())
      await expect(editorSurface(page)).toHaveAttribute('data-editor-access', 'read')
      expect(exited.requests.map(request => request.role).filter(role => role !== 'status' && role !== 'renew'), '没有修改：退出编辑只释放').toEqual(['release'])
      samples.push({ direction: 'exit', round, timing: exited })
    }

    // 3. 查看者阅读，作者在别处保存了新的版本
    await loginThroughApi(page, scene.viewer)
    await measureOpen(page, async () => page.goto(`/documents/${scene.documentId}`))
    const author = authorVersions(scene.author)
    for (let round = 1; round <= ROUNDS; round += 1) {
      await author.saveVersion(scene.documentId, `第 ${round} 版`)
      await checkEditStatusNow(page)
      await expect(updateButton(page)).toBeVisible()
      const refreshed = await measureSwitch(page, 'refresh', async () => updateButton(page).click())
      await expect(updateButton(page)).toHaveCount(0)
      expect(refreshed.requests.map(request => request.role).filter(role => role !== 'status'), '按条件读取取新的内容').toEqual(['content'])
      samples.push({ direction: 'refresh', round, timing: refreshed })
    }

    const snapshot = measured.snapshotFor('measure-unit')
    const run: SwitchRun = {
      format: 'nerve-office.switch-measure.v1',
      browser: { project: testInfo.project.name, version: browser.version() },
      document: { id: measured.id, title: measured.title, bytes: Buffer.byteLength(snapshot, 'utf8'), scale: measured.scale(snapshot) },
      startedAt,
      finishedAt: new Date().toISOString(),
      load: { before: loadBefore, after: loadavg() },
      samples,
    }
    mkdirSync(RESULTS_DIR, { recursive: true })
    writeFileSync(join(RESULTS_DIR, `${testInfo.project.name}-${measured.id}.json`), `${JSON.stringify(run, null, 2)}\n`)
    await testInfo.attach('switch-measure', { body: JSON.stringify(run, null, 2), contentType: 'application/json' })
  })
}
