// 公式时序的页面自检（M3-P4 S1 的 formula-timing，设计 §3.15）：公式样本（./capture-samples.ts，公式不带缓存值、打开时算），
// × Worker/主线程（地址参数选，./formula-mode.ts）。打开时算全部公式；五类（依赖链、聚合、跨表、SUMPRODUCT、易变函数）各改输入、
// "静默窗口内再改一次"、"计算进行中再改一次"（M0 的情形 A、C：同一范围走 stop、别的范围排队）、"超过上限"（上限调到 50 毫秒，
// 带标记捕获、收齐之后补捕获）——按规则捕获（./selftest-capture-rule.ts），捕获里的公式值与按定义算出的一致；每次交回时间线。
// 最后一项"计算进行中重建"（主会话 2026-10-05 追加，要核实的说法：主线程模式下 Univer 实例销毁时正在算的那一轮会继续跑完，把只会得出
// #NAME? 的语法树写进 engine-formula 模块级的缓存 FORMULA_AST_CACHE，之后同一页里新建的实例打开同一份文档会命中它们）：退出编辑，
// 阅读时强制重算，这一轮还在算时点"编辑"重建，新的编辑器里再强制重算一遍，全部公式按定义核对。Worker 模式是对照（缓存在 Worker 里，
// 重建时 Worker 随旧的编辑器终止）
import type { CaptureLimits } from './capture-reference.ts'
import type { EditorProbe, ProbeCommand } from './e2e-probe.ts'
import type { Session } from './selftest-session.ts'
import { FORMULA_PROTOCOL } from '../internal-api/index.ts'
import { CAPTURE_LIMITS } from './capture-reference.ts'
import { FORMULA_SAMPLE, randOf, verifyFormulaSnapshot } from './capture-samples.ts'
import { CAPTURE_REASON_TEXT, captureByRule, checkEditing, lastCapture, round, sheetNamed, sleep } from './selftest-capture-rule.ts'
import { waitFor } from './selftest-dom.ts'
import { FORMULA_MODE_PARAM, formulaModeOfValue } from './selftest-report.ts'
import { adoptEditor, check, CHECK_TIMEOUT_MS, chromeButton, describeView, fail, lastSeq, SIGNAL_TIMEOUT_MS, SWITCH_TIMEOUT_MS, untilSwitched } from './selftest-session.ts'

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
  await check(session, 'formula.mode', async () => {
    // 地址选的模式另按参数的写法读（不经编辑器的开关 formula-mode.ts，它写错了这里也看得出来）
    const value = new URLSearchParams(window.location.search).get(FORMULA_MODE_PARAM)
    const requested = formulaModeOfValue(value)
    if (requested === null)
      fail(`地址里的 ${FORMULA_MODE_PARAM}=${String(value)} 不认识`)
    if (probe.formulaMode !== (requested ?? 'worker'))
      fail(`地址选的是 ${requested ?? 'worker（没有选）'}，编辑器以 ${probe.formulaMode} 创建`)
    return probe.formulaMode === 'worker' ? `公式在 Worker 里计算（地址${requested === undefined ? '没有选' : '选了 Worker'}）` : '公式在主线程计算（地址 formula=main：不注册 RPC、让出间隔 20）'
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

  await rebuildDuringCalculation(session)
}

// ---- 计算进行中重建 ----

/**
 * 阅读时强制重算开始之后多久才点"编辑"：sheets-formula 收到一轮开始的通知（stage 为 START 的进度通知）时设一个 1 秒的进度计时器
 * （到点调 LocaleService.t），旧的编辑器在它到点之前销毁，到点就是一条"[LocaleService]: Locale not initialized"的页面异常——那是另一个
 * 问题，main 的 f755729 已修，而写这一项时 S1 的分支（基于 b547644）还没有它。所以从这一轮第一条进度通知在主线程上执行的时刻算起
 * （Worker 模式下它比开始的 mutation 晚，WebKit 里晚得更多），计时器按到期的先后执行：自检的轮询看到已经过了 1.2 秒时，那个 1 秒的
 * 计时器已经执行过了；这里只看语法树缓存这一件事。合并进有 f755729 的分支之后，这层等待可以缩短（点"编辑"越早，旧的一轮剩得越多）
 */
const REBUILD_AFTER_START_MS = 1_200

/** 强制重算一轮最多等多久（811 个公式，其中 600 个 1 万行的 SUMPRODUCT：本机 2–5 秒，CI 慢几倍） */
const FORCED_ROUND_TIMEOUT_MS = 60_000

/** 强制全量重算（与 SDK 的 FORCED 打开、M0 V07 的基准是同一条 mutation，带 onlyLocal：不算修改，只读时也不被防火墙取消） */
async function forceRecalculation(probe: EditorProbe): Promise<void> {
  await probe.univerAPI.executeCommand(FORMULA_PROTOCOL.forceTriggerMutationId, { forceCalculation: true }, { onlyLocal: true })
}

/** 命令日志里 mark 之后第一条开始一轮的 mutation */
function roundStart(probe: EditorProbe, mark: number): ProbeCommand | undefined {
  return probe.commands(mark).find(command => command.phase === 'executed' && command.id === FORMULA_PROTOCOL.startMutationId)
}

/** 这一轮第一条进度通知（一轮的第一条是 START）：mark 之后、开始的 mutation 之后的第一条通知 */
function roundNotified(probe: EditorProbe, mark: number): ProbeCommand | undefined {
  const start = roundStart(probe, mark)
  return start === undefined ? undefined : probe.commands(start.seq).find(command => command.phase === 'executed' && command.id === FORMULA_PROTOCOL.notificationMutationId)
}

async function rebuildDuringCalculation(session: Session): Promise<void> {
  await check(session, 'formula.rebuild-during-calc', async () => {
    // 1. 退出编辑：先保存（等公式收齐之后才重建，这一次不在计算中），以只读重建
    const editingBefore = session.probe
    const exit = chromeButton(session, '退出编辑')
    if (exit === undefined)
      fail(`页头没有"退出编辑"（${describeView(session)}）`)
    exit.click()
    await untilSwitched(session, 'reading', 'exiting')
    adoptEditor(session, editingBefore)
    const reading = session.probe
    // 2. 阅读时强制重算；这一轮开始 1.2 秒之后、还没算完时点"编辑"（进入编辑一律重建：旧的编辑器在计算中销毁）
    const mark = lastSeq(reading)
    const roundBefore = reading.formulaProgress().round
    await forceRecalculation(reading)
    if (!await waitFor(() => roundNotified(reading, mark) !== undefined, SIGNAL_TIMEOUT_MS, 5))
      fail(`阅读时强制重算没有开始（没有等到这一轮的进度通知）；轮数 ${roundBefore} → ${reading.formulaProgress().round}`)
    const startAt = roundNotified(reading, mark)?.at ?? 0
    const running = (): boolean => !reading.formulaProgress().completed
    if (!await waitFor(() => !running() || performance.now() - startAt >= REBUILD_AFTER_START_MS, FORCED_ROUND_TIMEOUT_MS, 10) || !running())
      fail(`阅读时的这一轮在 ${round(performance.now() - startAt)} ms 时已经算完，没能在计算中重建：样本要加大`)
    const enter = chromeButton(session, '编辑')
    if (enter === undefined)
      fail(`页头没有"编辑"（${describeView(session)}）`)
    const clickedAt = performance.now()
    enter.click()
    await untilSwitched(session, 'editing', 'entering')
    adoptEditor(session, reading)
    const steadyAt = performance.now()
    // 旧的编辑器销毁之前这一轮没有算完：它的命令日志里这一轮开始之后没有结果（销毁时探针随之退订，日志留着）
    const oldResults = reading.commands(mark).filter(command => command.phase === 'executed' && command.id === FORMULA_PROTOCOL.resultMutationId)
    if (oldResults.length > 0)
      fail(`阅读的编辑器销毁之前这一轮已经有了结果（+${round((oldResults[0]?.at ?? startAt) - startAt)} ms）：没有在计算中重建`)
    // 3. 新的编辑器：等打开时的计算（易变函数）收齐，再强制重算一遍，全部公式按定义核对
    const editing = session.probe
    if (!await waitFor(() => editing.formulasSettled(), FORCED_ROUND_TIMEOUT_MS, 50))
      fail('进入编辑之后公式一直没有收齐')
    const editingMark = lastSeq(editing)
    await forceRecalculation(editing)
    const recalculated = (): boolean => roundStart(editing, editingMark) !== undefined && editing.formulasSettled()
    if (!await waitFor(recalculated, FORCED_ROUND_TIMEOUT_MS, 50))
      fail(`${FORCED_ROUND_TIMEOUT_MS / 1000} 秒内新的编辑器里的强制重算没有收齐`)
    const doneAt = performance.now()
    const verdict = verifyFormulaSnapshot(editing.snapshot())
    session.timings.push({
      id: 'formula.rebuild-during-calc',
      ms: { clickAfterStart: round(clickedAt - startAt), enterSteady: round(steadyAt - clickedAt), recalculation: round(doneAt - steadyAt) },
    })
    if (verdict.staleCount > 0) {
      const errors = Object.entries(verdict.errors).map(([value, count]) => `${value} ×${count}`).join('、')
      fail(`在计算中重建之后，新的编辑器里强制重算，${verdict.staleCount}/${verdict.checked} 个与定义不同${errors === '' ? '' : `（其中 ${errors}）`}：${verdict.stale.join('、')}（${JSON.stringify(verdict.byKind)}）`)
    }
    return `退出编辑（先保存）；阅读时强制重算，这一轮开始之后 +${round(clickedAt - startAt)} ms 点"编辑"、还没算完（旧的编辑器的日志里没有结果）；进入编辑 ${round(steadyAt - clickedAt)} ms 到 steady；新的编辑器里强制重算 ${round(doneAt - steadyAt)} ms，${verdict.checked} 个公式与按定义算出的一致`
  }, SWITCH_TIMEOUT_MS * 2 + FORCED_ROUND_TIMEOUT_MS * 2 + CHECK_TIMEOUT_MS)
}
