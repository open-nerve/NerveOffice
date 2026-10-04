// 反复切换的内存实测（M3-P2 设计 §7 的第二行：一律重建让一页里反复创建、销毁 Univer 实例；§6 的 S5）。只在 Chromium 上（CDP），
// 不进常规的 E2E 与 CI：pnpm --filter @nerve-office/e2e run measure:memory（先构建，同 pnpm test:e2e）。中等文档（只读样本）：
// 1. 作者打开到阅读的 steady，连续 ROUNDS 次"进入编辑 → 退出编辑"（每次都等到 steady）；
// 2. 查看者打开，ROUNDS 次"有更新，点击刷新"（作者经接口保存一版、页面立即读一次编辑状态）。
// 每次之后（与打开之后）经 CDP 强制回收（HeapProfiler.collectGarbage，两次），再读已用堆（Runtime.getHeapUsage）、
// DOM 的计数（Memory.getDOMCounters：文档、节点、事件监听）与 Worker 的个数（page.workers()，公式 Worker 每个编辑器一个）。
// 结果写在 measure/test-results/memory/<场景>.json 与 .md（序列与第 2 次之后的斜率）。
// MEASURE_HEAP_SNAPSHOTS=1 时在第 2 次与最后一次之后（MEASURE_HEAP_SNAPSHOT_ROUNDS 可以另给，逗号分隔）各取一次堆快照
// （HeapProfiler.takeHeapSnapshot），写在同一个目录，用 measure/heap-diff.ts 比较两次之间多出来的对象与它们的保留者。
// 次数：MEASURE_MEMORY_ROUNDS（默认 20）。
import type { CDPSession, Page } from '@playwright/test'
import type { MemoryReading } from '../support/measure-stats.ts'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { expect, test } from '../support/fixtures.ts'
import { authorApi, checkEditStatusNow, installTiming, measureOpen, measureScene, measureSwitch, updateButton } from '../support/measure-scene.ts'
import { memoryTable, memoryTrend } from '../support/measure-stats.ts'
import { readOnlySampleFor } from '../support/read-only-sample.ts'
import { loginThroughApi } from '../support/session.ts'
import { editorSurface, enterEditButton, exitEditButton } from '../support/sheet.ts'

const ROUNDS = Number(process.env.MEASURE_MEMORY_ROUNDS ?? '20')
/** 取堆快照的次（第几次之后）；不取时为空 */
const SNAPSHOT_ROUNDS: ReadonlySet<number> = process.env.MEASURE_HEAP_SNAPSHOTS === '1'
  ? new Set((process.env.MEASURE_HEAP_SNAPSHOT_ROUNDS ?? `2,${ROUNDS}`).split(',').map(Number))
  : new Set()
const RESULTS_DIR = join(import.meta.dirname, 'test-results', 'memory')

test.describe.configure({ timeout: 30 * 60_000 })

/** 强制回收两次（第一次回收之后才能放掉的，例如终结器与弱引用的清理），再读数 */
async function reading(page: Page, cdp: CDPSession, round: number): Promise<MemoryReading> {
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.send('HeapProfiler.collectGarbage')
  const heap = await cdp.send('Runtime.getHeapUsage')
  const dom = await cdp.send('Memory.getDOMCounters')
  return { round, usedHeap: heap.usedSize, totalHeap: heap.totalSize, documents: dom.documents, nodes: dom.nodes, listeners: dom.jsEventListeners, workers: page.workers().length }
}

/** 要取堆快照的那几次之后，写成文件（Chrome 开发者工具能直接载入的 .heapsnapshot）：<场景>-<次>.heapsnapshot */
async function heapSnapshot(cdp: CDPSession, scenario: string, round: number): Promise<void> {
  if (!SNAPSHOT_ROUNDS.has(round))
    return
  mkdirSync(RESULTS_DIR, { recursive: true })
  const out = createWriteStream(join(RESULTS_DIR, `${scenario}-${round}.heapsnapshot`))
  const write = ({ chunk }: { chunk: string }): void => {
    out.write(chunk)
  }
  cdp.on('HeapProfiler.addHeapSnapshotChunk', write)
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false })
  cdp.off('HeapProfiler.addHeapSnapshotChunk', write)
  await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => error ? reject(error) : resolve()))
}

async function record(name: string, readings: readonly MemoryReading[], load: { readonly before: readonly number[], readonly after: readonly number[] }): Promise<void> {
  const trend = memoryTrend(readings)
  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(join(RESULTS_DIR, `${name}.json`), `${JSON.stringify({ format: 'nerve-office.memory-measure.v1', scenario: name, rounds: ROUNDS, load, trend, readings }, null, 2)}\n`)
  writeFileSync(join(RESULTS_DIR, `${name}.md`), `${memoryTable(readings)}\n\n第 ${trend.from} 次之后：已用堆 ${trend.heapKiBPerRound} KiB/次（一共 ${trend.heapKiBTotal} KiB），DOM 节点 ${trend.nodesPerRound} 个/次，事件监听 ${trend.listenersPerRound} 个/次\n`)
}

test.describe('反复切换的内存（中等文档，Chromium）', () => {
  test(`进入编辑再退出 ${ROUNDS} 次`, async ({ page }) => {
    const load = { before: loadavg(), after: [] as number[] }
    const scene = await measureScene('mm-switch', '只读样本', readOnlySampleFor)
    await installTiming(page)
    await loginThroughApi(page, scene.author)
    await measureOpen(page, async () => page.goto(`/documents/${scene.documentId}`))
    const cdp = await page.context().newCDPSession(page)
    const readings = [await reading(page, cdp, 0)]
    for (let round = 1; round <= ROUNDS; round += 1) {
      await measureSwitch(page, 'enter', async () => enterEditButton(page).click())
      await expect(editorSurface(page)).toHaveAttribute('data-editor-access', 'edit')
      await measureSwitch(page, 'exit', async () => exitEditButton(page).click())
      await expect(editorSurface(page)).toHaveAttribute('data-editor-access', 'read')
      readings.push(await reading(page, cdp, round))
      await heapSnapshot(cdp, 'enter-exit', round)
    }
    await record('enter-exit', readings, { ...load, after: loadavg() })
    expect(readings.every(item => item.workers === 1), '每次之后只剩一个公式 Worker').toBe(true)
  })

  test(`"有更新，点击刷新" ${ROUNDS} 次`, async ({ page }) => {
    const load = { before: loadavg(), after: [] as number[] }
    const scene = await measureScene('mm-refresh', '只读样本', readOnlySampleFor)
    await installTiming(page)
    await loginThroughApi(page, scene.viewer)
    await measureOpen(page, async () => page.goto(`/documents/${scene.documentId}`))
    const cdp = await page.context().newCDPSession(page)
    const readings = [await reading(page, cdp, 0)]
    const author = await authorApi(scene.author)
    try {
      for (let round = 1; round <= ROUNDS; round += 1) {
        await author.saveVersion(scene.documentId, `第 ${round} 版`)
        await checkEditStatusNow(page)
        await expect(updateButton(page)).toBeVisible()
        await measureSwitch(page, 'refresh', async () => updateButton(page).click())
        await expect(updateButton(page)).toHaveCount(0)
        readings.push(await reading(page, cdp, round))
        await heapSnapshot(cdp, 'refresh', round)
      }
    }
    finally {
      await author.dispose()
    }
    await record('refresh', readings, { ...load, after: loadavg() })
    expect(readings.every(item => item.workers === 1), '每次之后只剩一个公式 Worker').toBe(true)
  })
})
