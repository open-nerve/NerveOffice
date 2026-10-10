// 真实浏览器复核里生产发件箱的两项（M4-P1 设计 §3.6 第 9 项的生产部分、第 11 项；主会话把 S8 的第二轮并进这一轮），都在阅读时跑。
// 生产的代码经挂接交进来（SelftestHost.outboxReview → features/sheet-editor/outbox/testing/outbox-review-probe.ts）：
// - outbox-stall（第 9 项的生产部分，DEF-011 的定论）：生产的发件箱 Worker（带 100 ms 的空定时器），Worker 空闲 T（≥ 1 秒的三档，
//   ./selftest-stall.ts 的 productionStallSchedule）之后写一份约 5 MiB 的类表格 JSON（字节转移过去、不去重：Worker 里 SHA-256 → gzip → 加密 →
//   写入 strict → OPFS 的镜像），记下页面这一侧的往返与镜像写成了没有。生产的协议不交回 Worker 里各段的计时，往返就是 Worker 段加上来回的消息
//   （探针 Worker 的复核里两段消息都在 1 ms 以内），按它判停顿与 p95（偏保守）；有 OPFS 的上下文里往返含镜像写入（§3.8：IndexedDB 提交之后写进
//   两个槽位之一，截断 → 内容 → 头 → flush）。每一组新起一个 Worker、先热身一次；
// - outbox-pipeline（第 11 项，DEF-012）：进程内走一遍生产的写入与恢复（磁盘上）：SHA-256、gzip、封、写入（生产的存储，strict）、OPFS 的镜像
//   （测试 Worker 里调用生产的镜像：登记、写入，flush 单独计）、同一份记录直接写入 strict 与 default（只差 durability）；恢复：读、解开、解压、
//   解析，镜像那边读两个槽位并与库里那一份比对。约 1 MiB 与约 5 MiB 两档（不带 runs 的校准只有 1 MiB 一次）。Playwright 的 WebKit 默认上下文
//   没有 OPFS（生产的代码按 unsupported 处理）：记下这一条事实，镜像那一段不量。
// 页面只核对"跑完、数据齐"（每一次写成了、读回来解得开、内容一致；有 OPFS 时镜像写成了、读回来最新的就是这一份），交回计时与事实；判定在驱动脚本里
// （tests/e2e/support/probe-verdicts.ts）
import type { OutboxReviewApi } from './outbox-review-api.ts'
import type { SelftestTiming } from './selftest-report.ts'
import type { Session } from './selftest-session.ts'
import { errorName, sleep, tenth } from './probe-bytes.ts'
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

/** 镜像写成了的次数之外，别的结果各几次（例如 not-mirrored:unsupported×40）；都写成了时为 null */
export function mirrorOthers(statuses: readonly (string | null)[]): string | null {
  const counts = new Map<string, number>()
  for (const status of statuses) {
    if (status !== 'mirrored')
      counts.set(status ?? 'none', (counts.get(status ?? 'none') ?? 0) + 1)
  }
  return counts.size === 0 ? null : [...counts].map(([status, count]) => `${status}×${count}`).join('、')
}

/** 可能没有的毫秒（镜像没写成、没读）保留一位小数 */
function tenthOrNull(ms: number | null): number | null {
  return ms === null ? null : tenth(ms)
}

/** 收尾：交回 OPFS 里的镜像目录删成了没有（出了意外时 failed:<名字>） */
async function cleanupOf(review: OutboxReviewApi): Promise<string> {
  return review.cleanup().catch((error: unknown) => `failed:${errorName(error)}`)
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
  const mirrors: (string | null)[] = []
  try {
    for (const [number, block] of blocks.entries()) {
      await check(session, `outbox-stall.block-${number + 1}`, async () => {
        const worker = await active.startWorker()
        try {
          if (worker.ready !== 'ready')
            fail(`生产的发件箱 Worker 起不来：${worker.ready}`)
          facts['outbox-stall.register-mirror'] ??= worker.registerMirror
          // 热身一次（不记）：Worker 的第一次加载、建库与各段的准备不算进来
          await sleep(WARMUP_IDLE_MS)
          const warmup = await worker.write(bytes.slice())
          if (warmup.kind !== 'written')
            fail(`热身的那一次没有写成：${warmup.kind}`)
          facts['outbox-stall.gzip-bytes'] ??= warmup.gzipBytes
          let answeredAt = performance.now()
          const roundTrips: number[] = []
          const blockMirrors: (string | null)[] = []
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
            blockMirrors.push(written.mirror)
            session.timings.push({ id: `outbox-stall#${index}`, ms: { level: block.level.minMs, idle: tenth(actualIdle), roundTrip: tenth(written.roundTripMs), mirrored: written.mirror === 'mirrored' ? 1 : 0 } })
          }
          mirrors.push(...blockMirrors)
          const others = mirrorOthers(blockMirrors)
          const mirrored = blockMirrors.filter(status => status === 'mirrored').length
          return `生产的 Worker（空定时器），空闲 ${block.level.id} × ${block.idles.length}：往返 ${roundTrips.map(tenth).join('、')} ms；OPFS 镜像写成了 ${mirrored} 次${others === null ? '' : `（其余 ${others}）`}`
        }
        finally {
          worker.dispose()
        }
      }, stallBlockBudgetMs(block))
    }
  }
  finally {
    facts['outbox-stall.mirrored'] = mirrors.filter(status => status === 'mirrored').length
    facts['outbox-stall.mirror-others'] = mirrorOthers(mirrors)
    facts['outbox-stall.mirror-cleanup'] = await cleanupOf(active)
  }
}

/** 一次各段的计时（整理成 SelftestTiming 的毫秒；镜像没写成、没读的为 null） */
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
      mirrorAttach: tenthOrNull(segments.mirrorAttachMs),
      mirrorWrite: tenthOrNull(segments.mirrorWriteMs),
      mirrorIo: tenthOrNull(segments.mirrorIoMs),
      mirrorFlush: tenthOrNull(segments.mirrorFlushMs),
      mirrorRead: tenthOrNull(segments.mirrorReadMs),
      mirrorOpen: tenthOrNull(segments.mirrorOpenMs),
      mirrorCompare: tenthOrNull(segments.mirrorCompareMs),
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
        const mirrorWrites: number[] = []
        let mirror = ''
        for (let round = 0; round <= measured; round += 1) {
          const segments = await active.segments(bytes)
          if (segments.problem !== undefined)
            fail(`第 ${round} 次没有走完：${segments.problem}`)
          facts['outbox-pipeline.strict-attribute'] ??= segments.strictAttribute
          facts['outbox-pipeline.default-attribute'] ??= segments.defaultAttribute
          facts['outbox-pipeline.opfs'] ??= segments.mirror
          mirror = segments.mirror
          if (round === 0)
            continue
          session.timings.push(segmentTiming(`outbox-pipeline.${size.id}#${round}`, segments))
          totals.push(segments.digestMs + segments.gzipMs + segments.sealMs + segments.storeWriteMs)
          if (segments.mirrorWriteMs !== null)
            mirrorWrites.push(segments.mirrorWriteMs)
        }
        const opfs = mirror === 'mirrored'
          ? `OPFS 镜像写成了、两个槽位读回来最新的就是这一份（镜像写入 ${mirrorWrites.map(tenth).join('、')} ms）`
          : `这个上下文没有 OPFS 镜像（${mirror}）`
        return `约 ${size.id === '1m' ? '1' : '5'} MiB（${bytes.length} 字节）× ${measured}：写入一侧（SHA-256、gzip、封、写入 strict）合计 ${totals.map(tenth).join('、')} ms；读回来解得开、内容一致；${opfs}`
      }, 120_000)
    }
  }
  finally {
    facts['outbox-pipeline.mirror-cleanup'] = await cleanupOf(active)
  }
}

export const OUTBOX_SCENARIO_RUNNERS = {
  'outbox-stall': outboxStallScenario,
  'outbox-pipeline': outboxPipelineScenario,
} as const
