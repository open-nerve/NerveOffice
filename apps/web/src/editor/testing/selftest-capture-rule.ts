// 捕获时机的页面自检的共用部分（M3-P4 S1，./selftest-capture.ts 与 ./selftest-formulas.ts 用）：Facade 里另外用到的方法的声明、
// 编辑时才跑的前提、组合输入的跟踪（设计 §3.6 的写法）与按规则捕获的循环（捕获的规则是参考实现 ./capture-reference.ts，设计 §3.2）
import type { CaptureLimits, CaptureReason } from './capture-reference.ts'
import type { ProbeCommand } from './e2e-probe.ts'
import type { SelftestRange, SelftestSheet, SelftestWorkbook, Session } from './selftest-session.ts'
import { CAPTURE_LIMITS, CaptureStateError, decideCapture } from './capture-reference.ts'
import { documentChangesIn } from './content-compare.ts'
import { check, chromeButton, fail, lastSeq } from './selftest-session.ts'

// ---- Facade：捕获时机的场景另外用到的（sheets、sheets-ui 与探针补上的插件 Facade 都有） ----

export interface CaptureRange extends SelftestRange {
  /** 设为选区（只改视图） */
  readonly activate: () => unknown
  readonly setFontSize: (size: number) => unknown
  readonly setWrap: (enabled: boolean) => unknown
  readonly breakApart: () => unknown
}

export interface CaptureImage {
  readonly setPositionAsync: (row: number, column: number) => Promise<boolean>
  readonly setSizeAsync: (width: number, height: number) => Promise<boolean>
  readonly remove: () => boolean
}

export interface CaptureSheet extends SelftestSheet {
  readonly getRange: (a1: string) => CaptureRange
  readonly insertColumnAfter: (column: number) => unknown
  readonly deleteColumns: (column: number, count: number) => unknown
  readonly setColumnWidth: (column: number, width: number) => unknown
  readonly setFrozenRows: (rows: number) => unknown
  /** sheets-ui 的 Facade */
  readonly zoom: (ratio: number) => unknown
  readonly scrollToCell: (row: number, column: number) => unknown
  readonly getImages: () => readonly CaptureImage[]
}

export interface CaptureWorkbook extends SelftestWorkbook {
  readonly getActiveSheet: () => CaptureSheet
  readonly getSheetByName: (name: string) => CaptureSheet
  readonly setActiveSheet: (sheet: CaptureSheet) => unknown
  readonly insertDefinedName: (name: string, reference: string) => unknown
}

export interface CaptureTextFinder {
  readonly findAll: () => readonly unknown[]
  readonly replaceAllWithAsync: (text: string) => Promise<number>
}

export interface CaptureApi {
  readonly getActiveWorkbook: () => CaptureWorkbook
  readonly executeCommand: (id: string, params?: object, options?: object) => Promise<boolean>
  readonly newDataValidation: () => { readonly requireNumberBetween: (from: number, to: number) => { readonly build: () => unknown } }
  readonly createTextFinderAsync: (text: string) => Promise<CaptureTextFinder>
  readonly undo: () => Promise<boolean>
  readonly redo: () => Promise<boolean>
}

export function facade(session: Session): CaptureApi {
  return session.probe.univerAPI as unknown as CaptureApi
}

export function sheetNamed(session: Session, name: string): CaptureSheet {
  const sheet = facade(session).getActiveWorkbook().getSheetByName(name) as CaptureSheet | null
  if (sheet === null)
    fail(`没有工作表"${name}"`)
  return sheet
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function round(ms: number): number {
  return Math.round(ms)
}

// ---- 编辑时才跑 ----

/** 这些场景都要在编辑时跑：挂接没能进入编辑（被占用、不能编辑）时，余下的检查没有意义 */
export async function checkEditing(session: Session): Promise<boolean> {
  return check(session, 'page.editing', async () => {
    if (session.host.page.readOnly !== false)
      fail('页面没有进入编辑（挂接进入编辑没有成功：被别人占用、没有编辑的权限？）')
    if (chromeButton(session, '保存') === undefined)
      fail('进入了编辑，页头没有保存按钮')
    return `编辑中，公式在${session.probe.formulaMode === 'worker' ? ' Worker 里' : '主线程'}计算`
  })
}

// ---- 组合输入（设计 §3.6 的写法：document 上捕获阶段的 compositionstart、compositionend；组字的元素失焦、页面隐藏时复位；页头里的不算） ----

export interface CompositionWatch {
  readonly composing: () => boolean
  readonly lastEndAt: () => number | undefined
  readonly dispose: () => void
}

export function watchComposition(chrome: HTMLElement): CompositionWatch {
  let composing = false
  let lastEndAt: number | undefined
  let target: EventTarget | null = null
  const inChrome = (event: Event): boolean => event.target instanceof Node && chrome.contains(event.target)
  const end = (): void => {
    composing = false
    target = null
    lastEndAt = performance.now()
  }
  const onStart = (event: Event): void => {
    if (inChrome(event))
      return
    composing = true
    target = event.target
  }
  const onEnd = (event: Event): void => {
    if (!inChrome(event))
      end()
  }
  const onFocusOut = (event: Event): void => {
    if (composing && event.target === target)
      end()
  }
  const onVisibility = (): void => {
    if (composing && document.visibilityState === 'hidden')
      end()
  }
  document.addEventListener('compositionstart', onStart, true)
  document.addEventListener('compositionend', onEnd, true)
  document.addEventListener('focusout', onFocusOut, true)
  document.addEventListener('visibilitychange', onVisibility)
  return {
    composing: () => composing,
    lastEndAt: () => lastEndAt,
    dispose() {
      document.removeEventListener('compositionstart', onStart, true)
      document.removeEventListener('compositionend', onEnd, true)
      document.removeEventListener('focusout', onFocusOut, true)
      document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}

// ---- 按规则捕获（参考实现）：每 10 毫秒看一次（修改、公式进度、组合结束都在看的时候读到），到点就同步捕获 ----

/** 一次捕获：JSON.stringify(save())，序号与命令日志的位置在同一个同步段里读 */
export interface Capture {
  readonly at: number
  readonly reason: CaptureReason
  readonly formulasPending: boolean
  readonly seq: number
  readonly snapshot: string
}

export interface CaptureRun {
  readonly captures: Capture[]
  /** 看到公式由没收齐变成收齐的最后一个时刻 */
  settledAt?: number
  /** 看到最近一轮完成的时刻（公式进度的 completed） */
  completedAt?: number
}

export interface CaptureLoopOptions {
  /** 从命令日志的哪个序号之后算修改：之前的都已经捕获过（那时的本地修改序号是 baseSeq） */
  readonly mark: number
  readonly baseSeq: number
  readonly limits?: CaptureLimits
  readonly composition?: CompositionWatch
  /** 全部捕获过之后（没有要补的）再看多久：迟到的修改再捕获 */
  readonly monitorMs?: number
  /** 为真时即使全部捕获过也不结束（组合输入的场景：组字结束之前） */
  readonly keepAlive?: () => boolean
  readonly timeoutMs: number
}

export const TICK_MS = 10

/**
 * 命令日志按变更检测的口径另做的判定（content-compare.ts，与编辑器的判定是同一份规则，单元测试核对）：mark 之后本文档的修改，
 * 按发生的顺序。change-detection 拿它与编辑器的本地修改序号对照（两边不一致就是判定出了岔子）
 */
export function changesAfter(session: Session, mark: number): ProbeCommand[] {
  return documentChangesIn(session.probe.commands(mark), session.unitId)
}

/**
 * 编辑器自己认作修改的命令：mark 之后执行完、记下时本地修改序号比前一条大的那些（探针的 changeSeq）。捕获的时机按它算——
 * 与自动保存订阅编辑器的修改信号同一个口径，变更检测漏掉的修改在这里也看不到（迟到而没被检测的变化由捕获之后的比较认出）
 */
export function detectedChangesAfter(session: Session, mark: number, seqAtMark: number): ProbeCommand[] {
  let previous = seqAtMark
  const detected: ProbeCommand[] = []
  for (const command of session.probe.commands(mark)) {
    if (command.phase === 'executed' && command.changeSeq > previous)
      detected.push(command)
    previous = Math.max(previous, command.changeSeq)
  }
  return detected
}

export async function captureByRule(session: Session, options: CaptureLoopOptions): Promise<CaptureRun> {
  const { probe } = session
  const limits = options.limits ?? CAPTURE_LIMITS
  const run: CaptureRun = { captures: [] }
  let capturedSeq = options.baseSeq
  let logMark = options.mark
  let flagged = false
  let unsettledSeen = false
  let idleSince: number | undefined
  const started = performance.now()
  for (;;) {
    const now = performance.now()
    const seq = probe.changeSeq()
    const uncaptured = detectedChangesAfter(session, logMark, capturedSeq)
    const settled = probe.formulasSettled()
    if (!settled) {
      unsettledSeen = true
    }
    else if (unsettledSeen) {
      unsettledSeen = false
      run.settledAt = now
    }
    const progress = probe.formulaProgress()
    if (progress.completed && run.completedAt === undefined)
      run.completedAt = now
    else if (!progress.completed)
      run.completedAt = undefined
    let decision
    try {
      decision = decideCapture({
        now,
        seq,
        capturedSeq,
        firstUncapturedAt: uncaptured[0]?.at,
        lastChangeAt: uncaptured.at(-1)?.at,
        composing: options.composition?.composing() ?? false,
        lastCompositionEndAt: options.composition?.lastEndAt(),
        settled,
        lastCaptureFlagged: flagged,
      }, limits)
    }
    catch (error) {
      if (error instanceof CaptureStateError)
        fail(`变更检测与命令日志不一致：本地修改序号 ${seq}（捕获时 ${capturedSeq}），命令日志里没捕获的修改 ${uncaptured.length} 条`)
      throw error
    }
    if (decision.kind === 'capture') {
      const at = performance.now()
      const snapshot = probe.snapshot()
      const capturedNow = probe.changeSeq()
      logMark = lastSeq(probe)
      run.captures.push({ at, reason: decision.reason, formulasPending: decision.formulasPending, seq: capturedNow, snapshot })
      capturedSeq = capturedNow
      flagged = decision.formulasPending
      idleSince = undefined
      continue
    }
    if (decision.kind === 'idle' && options.keepAlive?.() !== true) {
      idleSince ??= now
      if (now - idleSince >= (options.monitorMs ?? 0))
        return run
    }
    else {
      idleSince = undefined
    }
    if (now - started > options.timeoutMs) {
      const state = decision.kind === 'wait' ? `等${decision.blockedBy.map(item => ({ quiet: '静默', formulas: '公式收齐', composition: '组合结束' })[item]).join('、')}` : decision.kind
      fail(`${options.timeoutMs / 1000} 秒内没有按规则捕获完（${state}；本地修改序号 ${seq}、已捕获到 ${capturedSeq}，公式${settled ? '已' : '没有'}收齐，捕获了 ${run.captures.length} 次）`)
    }
    await sleep(TICK_MS)
  }
}

/** 捕获的原因的说法 */
export const CAPTURE_REASON_TEXT: Readonly<Record<CaptureReason, string>> = { quiet: '静默', cap: '上限', recapture: '补捕获' }

export function lastCapture(run: CaptureRun): Capture {
  const capture = run.captures.at(-1)
  if (capture === undefined)
    fail('一次也没有捕获（没有检测到修改？）')
  return capture
}
