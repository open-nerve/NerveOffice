// 真实浏览器复核里生产发件箱的两项（M4-P1 设计 §3.6 第 9 项的生产部分、第 11 项；主会话把 S8 的第二轮并进这一轮），都在阅读时跑。
// 生产的代码经挂接交进来（SelftestHost.outboxReview → features/sheet-editor/outbox/testing/outbox-review-probe.ts）：
// - outbox-stall（第 9 项的生产部分，DEF-011 的定论）：生产的发件箱 Worker（带 100 ms 的空定时器），Worker 空闲 T（≥ 1 秒的三档，
//   ./selftest-stall.ts 的 productionStallSchedule）之后写一份约 5 MiB 的类表格 JSON（字节转移过去、不去重：Worker 里 SHA-256 → gzip → 加密 →
//   写入 strict），记下页面这一侧的往返。生产的协议不交回 Worker 里各段的计时，往返就是 Worker 段加上来回的消息（探针 Worker 的复核里两段消息
//   都在 1 ms 以内），按它判停顿与 p95（偏保守）。每一组新起一个 Worker、先热身一次；
// - outbox-pipeline（第 11 项，DEF-012）：进程内走一遍生产的写入与恢复（磁盘上）：SHA-256、gzip、封、写入（生产的存储，strict）、同一份记录直接
//   写入 strict 与 default（只差 durability）；恢复：读、解开、解压、解析。约 1 MiB 与约 5 MiB 两档（不带 runs 的校准只有 1 MiB 一次）。
// 页面只核对"跑完、数据齐"（每一次写成了、读回来解得开、内容一致），交回计时与事实；判定在驱动脚本里（tests/e2e/support/probe-verdicts.ts）
import type { OutboxReviewApi } from './outbox-review-api.ts'
import type { SelftestTiming } from './selftest-report.ts'
import type { Session } from './selftest-session.ts'
import { sleep, tenth } from './probe-bytes.ts'
import { tableJsonBytes } from './probe-measure.ts'
import { check, fail } from './selftest-session.ts'
import { productionStallSchedule, STALL_PAYLOAD_BYTES, stallBlockBudgetMs } from './selftest-stall.ts'

/** 每一组开头热身那一次之前等多久（与探针 Worker 的复核相同） */
const WARMUP_IDLE_MS = 200

/** 进程内各段的两档负载（与捕获成本同样的 1 MiB、约 5 MiB） */
const PIPELINE_SIZES = [{ id: '1m', bytes: 1024 * 1024 }, { id: '5m', bytes: STALL_PAYLOAD_BYTES }] as const

/** 进程内各段每档测几次（预热 1 次不记）：设计 §3.6 第 11 项与 M0 的口径各 10 次；不带 runs 时只有 1 MiB 一次 */
export function pipelineRounds(runs: number | undefined): { readonly sizes: readonly (typeof PIPELINE_SIZES)[number][], readonly measured: number } {
  return runs === undefined ? { sizes: PIPELINE_SIZES.slice(0, 1), measured: 1 } : { sizes: PIPELINE_SIZES, measured: Math.max(1, Math.min(runs, 10)) }
}

/** 生产的发件箱交进来了没有（单元测试里没有） */
async function reviewOf(session: Session): Promise<OutboxReviewApi> {
  const load = session.host.outboxReview
  if (load === undefined)
    fail('编辑器页没有交出生产的发件箱（不是测试构建的挂接？）')
  return load()
}

async function outboxStallScenario(session: Session): Promise<void> {
  const facts = session.facts
  const blocks = productionStallSchedule(session.runs, Math.random)
  let review: OutboxReviewApi | undefined
  const loaded = await check(session, 'outbox-stall.load', async () => {
    review = await reviewOf(session)
    return '生产的发件箱交进来了'
  })
  if (!loaded || review === undefined)
    return
  const active = review
  const bytes = tableJsonBytes(STALL_PAYLOAD_BYTES)
  facts['outbox-stall.payload-bytes'] = bytes.length
  facts['outbox-stall.blocks'] = blocks.length
  facts['outbox-stall.iterations'] = blocks.reduce((total, block) => total + block.idles.length, 0)
  let index = 0
  try {
    for (const [number, block] of blocks.entries()) {
      await check(session, `outbox-stall.block-${number + 1}`, async () => {
        const worker = await active.startWorker()
        try {
          if (worker.ready !== 'ready')
            fail(`生产的发件箱 Worker 起不来：${worker.ready}`)
          // 热身一次（不记）：Worker 的第一次加载、建库与各段的准备不算进来
          await sleep(WARMUP_IDLE_MS)
          const warmup = await worker.write(bytes.slice())
          if (warmup.kind !== 'written')
            fail(`热身的那一次没有写成：${warmup.kind}`)
          facts['outbox-stall.gzip-bytes'] ??= warmup.gzipBytes
          let answeredAt = performance.now()
          const roundTrips: number[] = []
          for (const idle of block.idles) {
            const copy = bytes.slice()
            await sleep(Math.max(0, idle - (performance.now() - answeredAt)))
            const sentAt = performance.now()
            const written = await worker.write(copy)
            const actualIdle = sentAt - answeredAt
            answeredAt = performance.now()
            if (written.kind !== 'written')
              fail(`第 ${index + 1} 次没有写成：${written.kind}`)
            index += 1
            roundTrips.push(written.roundTripMs)
            session.timings.push({ id: `outbox-stall#${index}`, ms: { level: block.level.minMs, idle: tenth(actualIdle), roundTrip: tenth(written.roundTripMs) } })
          }
          return `生产的 Worker（空定时器），空闲 ${block.level.id} × ${block.idles.length}：往返 ${roundTrips.map(tenth).join('、')} ms`
        }
        finally {
          worker.dispose()
        }
      }, stallBlockBudgetMs(block))
    }
  }
  finally {
    await active.cleanup().catch(() => {})
  }
}

/** 一次各段的计时（整理成 SelftestTiming 的毫秒） */
function segmentTiming(id: string, segments: Awaited<ReturnType<OutboxReviewApi['segments']>>): SelftestTiming {
  return {
    id,
    ms: {
      rawBytes: segments.rawBytes,
      gzipBytes: segments.gzipBytes,
      digest: tenth(segments.digestMs),
      gzip: tenth(segments.gzipMs),
      seal: tenth(segments.sealMs),
      storeWrite: tenth(segments.storeWriteMs),
      rawStrict: tenth(segments.rawStrictMs),
      rawDefault: tenth(segments.rawDefaultMs),
      read: tenth(segments.readMs),
      open: tenth(segments.openMs),
      gunzip: tenth(segments.gunzipMs),
      parse: tenth(segments.parseMs),
    },
  }
}

async function outboxPipelineScenario(session: Session): Promise<void> {
  const facts = session.facts
  const { sizes, measured } = pipelineRounds(session.runs)
  let review: OutboxReviewApi | undefined
  const loaded = await check(session, 'outbox-pipeline.load', async () => {
    review = await reviewOf(session)
    return '生产的发件箱交进来了'
  })
  if (!loaded || review === undefined)
    return
  const active = review
  try {
    for (const size of sizes) {
      await check(session, `outbox-pipeline.${size.id}`, async () => {
        const bytes = tableJsonBytes(size.bytes)
        facts[`outbox-pipeline.${size.id}-raw-bytes`] = bytes.length
        const totals: number[] = []
        for (let round = 0; round <= measured; round += 1) {
          const segments = await active.segments(bytes)
          if (segments.problem !== undefined)
            fail(`第 ${round} 次没有走完：${segments.problem}`)
          facts['outbox-pipeline.strict-attribute'] ??= segments.strictAttribute
          facts['outbox-pipeline.default-attribute'] ??= segments.defaultAttribute
          if (round === 0)
            continue
          session.timings.push(segmentTiming(`outbox-pipeline.${size.id}#${round}`, segments))
          totals.push(segments.digestMs + segments.gzipMs + segments.sealMs + segments.storeWriteMs)
        }
        return `约 ${size.id === '1m' ? '1' : '5'} MiB（${bytes.length} 字节）× ${measured}：写入一侧（SHA-256、gzip、封、写入 strict）合计 ${totals.map(tenth).join('、')} ms；读回来解得开、内容一致`
      }, 120_000)
    }
  }
  finally {
    await active.cleanup().catch(() => {})
  }
}

export const OUTBOX_SCENARIO_RUNNERS = {
  'outbox-stall': outboxStallScenario,
  'outbox-pipeline': outboxPipelineScenario,
} as const
