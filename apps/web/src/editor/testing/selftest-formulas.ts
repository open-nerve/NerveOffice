// 公式时序的页面自检（M3-P4 S1 的 formula-timing，设计 §3.15）：公式样本（./capture-samples.ts，公式不带缓存值、打开时算），
// × Worker/主线程（地址参数选，./formula-mode.ts）。打开时算全部公式；五类（依赖链、聚合、跨表、SUMPRODUCT、易变函数）各改输入、
// "静默窗口内再改一次"、"计算进行中再改一次"（M0 的情形 A、C：同一范围走 stop、别的范围排队）、"超过上限"（上限调到 50 毫秒，
// 带标记捕获、收齐之后补捕获）——按规则捕获（./selftest-capture-rule.ts），捕获里的公式值与按定义算出的一致；每次交回时间线
import type { CaptureLimits } from './capture-reference.ts'
import type { ProbeCommand } from './e2e-probe.ts'
import type { Session } from './selftest-session.ts'
import { FORMULA_PROTOCOL } from '../internal-api/index.ts'
import { CAPTURE_LIMITS } from './capture-reference.ts'
import { FORMULA_SAMPLE, randOf, verifyFormulaSnapshot } from './capture-samples.ts'
import { formulaModeFromSearch } from './formula-mode.ts'
import { CAPTURE_REASON_TEXT, captureByRule, checkEditing, lastCapture, round, sheetNamed, sleep } from './selftest-capture-rule.ts'
import { waitFor } from './selftest-dom.ts'
import { check, CHECK_TIMEOUT_MS, fail, lastSeq, SIGNAL_TIMEOUT_MS } from './selftest-session.ts'

// ---- formula-timing ----

/** 改一格：工作表名、A1 写法、值 */
type Edit = readonly [sheet: string, cell: string, value: number | string]

interface FormulaCaseContext {
  /** 改一格；返回改之前公式的轮数（之后开始的一轮是这次修改引起的） */
  readonly set: (edit: Edit) => number
  /** 等到 roundBefore 之后开始的一轮正在算（开始了、还没完成）；返回那时的进度说明 */
  readonly untilCalculating: (roundBefore: number) => Promise<string>
  /** 立即捕获（不等），按定义核对：过期的有几个 */
  readonly captureNow: () => number
}

/** 改输入之后交回的：不等就捕获时过期的个数（检查本身灵敏的校准）、给说明的补充 */
interface EditOutcome {
  readonly immediateStale?: number
  readonly note?: string
}

interface FormulaCase {
  readonly id: string
  readonly title: string
  readonly limits?: CaptureLimits
  readonly edit: (context: FormulaCaseContext) => Promise<EditOutcome>
}

const { chain: CHAIN, aggregate: AGGREGATE, volatile: VOLATILE } = FORMULA_SAMPLE

/** "静默窗口内再改一次"的两次修改之间隔多久（M0-P3 V07 的做法） */
const QUIET_WINDOW_GAP_MS = 300

/** "超过上限"：上限调到 50 毫秒（M0 的做法，设计 §3.14 的 setLimits） */
const CAP_LIMITS: CaptureLimits = { quietMs: CAPTURE_LIMITS.quietMs, maxMs: 50 }

/**
 * 改了牵动重计算的输入、立即捕获（不等）：计算在 10 ms 的防抖之后才开始，捕获里一定有过期的值——"等公式"确实被检验到了
 * （M0-P3 V07 的"不等待"一列：依赖链 199/199、SUMPRODUCT 200/200）
 */
async function editAndCaptureNow(context: FormulaCaseContext, edit: Edit): Promise<EditOutcome> {
  context.set(edit)
  return { immediateStale: context.captureNow() }
}

const FORMULA_CASES: readonly FormulaCase[] = [
  { id: 'chain', title: '依赖链：改链!A1（199 层的链与依赖它的跨表）', edit: async context => editAndCaptureNow(context, [CHAIN.name, 'A1', 7]) },
  { id: 'aggregate', title: '聚合：改聚合!B1（SUM、AVERAGE、COUNTIF、MAX 与依赖它们的）', edit: async context => editAndCaptureNow(context, [AGGREGATE.name, 'B1', 999]) },
  { id: 'cross-sheet', title: `跨表：改聚合!B${AGGREGATE.rows}（范围的最后一行）`, edit: async context => editAndCaptureNow(context, [AGGREGATE.name, `B${AGGREGATE.rows}`, 3]) },
  { id: 'sumproduct', title: '慢计算：改聚合!B3（SUMPRODUCT 全部重算）', edit: async context => editAndCaptureNow(context, [AGGREGATE.name, 'B3', 0]) },
  {
    id: 'volatile',
    title: '易变函数：改无关的易变!C1（NOW、RAND 等重算，只核对内部一致）',
    edit: async ({ set }) => {
      set([VOLATILE.name, 'C1', '无关的修改'])
      return {}
    },
  },
  {
    id: 'quiet-window',
    title: `静默窗口内再改一次：改链!A1，${QUIET_WINDOW_GAP_MS} 毫秒后改聚合!B1`,
    edit: async ({ set }) => {
      set([CHAIN.name, 'A1', 11])
      await sleep(QUIET_WINDOW_GAP_MS)
      set([AGGREGATE.name, 'B1', 5])
      return {}
    },
  },
  {
    id: 'during-calc.same-range',
    title: '计算进行中再改一次（M0 的情形 A）：改聚合!B1，这一轮在算时再改聚合!B1（范围相交，SDK 发 stop）',
    edit: async ({ set, untilCalculating }) => {
      const seen = await untilCalculating(set([AGGREGATE.name, 'B1', 100]))
      set([AGGREGATE.name, 'B1', 200])
      return { note: `第二次修改时${seen}` }
    },
  },
  {
    id: 'during-calc.other-range',
    title: '计算进行中再改一次（M0 的情形 C）：改聚合!B1，这一轮在算时改链!A1（不相交，排队）',
    edit: async ({ set, untilCalculating }) => {
      const seen = await untilCalculating(set([AGGREGATE.name, 'B1', 300]))
      set([CHAIN.name, 'A1', 13])
      return { note: `第二次修改时${seen}` }
    },
  },
  {
    id: 'cap',
    title: `超过上限（上限调到 ${CAP_LIMITS.maxMs} 毫秒）：改聚合!B1，带"公式待更新"捕获，收齐之后补捕获`,
    limits: CAP_LIMITS,
    edit: async ({ set }) => {
      set([AGGREGATE.name, 'B1', 400])
      return {}
    },
  },
]

/** 命令日志里 mark 之后的公式进度：相对 origin 的毫秒数（没有时 null） */
function formulaTimeline(session: Session, mark: number, origin: number): Record<string, number | null> {
  const executed = session.probe.commands(mark).filter(command => command.phase === 'executed')
  const relative = (command: ProbeCommand | undefined): number | null => command === undefined ? null : round(command.at - origin)
  const of = (id: string): ProbeCommand[] => executed.filter(command => command.id === id)
  const starts = of(FORMULA_PROTOCOL.startMutationId)
  const writebacks = executed.filter(command => command.id === FORMULA_PROTOCOL.setRangeValuesMutationId && command.flags.includes(FORMULA_PROTOCOL.applyResultOption))
  return {
    firstStart: relative(starts[0]),
    lastStart: relative(starts.at(-1)),
    firstStop: relative(of(FORMULA_PROTOCOL.stopMutationId)[0]),
    lastResult: relative(of(FORMULA_PROTOCOL.resultMutationId).at(-1)),
    firstWriteback: relative(writebacks[0]),
    lastWriteback: relative(writebacks.at(-1)),
  }
}

/** 公式收齐与计算的等待最多多久（打开时算全部公式：Worker 的启动与第一次计算） */
const FORMULA_OPEN_TIMEOUT_MS = 30_000

export async function formulaTimingScenario(session: Session): Promise<void> {
  if (!await checkEditing(session))
    return
  const { probe } = session
  const requested = formulaModeFromSearch(window.location.search)
  await check(session, 'formula.mode', async () => {
    if (probe.formulaMode !== requested)
      fail(`地址选的是 ${requested}，编辑器以 ${probe.formulaMode} 创建`)
    return requested === 'worker' ? '公式在 Worker 里计算（地址没有选主线程模式）' : '公式在主线程计算（地址 formula=main：不注册 RPC、让出间隔 20）'
  })
  const opened = await check(session, 'formula.open', async () => {
    // 样本的公式不带缓存值：打开时 SDK 算全部公式（进入编辑时重建，编辑的编辑器又算一遍）；写回带 onlyLocal，不算修改
    const verdict = (): ReturnType<typeof verifyFormulaSnapshot> => verifyFormulaSnapshot(probe.snapshot())
    if (!await waitFor(() => probe.formulasSettled() && verdict().staleCount === 0, FORMULA_OPEN_TIMEOUT_MS, 100)) {
      const last = verdict()
      fail(`${FORMULA_OPEN_TIMEOUT_MS / 1000} 秒内公式没有全部算对（公式${probe.formulasSettled() ? '已' : '没有'}收齐，${last.staleCount}/${last.checked} 个与定义不同：${last.stale.join('、')}）`)
    }
    if (probe.changeSeq() !== 0)
      fail(`打开时算公式被当成了修改：本地修改序号 ${probe.changeSeq()}`)
    return `打开时算出全部 ${verdict().checked} 个公式，与按定义算出的一致；写回不算修改（本地修改序号 0）`
  }, FORMULA_OPEN_TIMEOUT_MS + CHECK_TIMEOUT_MS)
  if (!opened)
    return

  for (const formulaCase of FORMULA_CASES) {
    await check(session, `formula.${formulaCase.id}`, async () => {
      const mark = lastSeq(probe)
      const baseSeq = probe.changeSeq()
      let origin: number | undefined
      const context: FormulaCaseContext = {
        set: ([sheet, cell, value]) => {
          const roundBefore = probe.formulaProgress().round
          origin ??= performance.now()
          sheetNamed(session, sheet).getRange(cell).setValue(value)
          return roundBefore
        },
        untilCalculating: async (roundBefore) => {
          const calculating = (): boolean => {
            const progress = probe.formulaProgress()
            return progress.round > roundBefore && !progress.completed
          }
          if (!await waitFor(calculating, SIGNAL_TIMEOUT_MS, 1)) {
            const progress = probe.formulaProgress()
            fail(`没有等到这次修改引起的一轮正在算（轮数 ${roundBefore} → ${progress.round}，${progress.completed ? '已完成' : '没完成'}）：这一轮太快，样本要加大`)
          }
          const progress = probe.formulaProgress()
          return `第 ${progress.round} 轮正在算（${progress.resultSheets === null ? '还没有结果' : `结果有 ${progress.resultSheets.length} 张表、写回了 ${progress.appliedSheets.length} 张`}，+${round(performance.now() - (origin ?? 0))} ms）`
        },
        captureNow: () => verifyFormulaSnapshot(probe.snapshot()).staleCount,
      }
      const outcome = await formulaCase.edit(context)
      const run = await captureByRule(session, { mark, baseSeq, limits: formulaCase.limits, timeoutMs: 20_000 })
      const start = origin ?? 0
      const final = lastCapture(run)
      const verdict = verifyFormulaSnapshot(final.snapshot)
      const flagged = run.captures.find(capture => capture.formulasPending)
      session.timings.push({
        id: `formula.${formulaCase.id}`,
        ms: {
          ...formulaTimeline(session, mark, start),
          completed: run.completedAt === undefined ? null : round(run.completedAt - start),
          settled: run.settledAt === undefined ? null : round(run.settledAt - start),
          flaggedCapture: flagged === undefined ? null : round(flagged.at - start),
          capture: round(final.at - start),
        },
      })
      const executed = probe.commands(mark).filter(command => command.phase === 'executed')
      const rounds = executed.filter(command => command.id === FORMULA_PROTOCOL.startMutationId).length
      const stops = executed.filter(command => command.id === FORMULA_PROTOCOL.stopMutationId).length
      if (verdict.staleCount > 0)
        fail(`按规则 +${round(final.at - start)} ms 捕获（${CAPTURE_REASON_TEXT[final.reason]}），${verdict.staleCount}/${verdict.checked} 个与定义不同：${verdict.stale.join('、')}（${JSON.stringify(verdict.byKind)}）`)
      if (final.formulasPending)
        fail('最后一次捕获还带着"公式待更新"')
      if (outcome.immediateStale === 0)
        fail('不等就捕获也是对的：这一项没有检验到"等公式"（计算在修改的同一时刻就完成了？）')
      if (formulaCase.limits === CAP_LIMITS) {
        if (flagged === undefined)
          fail(`上限（${CAP_LIMITS.maxMs} 毫秒）到的时候公式已经收齐，没有走到"带标记捕获、收齐之后补捕获"：样本要加大`)
        if (final.reason !== 'recapture')
          fail(`带标记捕获之后的那一次不是补捕获（${CAPTURE_REASON_TEXT[final.reason]}）`)
      }
      const parts = [
        `按规则 +${round(final.at - start)} ms 捕获（${CAPTURE_REASON_TEXT[final.reason]}，共 ${run.captures.length} 次）`,
        flagged === undefined ? undefined : `上限到时 +${round(flagged.at - start)} ms 带"公式待更新"捕获（那时 ${verifyFormulaSnapshot(flagged.snapshot).staleCount} 个过期），收齐之后补捕获`,
        `${verdict.checked} 个公式与按定义算出的一致`,
        `${rounds} 轮${stops > 0 ? `、${stops} 次 stop` : ''}`,
        outcome.immediateStale === undefined ? undefined : `不等就捕获时 ${outcome.immediateStale} 个过期`,
        outcome.note,
      ]
      return `${formulaCase.title}：${parts.filter(part => part !== undefined).join('；')}`
    }, 30_000)
  }

  await check(session, 'formula.volatile-recalculated', async () => {
    // 修改无关的单元格之后 RAND 重算了（M0：两种模式、三个浏览器都重算）：只记下，不影响捕获的正确性
    const before = randOf(probe.snapshot())
    const mark = lastSeq(probe)
    const baseSeq = probe.changeSeq()
    sheetNamed(session, VOLATILE.name).getRange('C2').setValue('再改一处无关的')
    const run = await captureByRule(session, { mark, baseSeq, timeoutMs: 20_000 })
    const after = randOf(lastCapture(run).snapshot)
    const verdict = verifyFormulaSnapshot(lastCapture(run).snapshot)
    if (verdict.staleCount > 0)
      fail(`${verdict.staleCount} 个与定义不同：${verdict.stale.join('、')}`)
    return `RAND ${before === after ? '没有重算（值不变）' : '重算了'}（${String(before)} → ${String(after)}），易变函数内部一致`
  })
}
