// 真实浏览器的前置复核（M4-P1 设计 §3.6 第 9 项，DEF-011）：Worker 空闲多久之后，第一次异步操作的用时（worker-stall，阅读时跑）。
// M0 在 Playwright 的 WebKit 上看到：Worker 放置、约 5 MiB、Worker 空闲约 1 秒以上时，60 次里 8 次多出约 1 秒，落在 Worker 里的第一次异步操作
// （SHA-256；把它挪走之后落在 CompressionStream），消息的两段都不到 1 ms；Worker 开着 100 ms 的空定时器之后 40 次 0 次（M0-P6 报告，原因没查到）。
// 这里在真实 Safari 上用不依赖生产代码的探针 Worker（./storage-probe-worker.ts）复核：
// - 两个条件：探针 Worker 有、没有空定时器；每一组新起一个 Worker（两个 Worker 不同时存在），先热身一次（不记）；
// - 空闲多久（从 Worker 上一次做完算起）：0.2 秒（M0 没出现的对照）、1–1.5 秒（M0 出现的条件，均匀随机）、3 秒、10 秒；1–1.5 秒每个条件 runs 次，
//   其余按比例（stallSchedule）；两个条件用同一串空闲（成对比较），一组最多 STALL_BLOCK_SIZE 次，各档轮流、两个条件的先后轮流；
// - 每一次：把约 5 MiB 的类表格 JSON 复制一份转移给 Worker，Worker 依次做 SHA-256 → gzip → AES-GCM → IndexedDB（strict），交回各段（与 M0 的管道相同）。
// 交回每一次的计时（timings 的 stall#n）；停顿的判定（比同条件的中位数多出 ≥ 500 ms）在驱动脚本里（tests/e2e/support/probe-verdicts.ts），
// 页面只核对每一次都做完、数都在。地址不带 runs（Playwright 的校准）时只跑 0.2 秒与 1–1.5 秒两档各一次：只核对探针本身
import type { SelftestTiming } from './selftest-report.ts'
import type { Session } from './selftest-session.ts'
import type { ProbeWorker } from './storage-probe-client.ts'
import type { PipelineTimes } from './storage-probe-protocol.ts'
import { deleteDatabase, probeDatabaseName, sleep, tenth, wallNow } from './probe-bytes.ts'
import { tableJsonBytes } from './probe-measure.ts'
import { check, fail } from './selftest-session.ts'
import { startProbeWorker } from './storage-probe-client.ts'

/** 一档空闲：最短与最长（毫秒，均匀随机），相对 runs 的次数 */
export interface StallLevel {
  readonly id: string
  readonly minMs: number
  readonly maxMs: number
  readonly share: number
}

export const STALL_LEVELS: readonly StallLevel[] = [
  { id: '0.2s', minMs: 200, maxMs: 200, share: 0.5 },
  { id: '1-1.5s', minMs: 1_000, maxMs: 1_500, share: 1 },
  { id: '3s', minMs: 3_000, maxMs: 3_000, share: 0.25 },
  { id: '10s', minMs: 10_000, maxMs: 10_000, share: 0.125 },
]

/** 一组最多几次（之后换一个新的 Worker、换一个条件） */
export const STALL_BLOCK_SIZE = 10

/** 负载：约 5 MiB 的类表格 JSON（M0 的 big-5m） */
export const STALL_PAYLOAD_BYTES = 5 * 1024 * 1024

/** 每一组开头热身那一次之前等多久 */
const WARMUP_IDLE_MS = 200

/** 预算里每一次留多少（5 MiB 的管道：真实 Safari 约 0.2–0.3 秒，CI 的慢机器上也在一两秒以内） */
const ITERATION_ALLOWANCE_MS = 3_000

/** 预算里每一组另留多少（起 Worker、握手、建库） */
const BLOCK_ALLOWANCE_MS = 15_000

/** 一次请求最多等多久：超过就是这一次没做完（停顿是一两秒，不会到这里） */
const ITERATION_TIMEOUT_MS = 30_000

/** 一组：有没有空定时器、哪一档、每一次的空闲 */
export interface StallBlock {
  readonly keepAlive: boolean
  readonly level: StallLevel
  readonly idles: readonly number[]
}

/** 一档的 count 次空闲，切成每组最多 STALL_BLOCK_SIZE 次；区间的档按 random 取值（取整），固定的档不取 */
function chunksOf(level: StallLevel, count: number, random: () => number): number[][] {
  const chunks: number[][] = []
  for (let start = 0; start < count; start += STALL_BLOCK_SIZE) {
    const size = Math.min(STALL_BLOCK_SIZE, count - start)
    chunks.push(Array.from({ length: size }, () => level.maxMs === level.minMs ? level.minMs : Math.round(level.minMs + random() * (level.maxMs - level.minMs))))
  }
  return chunks
}

/** 各档轮流排成组：第 round 轮里每一档的第 round 组，按 conditions(round, 档的序号) 给的条件各排一组（同一串空闲） */
function interleave(perLevel: readonly { readonly level: StallLevel, readonly chunks: readonly (readonly number[])[] }[], conditions: (round: number, index: number) => readonly boolean[]): StallBlock[] {
  const blocks: StallBlock[] = []
  const rounds = Math.max(...perLevel.map(entry => entry.chunks.length))
  for (let round = 0; round < rounds; round += 1) {
    perLevel.forEach(({ level, chunks }, index) => {
      const idles = chunks[round]
      if (idles === undefined)
        return
      for (const keepAlive of conditions(round, index))
        blocks.push({ keepAlive, level, idles })
    })
  }
  return blocks
}

/**
 * 这一次运行的编排（纯函数）：runs 是 1–1.5 秒那一档每个条件的次数，其余各档按 share 的比例、至少一次；不带 runs（Playwright 的校准）时
 * 只有 0.2 秒与 1–1.5 秒两档各一次。random 给区间的那一档（1–1.5 秒）取值（页面用 Math.random），固定的档不取
 */
export function stallSchedule(runs: number | undefined, random: () => number): StallBlock[] {
  const levels = runs === undefined ? STALL_LEVELS.slice(0, 2) : STALL_LEVELS
  const perLevel = levels.map(level => ({ level, chunks: chunksOf(level, runs === undefined ? 1 : Math.max(1, Math.round(runs * level.share)), random) }))
  return interleave(perLevel, (round, index) => (round + index) % 2 === 0 ? [false, true] : [true, false])
}

/**
 * 生产的发件箱 Worker 的编排（设计 §3.6 第 9 项的生产部分：带空定时器，T ≥ 1 秒）：只有一个条件（生产的 Worker 一律开着空定时器），
 * 只有 ≥ 1 秒的三档，次数与 stallSchedule 同一个比例（runs 40：1–1.5 秒 40 次、3 秒 10 次、10 秒 5 次，共 55 次）；
 * 不带 runs（Playwright 的校准）时只有 1–1.5 秒一次
 */
export function productionStallSchedule(runs: number | undefined, random: () => number): StallBlock[] {
  const levels = STALL_LEVELS.filter(level => level.minMs >= 1_000).slice(0, runs === undefined ? 1 : undefined)
  const perLevel = levels.map(level => ({ level, chunks: chunksOf(level, runs === undefined ? 1 : Math.max(1, Math.round(runs * level.share)), random) }))
  return interleave(perLevel, () => [true])
}

/** 一组最多用多久：热身、各次的空闲与每次的余量 */
export function stallBlockBudgetMs(block: StallBlock): number {
  return WARMUP_IDLE_MS + block.idles.reduce((total, idle) => total + idle, 0) + (block.idles.length + 1) * ITERATION_ALLOWANCE_MS + BLOCK_ALLOWANCE_MS
}

/** 整个场景最多用多久（selftest.ts 的场景预算）：各组之和再加准备的余量 */
export function stallBudgetMs(runs: number | undefined): number {
  // 按最长的空闲估：1–1.5 秒那一档取 1.5 秒
  return stallSchedule(runs, () => 1).reduce((total, block) => total + stallBlockBudgetMs(block), 60_000)
}

/** 生产的发件箱 Worker 那一步最多用多久（同上的估法） */
export function productionStallBudgetMs(runs: number | undefined): number {
  return productionStallSchedule(runs, () => 1).reduce((total, block) => total + stallBlockBudgetMs(block), 60_000)
}

/** 一次的结果：Worker 交回的各段，加上页面这一侧的空闲、送达（发出到 Worker 收到）、交回（Worker 做完到页面收到）与往返（墙上时间） */
interface Iteration {
  readonly idle: number
  readonly times: PipelineTimes
  readonly send: number
  readonly back: number
  readonly roundTrip: number
}

/**
 * 发一次：等到 Worker 从上一次做完起空闲了 idleMs，转移 payload 的一份拷贝过去，等它交回。copy 在等之前就复制好，计时里没有复制
 */
async function sendAfterIdle(worker: ProbeWorker, payload: Uint8Array<ArrayBuffer>, idleMs: number, previousDoneAt: number): Promise<Iteration> {
  const copy = payload.slice()
  await sleep(Math.max(0, idleMs - (wallNow() - previousDoneAt)))
  const sentAt = wallNow()
  const times = await worker.call('pipeline', { bytes: copy, store: 'strict' }, { transfer: [copy.buffer], timeoutMs: ITERATION_TIMEOUT_MS })
  const answeredAt = wallNow()
  return { idle: sentAt - previousDoneAt, times, send: times.receivedAt - sentAt, back: answeredAt - times.doneAt, roundTrip: answeredAt - sentAt }
}

function timingOf(index: number, block: StallBlock, iteration: Iteration): SelftestTiming {
  const { times } = iteration
  return {
    id: `stall#${index}`,
    ms: {
      keepAlive: block.keepAlive ? 1 : 0,
      level: block.level.minMs,
      idle: tenth(iteration.idle),
      send: tenth(iteration.send),
      digest: tenth(times.digestMs),
      gzip: tenth(times.gzipMs),
      encrypt: tenth(times.encryptMs),
      put: tenth(times.putMs),
      worker: tenth(times.workerMs),
      back: tenth(iteration.back),
      roundTrip: tenth(iteration.roundTrip),
    },
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

async function workerStallScenario(session: Session): Promise<void> {
  const facts = session.facts
  const blocks = stallSchedule(session.runs, Math.random)
  const payload = tableJsonBytes(STALL_PAYLOAD_BYTES)
  facts['stall.payload-bytes'] = payload.length
  facts['stall.blocks'] = blocks.length
  facts['stall.iterations'] = blocks.reduce((total, block) => total + block.idles.length, 0)
  facts['stall.keep-alive-ms'] = 100
  let index = 0
  for (const [number, block] of blocks.entries()) {
    const condition = `${block.keepAlive ? '有' : '没有'}空定时器，空闲 ${block.level.id}`
    await check(session, `stall.block-${number + 1}`, async () => {
      const database = probeDatabaseName('stall')
      const worker = startProbeWorker()
      try {
        await worker.call('hello', { keepAlive: block.keepAlive, database })
        // 热身一次（不记）：Worker 的第一次加载、第一次打开库与第一次各段的准备不算进来
        const warmup = await sendAfterIdle(worker, payload, WARMUP_IDLE_MS, wallNow())
        facts['stall.gzip-bytes'] ??= warmup.times.gzipBytes
        let doneAt = warmup.times.doneAt
        const digests: number[] = []
        for (const idle of block.idles) {
          const iteration = await sendAfterIdle(worker, payload, idle, doneAt)
          doneAt = iteration.times.doneAt
          index += 1
          session.timings.push(timingOf(index, block, iteration))
          digests.push(iteration.times.digestMs)
          if (!Number.isFinite(iteration.times.workerMs))
            fail(`第 ${index} 次的计时不全`)
        }
        await worker.call('close', {})
        return `${condition} × ${block.idles.length}：SHA-256 中位数 ${tenth(median(digests))} ms、最长 ${tenth(Math.max(...digests))} ms`
      }
      finally {
        worker.terminate()
        await deleteDatabase(database).catch(() => {})
      }
    }, stallBlockBudgetMs(block))
  }
}

export const STALL_SCENARIO_RUNNERS = {
  'worker-stall': workerStallScenario,
} as const
