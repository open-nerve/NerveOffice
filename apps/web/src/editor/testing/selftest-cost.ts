// 真实浏览器的前置复核（M4-P1 设计 §3.6，DEF-012）里与编辑器有关的两项，都在编辑时跑（挂接先进入编辑：生产的捕获与公式计算都在编辑时）：
// - capture-cost（第 10 项，M0-P3 V08 的口径）：按约 1 MiB、约 5 MiB 两份样本（./capture-samples.ts 的明细表），
//   · 同步段：workbook.save()、JSON.stringify、TextEncoder.encode 分开计（预热 2 次，测 N 次；计划书 §12.2：1 MiB 的 p95 ≤ 100 ms）；
//   · Worker 放置：编码好的字节转移给探针 Worker（开着空定时器，与生产相同），Worker 做 SHA-256 → gzip → AES-GCM → IndexedDB（strict）——
//     这一段（异步段）里主线程最长被占住多久（事件循环与动画帧，./probe-measure.ts），设计期望约 10 ms 以内；
//   · 主线程放置（WebKit 的退路，M4 总设计 §6.1）：同样的字节在主线程上 gzip，这一段主线程最长被占住多久（退路的前提是 ≤ 100 ms）；
//     再把整条管道（SHA-256 → gzip → AES-GCM → IndexedDB strict）在主线程上走一遍，各段与主线程的最长阻塞。
//   这个场景不改内容；
// - perf-baseline（第 12 项，M0-P3 V10 的口径，perf-50k：5 万格、1,000 个公式，带缓存值），× Worker/主线程（地址参数选，./formula-mode.ts）：
//   · 首屏：编辑器页从导航开始到第一次渲染完成（容器第一次到 ready）与到 steady（挂接在载入之前就订阅了页面的状态，SelftestHost.firstLoad）；
//     这一页的脚本经网络传了多少（资源计时的 transferSize）：一次运行里第一次打开编辑器页的是冷的，之后的是热的（带哈希的资源一年内不变）；
//   · 公式：增量（改数据表 D 列的一格，牵动约 320 个公式）N 次、全量（强制重算 1,000 个公式）N 次：到这一轮收齐的时间，期间主线程的最长阻塞与
//     最长的帧间隔（界面冻结）。第一次增量离 steady 多久另记（冷热对照时两边的空闲要相当，M4-P1 复核 B5）。改了内容（暂停定时的上传：
//     交回结果整页跳走时页面隐藏，自动保存会在那一刻上传）。
// 两个场景都只交回计时与事实；是否达标在驱动脚本里判定（tests/e2e/support/probe-verdicts.ts）。
// 自动保存：暂停定时的上传、捕获的静默与上限调到一小时——调度的捕获（主线程上的 save 与序列化）不落进计时里
import type { AutosaveSetup } from './selftest-autosave.ts'
import type { Session } from './selftest-session.ts'
import { formulaCount, perfIncrementalEdit } from './capture-samples.ts'
import { deleteDatabase, gzipBytes, openDatabase, probeDatabaseName, requestResult, tenth, transactionDone } from './probe-bytes.ts'
import { watchMainThread } from './probe-measure.ts'
import { checkEditing, sheetNamed } from './selftest-capture-common.ts'
import { waitFor } from './selftest-dom.ts'
import { forceRecalculation, roundStart } from './selftest-formulas.ts'
import { check, fail, lastSeq } from './selftest-session.ts'
import { startProbeWorker } from './storage-probe-client.ts'

/** 不让调度捕获：定时的上传暂停，捕获的静默与上限调到一小时 */
const NO_CAPTURE: AutosaveSetup = { mode: 'held', limits: { captureQuietMs: 3_600_000, captureMaxMs: 3_600_000 } }

/** 捕获成本：预热几次（不记）、测几次（设计 §3.6 与 M0：预热 2 次测 10 次；不带 runs 的校准测 1 次） */
export function captureCounts(runs: number | undefined): { readonly warmups: number, readonly measured: number } {
  return { warmups: 2, measured: runs === undefined ? 1 : Math.max(1, Math.min(runs, 10)) }
}

/** 公式：增量与全量各几次（M0 V10：增量 5 次、全量 3 次；不带 runs 的校准各 1 次） */
export function perfCounts(runs: number | undefined): { readonly incremental: number, readonly full: number } {
  return runs === undefined ? { incremental: 1, full: 1 } : { incremental: Math.max(1, Math.min(runs, 5)), full: Math.max(1, Math.min(runs, 3)) }
}

/** 捕获成本整组最多用多久（5 MiB × 12 轮 × 四段，CI 的慢机器上也够） */
const CAPTURE_TIMEOUT_MS = 170_000

/** 一轮公式计算最多等多久（1,000 个公式；主线程模式每 20 个让出一次） */
const FORMULA_ROUND_TIMEOUT_MS = 60_000

/** 页面上的工作簿：只用 save（与编辑器的捕获相同：JSON.stringify(save())） */
interface SaveApi {
  readonly getActiveWorkbook: () => { readonly save: () => unknown } | null
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

// ---- capture-cost ----

async function captureCostScenario(session: Session): Promise<void> {
  if (!await checkEditing(session, NO_CAPTURE))
    return
  const facts = session.facts
  const { warmups, measured } = captureCounts(session.runs)
  const encoder = new TextEncoder()
  await check(session, 'capture.sample', async () => {
    const bytes = encoder.encode(session.probe.snapshot())
    facts['capture.raw-bytes'] = bytes.length
    facts['capture.gzip-bytes'] = (await gzipBytes(bytes)).length
    facts['capture.formula-mode'] = session.probe.formulaMode
    return `样本：快照 ${bytes.length} 字节，gzip 之后 ${String(facts['capture.gzip-bytes'])} 字节；公式在${session.probe.formulaMode === 'worker' ? ' Worker 里' : '主线程'}计算`
  })
  const workerDatabase = probeDatabaseName('capture-worker')
  const pageDatabaseName = probeDatabaseName('capture-page')
  const worker = startProbeWorker()
  let pageDatabase: IDBDatabase | undefined
  try {
    await check(session, 'capture.cost', async () => {
      await worker.call('hello', { keepAlive: true, database: workerDatabase })
      const database = await openDatabase(pageDatabaseName, 1, (created) => {
        created.createObjectStore('drafts')
      })
      pageDatabase = database
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      const syncTotals: number[] = []
      const workerLags: number[] = []
      const gzipLags: number[] = []
      for (let round = 0; round < warmups + measured; round += 1) {
        const index = round - warmups + 1
        const record = index >= 1
        // 1. 同步段：与编辑器的捕获相同（save → 序列化 → 编码一次）
        const workbook = (session.probe.univerAPI as unknown as SaveApi).getActiveWorkbook()
        if (workbook === null)
          fail('没有活动的工作簿')
        const t0 = performance.now()
        const data = workbook.save()
        const t1 = performance.now()
        const text = JSON.stringify(data)
        const t2 = performance.now()
        const bytes = encoder.encode(text)
        const t3 = performance.now()
        // 2. Worker 放置：转移一份拷贝过去（主线程放置的两段还要用这一份），这一段里看主线程
        const copy = bytes.slice()
        const workerWatch = watchMainThread()
        const w0 = performance.now()
        const times = await worker.call('pipeline', { bytes: copy, store: 'strict' }, { transfer: [copy.buffer], timeoutMs: 60_000 })
        const workerRoundTrip = performance.now() - w0
        const workerStats = await workerWatch.stop()
        // 3. 主线程上 gzip（WebKit 的退路的前提）
        const gzipWatch = watchMainThread()
        const g0 = performance.now()
        const gzip = await gzipBytes(bytes)
        const gzipMs = performance.now() - g0
        const gzipStats = await gzipWatch.stop()
        // 4. 主线程上整条管道
        const pipeWatch = watchMainThread()
        const p0 = performance.now()
        await crypto.subtle.digest('SHA-256', bytes)
        const p1 = performance.now()
        const compressed = await gzipBytes(bytes)
        const p2 = performance.now()
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('probe') }, key, compressed))
        const p3 = performance.now()
        const transaction = database.transaction('drafts', 'readwrite', { durability: 'strict' })
        await requestResult(transaction.objectStore('drafts').put({ iv, ciphertext }, 'draft'))
        await transactionDone(transaction)
        const p4 = performance.now()
        const pipeStats = await pipeWatch.stop()
        if (!record)
          continue
        syncTotals.push(t3 - t0)
        workerLags.push(workerStats.lagMax)
        gzipLags.push(gzipStats.lagMax)
        session.timings.push(
          { id: `capture.sync#${index}`, ms: { save: tenth(t1 - t0), stringify: tenth(t2 - t1), encode: tenth(t3 - t2), total: tenth(t3 - t0) } },
          { id: `capture.worker#${index}`, ms: { roundTrip: tenth(workerRoundTrip), worker: tenth(times.workerMs), digest: tenth(times.digestMs), gzip: tenth(times.gzipMs), encrypt: tenth(times.encryptMs), put: tenth(times.putMs), lagMax: workerStats.lagMax, frameMax: workerStats.frameMax } },
          { id: `capture.main-gzip#${index}`, ms: { total: tenth(gzipMs), bytes: gzip.length, lagMax: gzipStats.lagMax, frameMax: gzipStats.frameMax } },
          { id: `capture.main-pipeline#${index}`, ms: { total: tenth(p4 - p0), digest: tenth(p1 - p0), gzip: tenth(p2 - p1), encrypt: tenth(p3 - p2), put: tenth(p4 - p3), lagMax: pipeStats.lagMax, frameMax: pipeStats.frameMax } },
        )
      }
      return `预热 ${warmups} 次、测 ${measured} 次：同步段中位数 ${tenth(median(syncTotals))} ms；Worker 放置时主线程最长阻塞的中位数 ${tenth(median(workerLags))} ms；主线程 gzip 时 ${tenth(median(gzipLags))} ms`
    }, CAPTURE_TIMEOUT_MS)
  }
  finally {
    await worker.call('close', {}).catch(() => {})
    worker.terminate()
    pageDatabase?.close()
    await deleteDatabase(workerDatabase).catch(() => {})
    await deleteDatabase(pageDatabaseName).catch(() => {})
  }
}

// ---- perf-baseline ----

/** 这一页经网络取的脚本（资源计时）：个数、传了多少字节（缓存命中时 transferSize 是 0）、解压之后多少 */
function scriptResources(): { readonly entries: number, readonly transfer: number, readonly decoded: number } {
  const scripts = performance.getEntriesByType('resource')
    .map(entry => entry as PerformanceResourceTiming)
    .filter(entry => entry.initiatorType === 'script' || new URL(entry.name).pathname.endsWith('.js'))
  return {
    entries: scripts.length,
    transfer: scripts.reduce((total, entry) => total + entry.transferSize, 0),
    decoded: scripts.reduce((total, entry) => total + entry.decodedBodySize, 0),
  }
}

/** 做一件引起公式计算的事，等这一轮收齐（这件事之后开始了一轮，而且收齐了）：交回用时与期间的主线程 */
async function measureRound(session: Session, act: () => unknown): Promise<{ readonly settle: number, readonly lagMax: number, readonly frameMax: number | null, readonly frames: number }> {
  const probe = session.probe
  const mark = lastSeq(probe)
  const watch = watchMainThread()
  const started = performance.now()
  const acted = act()
  if (!await waitFor(() => roundStart(probe, mark) !== undefined && probe.formulasSettled(), FORMULA_ROUND_TIMEOUT_MS, 5))
    fail(`${FORMULA_ROUND_TIMEOUT_MS / 1000} 秒内这一轮没有收齐（${JSON.stringify(probe.formulaProgress())}）`)
  const settle = performance.now() - started
  await acted
  const stats = await watch.stop()
  return { settle: tenth(settle), ...stats }
}

async function perfBaselineScenario(session: Session): Promise<void> {
  if (!await checkEditing(session, NO_CAPTURE))
    return
  const facts = session.facts
  const counts = perfCounts(session.runs)
  await check(session, 'perf.first-load', async () => {
    const { ready, steady } = session.host.firstLoad()
    const scripts = scriptResources()
    facts['perf.ready'] = ready === null ? null : tenth(ready)
    facts['perf.steady'] = steady === null ? null : tenth(steady)
    facts['perf.script-entries'] = scripts.entries
    facts['perf.script-transfer-bytes'] = scripts.transfer
    facts['perf.script-decoded-bytes'] = scripts.decoded
    facts['perf.formula-mode'] = session.probe.formulaMode
    facts['perf.formulas'] = formulaCount(session.probe.snapshot())
    if (ready === null || steady === null)
      fail('挂接没有记下第一次载入的时刻')
    return `首屏（阅读）：导航开始到渲染完成 ${tenth(ready)} ms、到 steady ${tenth(steady)} ms；脚本 ${scripts.entries} 个，经网络 ${scripts.transfer} 字节（解压之后 ${scripts.decoded}）；${String(facts['perf.formulas'])} 个公式，在${session.probe.formulaMode === 'worker' ? ' Worker 里' : '主线程'}计算`
  })
  await check(session, 'perf.settled', async () => {
    if (!await waitFor(() => session.probe.formulasSettled(), FORMULA_ROUND_TIMEOUT_MS, 50))
      fail('进入编辑之后公式一直没有收齐')
    return '进入编辑之后公式已收齐'
  }, FORMULA_ROUND_TIMEOUT_MS + 5_000)
  await check(session, 'perf.incremental', async () => {
    const settles: number[] = []
    const { steady } = session.host.firstLoad()
    facts['perf.first-edit-after-steady'] = steady === null ? null : tenth(performance.now() - steady)
    for (let index = 0; index < counts.incremental; index += 1) {
      const edit = perfIncrementalEdit(index)
      const result = await measureRound(session, () => sheetNamed(session, edit.sheet).getRange(edit.cell).setValue(edit.value))
      settles.push(result.settle)
      session.timings.push({ id: `perf.incremental#${index + 1}`, ms: result })
    }
    return `增量（改数据表 D 列，牵动约 320 个公式）${counts.incremental} 次：收齐 ${settles.join('、')} ms`
  }, counts.incremental * FORMULA_ROUND_TIMEOUT_MS + 5_000)
  await check(session, 'perf.full', async () => {
    const settles: number[] = []
    for (let index = 0; index < counts.full; index += 1) {
      const result = await measureRound(session, async () => forceRecalculation(session.probe))
      settles.push(result.settle)
      session.timings.push({ id: `perf.full#${index + 1}`, ms: result })
    }
    return `全量（强制重算 1,000 个公式）${counts.full} 次：收齐 ${settles.join('、')} ms`
  }, counts.full * FORMULA_ROUND_TIMEOUT_MS + 5_000)
}

export const COST_SCENARIO_RUNNERS = {
  'capture-cost': captureCostScenario,
  'perf-baseline': perfBaselineScenario,
} as const
