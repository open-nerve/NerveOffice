// 公式时序的页面自检（M3-P4 S1 的 formula-timing，设计 §3.15）：公式样本（./capture-samples.ts，公式不带缓存值、打开时算），
// × Worker/主线程（地址参数选，./formula-mode.ts）。打开时算全部公式；五类（依赖链、聚合、跨表、SUMPRODUCT、易变函数）各改输入、
// "静默窗口内再改一次"、"计算进行中再改一次"（M0 的情形 A、C：同一范围走 stop、别的范围排队）、"超过上限"（捕获的上限调到 50 毫秒：
// 带标记捕获、收齐之后补捕获）。S7 起看真实的自动保存（./selftest-autosave.ts，照常运行）：每项等自动保存把这一项的修改上传、服务端确认，
// 读回服务器上的内容——这一项写的输入都在、全部公式与按定义算出的一致（同一个核对先拿上传之前的那一份校准）；调度的每次捕获经同步的订阅
// 另取内容，不带"公式待更新"的都对；捕获的时刻不早于规则的下限；每项交回时间线（各轮的开始、stop、结果、写回、收齐、捕获、上传）。
// 最后一项"计算进行中重建"（主会话 2026-10-05 追加。S1 核实成立：主线程模式下 Univer 实例销毁时正在算的那一轮会继续跑完，把只会得出
// #NAME? 的语法树写进 engine-formula 模块级的缓存 FORMULA_AST_CACHE，之后同一页里新建的实例打开同一份文档会命中它们；S5 规避：
// 主线程模式下销毁之前先停下这一轮、等它结束，formula-round-stop.ts）：退出编辑，进入准备完成后强制重算，收到本轮实际进度后放行登记并重建，
// 新的编辑器里再强制重算一遍，全部公式按定义核对——两种模式都要求全部正确。Worker 模式是对照（缓存在 Worker 里，重建时 Worker 随旧的编辑器终止）
import type { AutosaveControlLimits } from './autosave-control.ts'
import type { EditorProbe, ProbeCommand } from './e2e-probe.ts'
import type { CaptureEntry, UploadEntry } from './selftest-autosave.ts'
import type { Session } from './selftest-session.ts'
import { FORMULA_PROTOCOL } from '../internal-api/index.ts'
import { FORMULA_SAMPLE, randOf, verifyFormulaSnapshot } from './capture-samples.ts'
import { installRebuildCalculationGate } from './rebuild-calculation-gate.ts'
import { autosaveControl, autosaveTimeline, capturesIn, captureTimingProblems, detectedChanges, triggerText, untilUploaded, uploadFlagged, uploadsIn, watchCaptures } from './selftest-autosave.ts'
import { checkEditing, round, sheetNamed, sleep } from './selftest-capture-common.ts'
import { waitFor } from './selftest-dom.ts'
import { FORMULA_MODE_PARAM, formulaModeOfValue } from './selftest-report.ts'
import { adoptEditor, check, CHECK_TIMEOUT_MS, chromeButton, describeView, fail, fetchServerContent, fetchServerDocument, lastSeq, SIGNAL_TIMEOUT_MS, SWITCH_TIMEOUT_MS, untilSwitched } from './selftest-session.ts'

// ---- formula-timing ----

/** 改一格：工作表名、A1 写法、值 */
type Edit = readonly [sheet: string, cell: string, value: number | string]

interface FormulaCaseContext {
  /** 改一格；返回改之前公式的轮数（之后开始的一轮是这次修改引起的） */
  readonly set: (edit: Edit) => number
  /** 等到 roundBefore 之后开始的一轮正在算（开始了、还没完成）；返回那时的进度说明 */
  readonly untilCalculating: (roundBefore: number) => Promise<string>
  /** 立即另取内存快照（不等），按定义核对：过期的有几个 */
  readonly captureNow: () => number
  /** 等到第一次修改之后 ms 毫秒的那一刻（已经过了就不等） */
  readonly at: (ms: number) => Promise<void>
  /** 强制全量重算一轮（onlyLocal：不算修改，不挪动静默的起点），等它开始 */
  readonly forceRound: () => Promise<void>
  /** 公式收齐了没有（与自动保存读的是同一个跟踪器） */
  readonly settled: () => boolean
  /** 捕获的静默（此刻生效的节奏） */
  readonly quietMs: number
}

/** 改输入之后交回的：不等就捕获时过期的个数（检查本身灵敏的校准）、给说明的补充 */
interface EditOutcome {
  readonly immediateStale?: number
  readonly note?: string
}

interface FormulaCase {
  readonly id: string
  readonly title: string
  /** 换自动保存的节奏（其余是生产的默认值） */
  readonly limits?: Partial<AutosaveControlLimits>
  readonly edit: (context: FormulaCaseContext) => Promise<EditOutcome>
}

const { chain: CHAIN, aggregate: AGGREGATE, volatile: VOLATILE } = FORMULA_SAMPLE

/** "静默窗口内再改一次"的两次修改之间隔多久（M0-P3 V07 的做法） */
const QUIET_WINDOW_GAP_MS = 300

/**
 * "超过上限"：捕获的上限调到 50 毫秒（M0 的做法，设计 §3.14 的 setLimits），上传的静默也调到 50 毫秒——带"公式待更新"的那一份随即上传
 * （否则按生产的 2 秒静默，补捕获早已取代了它），服务器上先记下标记、补存之后清掉
 */
const CAP_LIMITS: Partial<AutosaveControlLimits> = { captureMaxMs: 50, uploadQuietMs: 50 }

/**
 * "静默到点时还在算"：静默到点之前多久强制重算一轮。811 个公式（其中 600 个 1 万行的 SUMPRODUCT）的一轮在各浏览器里都长过 1 秒
 * （S1：Safari 约 1.5 秒起、Chromium 系 3–4 秒），到点时一定还没算完
 */
const FORCE_BEFORE_QUIET_MS = 200

/**
 * 改了牵动重计算的输入、立即另取内存快照（不等）：计算在 10 ms 的防抖之后才开始，快照里一定有过期的值——"等公式"确实被检验到了
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
    // M3-P4 S6 的"静默到点时公式还没收齐"（变异"捕获不等公式收齐"原来认不出：别的项里那一轮在静默的那 1 秒里早已算完，真实 Safari 尤其快）
    id: 'quiet-while-calculating',
    title: `静默到点时还在算：改聚合!B1，静默到点之前 ${FORCE_BEFORE_QUIET_MS} 毫秒强制重算一轮（811 个公式）：到点不捕获，算完才捕获`,
    edit: async ({ set, at, forceRound, settled, quietMs }) => {
      set([AGGREGATE.name, 'B1', 600])
      await at(quietMs - FORCE_BEFORE_QUIET_MS)
      await forceRound()
      await at(quietMs + 50)
      if (settled())
        fail(`静默到点（+${quietMs} ms）时强制重算的一轮已经算完：这一项没有检验到"等公式"，样本要加大`)
      return { note: `静默到点（+${quietMs} ms）时强制重算的一轮还在算` }
    },
  },
  {
    id: 'cap',
    title: `超过上限（捕获的上限与上传的静默调到 ${CAP_LIMITS.captureMaxMs} 毫秒）：改聚合!B1，带"公式待更新"捕获并上传，收齐之后补捕获、补存`,
    limits: CAP_LIMITS,
    edit: async ({ set }) => {
      set([AGGREGATE.name, 'B1', 400])
      return {}
    },
  },
]

/** 公式样本里的工作表：名称 → id */
const SHEET_IDS: Readonly<Record<string, string>> = Object.fromEntries(Object.values(FORMULA_SAMPLE).map(sheet => [sheet.name, sheet.id]))

/** A1 写法 → 从 0 开始的行与列（只用到单个字母的列） */
function cellPosition(a1: string): { readonly row: number, readonly column: number } {
  const match = /^([A-Z])(\d+)$/.exec(a1)
  if (match === null)
    throw new Error(`不认识的单元格写法 ${a1}`)
  return { row: Number(match[2]) - 1, column: (match[1] ?? 'A').charCodeAt(0) - 65 }
}

/** 快照里一格的值 */
function cellValueOf(snapshotText: string, sheetId: string, row: number, column: number): unknown {
  const workbook = JSON.parse(snapshotText) as { readonly sheets: Readonly<Record<string, { readonly cellData?: Readonly<Record<string, Readonly<Record<string, { readonly v?: unknown }>>>> }>> }
  return workbook.sheets[sheetId]?.cellData?.[row]?.[column]?.v
}

/**
 * 服务器上的内容对不对：这一项写的输入都在（同一格取最后一次写的值），全部公式与按定义算出的一致。交回问题（空数组就是对的）。
 * 每项先拿上传之前服务器上的那一份调用它校准——那里还没有这一项的修改，必须看出问题：读的确实是服务器上的那一份、核对不是恒等的
 */
function storedFormulaProblems(snapshotText: string, edits: readonly Edit[]): string[] {
  const problems: string[] = []
  const latest = new Map<string, Edit>()
  for (const edit of edits)
    latest.set(`${edit[0]}!${edit[1]}`, edit)
  for (const [sheet, cell, value] of latest.values()) {
    const { row, column } = cellPosition(cell)
    const actual = cellValueOf(snapshotText, SHEET_IDS[sheet] ?? sheet, row, column)
    if (actual !== value)
      problems.push(`${sheet}!${cell} 是 ${JSON.stringify(actual) ?? '空'}（应当是这一项写的 ${JSON.stringify(value)}）`)
  }
  const verdict = verifyFormulaSnapshot(snapshotText)
  if (verdict.staleCount > 0)
    problems.push(`${verdict.staleCount}/${verdict.checked} 个公式与按定义算出的不同：${verdict.stale.join('、')}（${JSON.stringify(verdict.byKind)}）`)
  return problems
}

/** 这一次上传的是哪一次捕获：开始上传之前、序号相同的最后一次 */
function captureOf(upload: UploadEntry, captures: readonly CaptureEntry[]): CaptureEntry | undefined {
  return captures.filter(capture => capture.seq === upload.seq && capture.at <= upload.startedAt).at(-1)
}

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

/**
 * 一项最多等多久自动保存把它上传：静默 2 秒之后上传；"静默到点时还在算"要等强制重算的一轮算完（本机 Chromium 系约 4 秒），CI 慢几倍
 */
const UPLOAD_TIMEOUT_MS = 40_000

/** 一项的总时限 */
const CASE_TIMEOUT_MS = 60_000

export async function formulaTimingScenario(session: Session): Promise<void> {
  if (!await checkEditing(session, { mode: 'running' }))
    return
  const { probe } = session
  const control = autosaveControl()
  const documentId = session.host.documentId
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
    // 样本的公式不带缓存值：打开时 SDK 算全部公式（进入编辑时重建，编辑的编辑器又算一遍）；写回带 onlyLocal，不算修改，自动保存不捕获
    const verdict = (): ReturnType<typeof verifyFormulaSnapshot> => verifyFormulaSnapshot(probe.snapshot())
    if (!await waitFor(() => probe.formulasSettled() && verdict().staleCount === 0, FORMULA_OPEN_TIMEOUT_MS, 100)) {
      const last = verdict()
      fail(`${FORMULA_OPEN_TIMEOUT_MS / 1000} 秒内公式没有全部算对（公式${probe.formulasSettled() ? '已' : '没有'}收齐，${last.staleCount}/${last.checked} 个与定义不同：${last.stale.join('、')}）`)
    }
    if (probe.changeSeq() !== 0)
      fail(`打开时算公式被当成了修改：本地修改序号 ${probe.changeSeq()}`)
    if (control.log().length > 0)
      fail(`打开时算公式，自动保存却有了记录：${autosaveTimeline(control.log(), 0)}`)
    return `打开时算出全部 ${verdict().checked} 个公式，与按定义算出的一致；写回不算修改（本地修改序号 0），自动保存没有捕获与上传`
  }, FORMULA_OPEN_TIMEOUT_MS + CHECK_TIMEOUT_MS)
  if (!opened)
    return

  for (const formulaCase of FORMULA_CASES) {
    await check(session, `formula.${formulaCase.id}`, async () => {
      control.resetLimits()
      if (formulaCase.limits !== undefined)
        control.setLimits(formulaCase.limits)
      control.clearLog()
      // 校准用：这一项改之前服务器上的那一份（上一项上传、确认的）
      const before = await fetchServerContent(documentId)
      const watch = watchCaptures(session)
      try {
        const mark = lastSeq(probe)
        const baseSeq = probe.changeSeq()
        const edits: Edit[] = []
        let origin: number | undefined
        const context: FormulaCaseContext = {
          set: (edit) => {
            const [sheet, cell, value] = edit
            const roundBefore = probe.formulaProgress().round
            origin ??= performance.now()
            edits.push(edit)
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
          at: async (ms) => {
            const wait = (origin ?? performance.now()) + ms - performance.now()
            if (wait > 0)
              await sleep(wait)
          },
          forceRound: async () => {
            const forceMark = lastSeq(probe)
            await forceRecalculation(probe)
            if (!await waitFor(() => roundStart(probe, forceMark) !== undefined, SIGNAL_TIMEOUT_MS, 1))
              fail('强制重算的一轮没有开始')
          },
          settled: () => probe.formulasSettled(),
          quietMs: control.limits().captureQuietMs,
        }
        const outcome = await formulaCase.edit(context)
        const { upload, request, settledAt } = await untilUploaded(session, probe.changeSeq(), { timeoutMs: UPLOAD_TIMEOUT_MS })
        const stored = await fetchServerContent(documentId)
        const start = origin ?? 0
        const log = control.log()
        const captures = capturesIn(log)
        const watched = watch.captures()
        const uploaded = captureOf(upload, captures)
        const flagged = watched.find(capture => capture.entry.formulasPending)
        const executed = probe.commands(mark).filter(command => command.phase === 'executed')
        const rounds = executed.filter(command => command.id === FORMULA_PROTOCOL.startMutationId).length
        const stops = executed.filter(command => command.id === FORMULA_PROTOCOL.stopMutationId).length
        session.timings.push({
          id: `formula.${formulaCase.id}`,
          ms: {
            ...formulaTimeline(session, mark, start),
            settled: settledAt === undefined ? null : round(settledAt - start),
            flaggedCapture: flagged === undefined ? null : round(flagged.entry.at - start),
            capture: uploaded === undefined ? null : round(uploaded.at - start),
            uploadStart: round(upload.startedAt - start),
            uploaded: round(upload.at - start),
          },
        })
        const calibration = storedFormulaProblems(before, edits)
        if (calibration.length === 0)
          fail('服务器上的核对没有检验到什么：这一项改之前服务器上的那一份也算对（读的不是服务器上的那一份，或者核对是恒等的）')
        const problems = storedFormulaProblems(stored, edits)
        if (problems.length > 0)
          fail(`自动保存（${triggerText(upload.trigger)}）上传、存上之后，服务器上：${problems.join('；')}；${autosaveTimeline(log, start)}`)
        if (watch.mismatches().length > 0)
          fail(`另取的内容与调度捕获的对不上：${watch.mismatches().join('；')}`)
        // 不带"公式待更新"的捕获：捕获的那一刻公式收齐了（调度与订阅读的是同一个跟踪器、同一个同步段），内容里的公式都对
        const unsettled = watched.filter(capture => !capture.entry.formulasPending && !capture.settled)
        if (unsettled.length > 0)
          fail(`公式没收齐时捕获却不带"公式待更新"：${unsettled.map(capture => `${triggerText(capture.entry.trigger)} +${round(capture.entry.at - start)} ms`).join('、')}；${autosaveTimeline(log, start)}`)
        const staleCaptures = watched.filter(capture => !capture.entry.formulasPending).map(capture => ({ capture, verdict: verifyFormulaSnapshot(capture.snapshot) })).filter(({ verdict }) => verdict.staleCount > 0)
        if (staleCaptures.length > 0)
          fail(`不带"公式待更新"的捕获里有过期的值：${staleCaptures.map(({ capture, verdict }) => `${triggerText(capture.entry.trigger)} +${round(capture.entry.at - start)} ms ${verdict.staleCount} 个`).join('、')}`)
        const timing = captureTimingProblems(captures, detectedChanges(session, mark, baseSeq), control.limits(), baseSeq)
        if (timing.length > 0)
          fail(`捕获早于规则：${timing.join('；')}；${autosaveTimeline(log, start)}`)
        if (outcome.immediateStale === 0)
          fail('不等就捕获也是对的：这一项没有检验到"等公式"（计算在修改的同一时刻就完成了？）')
        let flaggedText: string | undefined
        if (formulaCase.limits === CAP_LIMITS) {
          if (flagged === undefined)
            fail(`上限（${CAP_LIMITS.captureMaxMs} 毫秒）到的时候公式已经收齐，没有走到"带标记捕获、收齐之后补捕获"：样本要加大；${autosaveTimeline(log, start)}`)
          const flaggedUpload = uploadsIn(log).find(item => item.seq === flagged.entry.seq && uploadFlagged(item))
          if (flaggedUpload === undefined || flaggedUpload.outcome.kind !== 'saved')
            fail(`带"公式待更新"的那一份没有上传、存上：${autosaveTimeline(log, start)}`)
          if (uploaded?.trigger !== 'formulas')
            fail(`上传的最后一份不是收齐之后的补捕获（${uploaded === undefined ? '没有' : triggerText(uploaded.trigger)}）：${autosaveTimeline(log, start)}`)
          if ((await fetchServerDocument(documentId)).formulasPending)
            fail('补存之后服务器上仍是"公式待更新"')
          flaggedText = `上限到时 +${round(flagged.entry.at - start)} ms 带"公式待更新"捕获（那时 ${verifyFormulaSnapshot(flagged.snapshot).staleCount} 个过期）、+${round(flaggedUpload.at - start)} ms 带标记存上；收齐之后补捕获、补存，服务器上的标记清掉`
        }
        else if (request?.formulasPending !== 'false') {
          fail(`上传的请求的"公式待更新"是 ${String(request?.formulasPending)}`)
        }
        const parts = [
          `自动保存 +${uploaded === undefined ? '?' : round(uploaded.at - start)} ms 捕获（${uploaded === undefined ? '?' : triggerText(uploaded.trigger)}，共 ${captures.length} 次）、+${round(upload.startedAt - start)}–${round(upload.at - start)} ms 上传（${triggerText(upload.trigger)}）、存上`,
          flaggedText,
          `服务器上的 ${verifyFormulaSnapshot(stored).checked} 个公式与按定义算出的一致（上传之前的那一份按同一个核对不对：${calibration[0] ?? ''}）`,
          `${rounds} 轮${stops > 0 ? `、${stops} 次 stop` : ''}`,
          outcome.immediateStale === undefined ? undefined : `不等就捕获时 ${outcome.immediateStale} 个过期`,
          outcome.note,
        ]
        return `${formulaCase.title}：${parts.filter(part => part !== undefined).join('；')}`
      }
      finally {
        watch.dispose()
        control.resetLimits()
      }
    }, CASE_TIMEOUT_MS)
  }

  await check(session, 'formula.volatile-recalculated', async () => {
    // 修改无关的单元格之后 RAND 重算了（M0：两种模式、三个浏览器都重算）：只记下，不影响捕获的正确性
    control.clearLog()
    const before = randOf(probe.snapshot())
    const edit: Edit = [VOLATILE.name, 'C2', '再改一处无关的']
    sheetNamed(session, edit[0]).getRange(edit[1]).setValue(edit[2])
    const { upload } = await untilUploaded(session, probe.changeSeq(), { timeoutMs: UPLOAD_TIMEOUT_MS })
    const stored = await fetchServerContent(documentId)
    const after = randOf(stored)
    const problems = storedFormulaProblems(stored, [edit])
    if (problems.length > 0)
      fail(`服务器上：${problems.join('；')}`)
    return `RAND ${before === after ? '没有重算（值不变）' : '重算了'}（${String(before)} → 服务器上 ${String(after)}），自动保存（${triggerText(upload.trigger)}）存上之后服务器上的易变函数内部一致`
  }, CASE_TIMEOUT_MS)

  await check(session, 'formula.server-flag', async () => {
    // 各项都存上之后：服务器上不是"公式待更新"（超过上限那一项带标记存上过，补存时清掉）
    if ((await fetchServerDocument(documentId)).formulasPending)
      fail('服务器上仍是"公式待更新"')
    return '服务器上的文档不是"公式待更新"'
  })

  await rebuildDuringCalculation(session)
}

// ---- 计算进行中重建 ----

/** 强制重算一轮最多等多久（811 个公式，其中 600 个 1 万行的 SUMPRODUCT：本机 2–5 秒，CI 慢几倍） */
const FORCED_ROUND_TIMEOUT_MS = 60_000

/** 强制全量重算（与 SDK 的 FORCED 打开、M0 V07 的基准是同一条 mutation，带 onlyLocal：不算修改，只读时也不被防火墙取消） */
export async function forceRecalculation(probe: EditorProbe): Promise<void> {
  await probe.univerAPI.executeCommand(FORMULA_PROTOCOL.forceTriggerMutationId, { forceCalculation: true }, { onlyLocal: true })
}

/** 命令日志里 mark 之后第一条开始一轮的 mutation */
export function roundStart(probe: EditorProbe, mark: number): ProbeCommand | undefined {
  return probe.commands(mark).find(command => command.phase === 'executed' && command.id === FORMULA_PROTOCOL.startMutationId)
}

/** 这一轮第一条进度通知（一轮的第一条是 START）：mark 之后、开始的 mutation 之后的第一条通知 */
function roundNotified(probe: EditorProbe, mark: number): ProbeCommand | undefined {
  const start = roundStart(probe, mark)
  return start === undefined ? undefined : probe.commands(start.seq).find(command => command.phase === 'executed' && command.id === FORMULA_PROTOCOL.notificationMutationId)
}

async function rebuildDuringCalculation(session: Session): Promise<void> {
  await check(session, 'formula.rebuild-during-calc', async () => {
    // 1. 退出编辑：先保存（各项都已存上，退出时去重、不再上传；等公式收齐之后才重建，这一次不在计算中），以只读重建
    const editingBefore = session.probe
    const exit = chromeButton(session, '退出编辑')
    if (exit === undefined)
      fail(`页头没有"退出编辑"（${describeView(session)}）`)
    exit.click()
    await untilSwitched(session, 'reading', 'exiting')
    adoptEditor(session, editingBefore)
    const reading = session.probe
    // 2. 进入编辑的真实准备完成后开始重算，收到本轮实际进度才原样放行登记回包。
    // 主线程与 Worker 都不依赖网络/IDB 比计算更快；不再保留 f755729 已修问题的 1.2 秒等待。
    const mark = lastSeq(reading)
    const enter = chromeButton(session, '编辑')
    if (enter === undefined)
      fail(`页头没有"编辑"（${describeView(session)}）`)
    const gate = installRebuildCalculationGate(session.host.documentId, 'enter', reading)
    const clickedAt = performance.now()
    let boundaryAt: number
    let notifiedAt: number
    let releasedAt: number
    try {
      enter.click()
      await untilSwitched(session, 'editing', 'entering')
      const result = gate.result()
      if (result?.kind !== 'released')
        fail(`没有在准备完成时建立计算中重建的交错：${result?.reason ?? '未收到当前文档的写入者登记回包'}`)
      ;({ boundaryAt, notifiedAt, releasedAt } = result)
    }
    finally {
      gate.dispose()
    }
    adoptEditor(session, reading)
    const steadyAt = performance.now()
    const startAt = roundNotified(reading, mark)?.at
    if (startAt === undefined)
      fail('旧编辑器的这一轮没有实际进度通知')
    // 旧的编辑器销毁之前这一轮没有算完：它的命令日志里这一轮开始之后没有结果（销毁时探针随之退订，日志留着）
    const oldResults = reading.commands(mark).filter(command => command.phase === 'executed' && command.id === FORMULA_PROTOCOL.resultMutationId)
    if (oldResults.length > 0)
      fail(`阅读的编辑器销毁之前这一轮已经有了结果（+${round((oldResults[0]?.at ?? startAt) - startAt)} ms）：没有在计算中重建`)
    if (reading.formulaMode === 'main-thread') {
      const stop = reading.commands(mark).find(command => command.phase === 'executed' && command.id === FORMULA_PROTOCOL.stopMutationId)
      if (stop === undefined || !reading.commands(stop.seq).some(command => command.phase === 'executed' && command.id === FORMULA_PROTOCOL.notificationMutationId))
        fail('主线程重建之前没有停止这一轮并收到结束通知')
    }
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
      ms: { prepare: round(boundaryAt - clickedAt), progressAfterPrepare: round(notifiedAt - boundaryAt), releaseAfterProgress: round(releasedAt - notifiedAt), enterSteady: round(steadyAt - clickedAt), recalculation: round(doneAt - steadyAt) },
    })
    if (verdict.staleCount > 0) {
      const errors = Object.entries(verdict.errors).map(([value, count]) => `${value} ×${count}`).join('、')
      fail(`在计算中重建之后，新的编辑器里强制重算，${verdict.staleCount}/${verdict.checked} 个与定义不同${errors === '' ? '' : `（其中 ${errors}）`}：${verdict.stale.join('、')}（${JSON.stringify(verdict.byKind)}）`)
    }
    return `退出编辑（先保存）；点"编辑"后 ${round(boundaryAt - clickedAt)} ms 准备完成，强制重算出现实际进度后放行登记，计算中重建（旧日志没有结果，主线程先停下）；进入编辑 ${round(steadyAt - clickedAt)} ms 到 steady；新的编辑器里强制重算 ${round(doneAt - steadyAt)} ms，${verdict.checked} 个公式与按定义算出的一致`
  }, SWITCH_TIMEOUT_MS * 2 + FORCED_ROUND_TIMEOUT_MS * 2 + CHECK_TIMEOUT_MS)
}
