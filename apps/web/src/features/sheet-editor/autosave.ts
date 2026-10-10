// 自动保存的调度（00 号计划书 §7.2、§7.3，M3-P4 设计 §3.1–§3.8）：两级——捕获进内存里的"最近一次捕获"（一格，只留最新的；M4 换成发件箱），
// 上传取它交给保存的状态机（save-coordinator.ts）。不依赖 Univer 与界面；时钟、编辑器、页面与保存的状态机都可注入，用假的做单元测试
// （autosave.test.ts）。生命周期与保存的状态机相同（编辑模式进入编辑时建、去掉保存的状态机时去掉，设计 §3.10）。
// - 捕获（设计 §3.2）：按 capture-policy.ts 的规则；捕获串行、同步，序号与快照在同一个同步段里读出；记下耗时（大文档拉长间隔）；
//   修改、公式进度、组合输入的信号可能在 SDK 执行命令的过程中同步到达，这里只记时刻、排一次评估，捕获一律在计时器里做；
// - 上传（设计 §3.3）：最近一次捕获还没传过时，修改停下 AUTOSAVE_UPLOAD_QUIET_MS、捕获覆盖了全部修改就上传；持续编辑时从第一处没上传的修改算起
//   最长 AUTOSAVE_UPLOAD_MAX_MS 上传一次；同时至多一个在途（保存的状态机一个接一个，这里在它结束之前不再发起），在途期间照常捕获，回包之后立即再看。
//   只在联网、会话是本人且令牌不是已知失效、没被停住、不在终态时上传；会话回到本人、恢复联网、回到前台时立即再看；
// - 立即上传（设计 §3.4，flush）：保存按钮、退出编辑、交出与空闲释放（P5）在调用（按下）的这一刻就提交这一刻开着的单元格编辑、
//   开始等面板里防抖中的改动写进模型——要提交哪一次编辑在按下时定，之后才开始的输入不提交、不打断（审查 A1）；轮到这一次上传时
//   再等公式（至多捕获的上限，从按下算）、捕获、上传。显式保存排着还没轮到时再按，并进排着的那一次，同一个结果只记一次账（审查 A2）；
//   切到后台（可见性变成 hidden）由这里按页面的信号同步捕获（不提交单元格、不等公式，没收齐就带标记）、立刻发起上传——全程不靠计时器
//   （Safari 约 6 秒之后停计时器）；恢复联网时不等上传的静默；
// - 会话内去重（设计 §3.7）：工作草稿来源计算快照的摘要，由保存的状态机比较；显式保存不去重；
// - 失败（设计 §3.8）：按保存的状态机给的归类——会自动重试的退避（AUTOSAVE_RETRY_INITIAL_MS 起翻倍，至多 AUTOSAVE_RETRY_MAX_MS，
//   服务端给了 Retry-After 时取两者较大的——Retry-After 至多按 AUTOSAVE_RETRY_AFTER_MAX_MS 算，恢复联网、会话回来与切到后台
//   都不早于它）；要等新内容的，同一个捕获不再自动上传，有新的捕获才再试；要等会话的同样退避，会话回到本人时连着的第一次立即重试、
//   之后照退避（页面每次都确认会话，不能每次都跳过）；终态停下。捕获或压缩出了意外：退避之后再试一次，仍错就等新的修改
//   （保存的状态机显示保存失败）；
// - 测试构建的控制（设计 §3.14，S4 实现）：节奏与暂停经 AutosaveTuning 注入（hold 时定时触发的上传不发，立即上传照常；setLimits 换上限），
//   每次捕获与上传经 observe 交出（log）；立即上传的 control 与切到后台同样的规则。
import type { CaptureLimits, CaptureReason } from './capture-policy.ts'
import type { LeaseClock } from './edit-lease.ts'
import type { PreparedCapture, SaveCoordinator, SaveFailure, SaveOutcome, SaveStatus } from './save-coordinator.ts'
import type { CaptureEditor, InputsSettled } from './snapshot-capture.ts'
import type { DraftCaptureRef, WorkingDraft } from './working-draft.ts'
import {
  AUTOSAVE_CAPTURE_MAX_MS,
  AUTOSAVE_CAPTURE_QUIET_MS,
  AUTOSAVE_CAPTURE_SPACING_FACTOR,
  AUTOSAVE_RETRY_AFTER_MAX_MS,
  AUTOSAVE_RETRY_INITIAL_MS,
  AUTOSAVE_RETRY_MAX_MS,
  AUTOSAVE_UPLOAD_MAX_MS,
  AUTOSAVE_UPLOAD_QUIET_MS,
} from '@nerve-office/contracts'
import { decideCapture } from './capture-policy.ts'
import { captureSettled, settleInputs, takeSnapshot } from './snapshot-capture.ts'

/** 自动保存用到的编辑器能力（SheetEditor 的子集；公式进度与组合输入的信号由适配层给出，设计 §3.10） */
export interface AutosaveEditor extends CaptureEditor {
  readonly onChange: (listener: () => void) => () => void
  /** 公式收齐（formula-settle-tracker.ts 的三个条件） */
  readonly formulasSettled: () => boolean
  /** 公式的进度变了（开始一轮、写回、完成、排队、被停）：收齐与否可能变了。可以在命令执行的过程中同步调用 */
  readonly onFormulaProgress: (listener: () => void) => () => void
  /** 正在组合输入（输入法组字中，设计 §3.6） */
  readonly composing: () => boolean
  /** 组合输入开始或结束（组字的元素失焦、页面隐藏时的复位也算结束） */
  readonly onCompositionChange: (listener: () => void) => () => void
}

/** 页面一侧（编辑器页给出，设计 §3.10） */
export interface AutosavePage {
  /** 页面看得见（document.visibilityState 是 visible） */
  readonly visible: () => boolean
  /** 联网（navigator.onLine） */
  readonly online: () => boolean
  /** 会话是本人、令牌不是已知失效（编辑器页 confirmedForWrite 的口径）：不是时不发，免得每 2 秒一个 401/403 */
  readonly sessionWritable: () => boolean
  /** 上面三样变了。可见性的变化要在 visibilitychange 里同步通知：切到后台的捕获与上传不靠计时器 */
  readonly onChange: (listener: () => void) => () => void
}

/** 保存的状态机一侧（save-coordinator.ts） */
export type AutosaveUploader = Pick<SaveCoordinator, 'save' | 'view' | 'subscribe' | 'noteCapture' | 'captureFailed'>

/** 节奏（contracts 的 AUTOSAVE_*；测试构建的控制可以换） */
export interface AutosaveLimits {
  readonly captureQuietMs: number
  readonly captureMaxMs: number
  readonly captureSpacingFactor: number
  readonly uploadQuietMs: number
  readonly uploadMaxMs: number
  readonly retryInitialMs: number
  readonly retryMaxMs: number
}

export const DEFAULT_AUTOSAVE_LIMITS: AutosaveLimits = {
  captureQuietMs: AUTOSAVE_CAPTURE_QUIET_MS,
  captureMaxMs: AUTOSAVE_CAPTURE_MAX_MS,
  captureSpacingFactor: AUTOSAVE_CAPTURE_SPACING_FACTOR,
  uploadQuietMs: AUTOSAVE_UPLOAD_QUIET_MS,
  uploadMaxMs: AUTOSAVE_UPLOAD_MAX_MS,
  retryInitialMs: AUTOSAVE_RETRY_INITIAL_MS,
  retryMaxMs: AUTOSAVE_RETRY_MAX_MS,
}

/**
 * 节奏与暂停的来源（测试构建的控制由此挂上，设计 §3.14）：生产是固定的默认值。held 为真时定时触发的上传（静默、上限、重试、恢复联网）不发，
 * 立即上传（flush、切到后台）照常；捕获照常
 */
export interface AutosaveTuning {
  readonly limits: () => AutosaveLimits
  readonly held: () => boolean
  /** 上面两样变了：调度随即再看 */
  readonly onChange: (listener: () => void) => () => void
}

export const DEFAULT_AUTOSAVE_TUNING: AutosaveTuning = {
  limits: () => DEFAULT_AUTOSAVE_LIMITS,
  held: () => false,
  onChange: () => () => {},
}

/**
 * 立即上传的原因（设计 §3.4）：
 * - save-button：保存按钮与 Cmd/Ctrl+S——按下时提交单元格、等面板，轮到时等公式至多捕获的上限（从按下算），一律上传（不去重）；
 *   在途时排一次，排着还没轮到时再按并进它；
 * - exit：退出编辑——同样先提交单元格、等公式，去重（调用方先 suspend，没全部存上就 resume 留在编辑）；
 * - handover、idle-release：交出编辑权、空闲释放（P5）——同 exit；没收齐就带标记交出（下一个人进入编辑时强制重算）；
 * - control：测试构建的控制——与切到后台同样的规则（不提交单元格、不等公式、去重，会话与联网照样挡）。
 * 提交哪一次单元格编辑一律在调用的这一刻定（审查 A1）：之后才开始的输入不提交、不打断——要连它们一起存上的调用方（交出之后要销毁编辑器）
 * 在调用之前先挡住输入（退出编辑挂着交互屏障）。前四种由调用方确认会话（编辑器页的 readyToWrite：调用之前，或者经 FlushOptions.ready
 * 在按下的准备之后），这里不再按会话、联网与 hold 挡。切到后台、恢复联网由调度按页面的信号自己做
 */
export type FlushReason = 'save-button' | 'exit' | 'handover' | 'idle-release' | 'control'

/** 立即上传的选项 */
export interface FlushOptions {
  /**
   * 能不能上传（编辑器页的会话确认）：按下的这一刻先做准备（提交这一刻开着的单元格编辑、开始等面板，审查 A1），再等它——为假时不上传
   * （单元格的提交留在本页，等同按了回车）。不给时直接上传
   */
  readonly ready?: (() => Promise<boolean>) | undefined
}

/** 按下时提交单元格、等面板，轮到时等公式再捕获的那几种立即上传（control 之外的都是） */
type PreparedReason = Exclude<FlushReason, 'control'>

/** 这几种立即上传去不去重：显式保存一律上传（兜住变更检测看不见的改动），其余的去重 */
const PREPARED_DEDUPE: Readonly<Record<PreparedReason, boolean>> = {
  'save-button': false,
  'exit': true,
  'handover': true,
  'idle-release': true,
}

/** 定时上传的原因：静默、上限、退避到点的重试、恢复联网 */
export type UploadReason = 'quiet' | 'cap' | 'retry' | 'online'

/** 一次捕获的原因（日志）：规则的三种、切到后台、立即上传 */
export type CaptureTrigger = CaptureReason | 'hidden' | 'retry' | FlushReason

/** 一次上传的原因（日志）：定时的四种、切到后台、立即上传 */
export type UploadTrigger = UploadReason | 'hidden' | FlushReason

/** 测试构建的控制记下来的事件（log）：时刻都在调度的时钟上 */
export type AutosaveEvent
  = | { readonly kind: 'capture', readonly trigger: CaptureTrigger, readonly at: number, readonly seq: number, readonly formulasPending: boolean, readonly bytes: number, readonly durationMs: number }
    | { readonly kind: 'capture-failed', readonly trigger: CaptureTrigger, readonly at: number }
  /** 一次上传结束（结果里有 requestId）；seq 是上传的捕获的序号，没取到捕获时为 undefined */
    | { readonly kind: 'upload', readonly trigger: UploadTrigger, readonly startedAt: number, readonly at: number, readonly seq: number | undefined, readonly outcome: SaveOutcome }

/** 全部存上了没有（给退出编辑与 P5） */
export interface SavedState {
  /** 本页的修改都已由服务端确认（确认到现在的修改序号，单元格里没有没提交的输入，没有版本冲突） */
  readonly edits: boolean
  /** 公式结果也已存上（没有"公式待更新"） */
  readonly formulas: boolean
}

/** 立即上传之后：存上了没有，与这一次上传的结果（没有上传——没有要传的、被会话或联网挡住、已停——时为 undefined） */
export interface FlushResult extends SavedState {
  readonly outcome: SaveOutcome | undefined
}

/** 自动保存这一侧的状态：页头连同保存的状态机的视图给出设计 §3.9 的全集（save-indicator.ts） */
export interface AutosaveView {
  /** 没联网：不上传，恢复之后立即上传 */
  readonly offline: boolean
  /** 会话不是本人或令牌已知失效：不上传，回到本人之后立即再看 */
  readonly paused: boolean
  /** 上一次上传（或捕获）失败、之后会自动重试：退避中，或者等联网、会话 */
  readonly retrying: boolean
  /** 测试构建的控制：定时触发的上传暂停 */
  readonly held: boolean
}

export interface AutosaveOptions {
  readonly editor: AutosaveEditor
  readonly page: AutosavePage
  readonly uploader: AutosaveUploader
  readonly clock: LeaseClock
  /** 捕获即交给来源，不等联网或上传；调度只留引用。 */
  readonly draft: WorkingDraft
  /** "公式待更新"的初值（进入编辑时服务端的标记，与保存的状态机的同一个）：带标记时公式收齐就补捕获一次 */
  readonly initialFormulasPending: boolean
  readonly tuning?: AutosaveTuning
  /** 每次捕获与上传（测试构建的控制记下来） */
  readonly observe?: (event: AutosaveEvent) => void
  /** 意外的错误（摘要算不出来）：上报 */
  readonly reportError: (error: unknown) => void
}

export interface Autosave {
  readonly view: () => AutosaveView
  readonly subscribe: (listener: () => void) => () => void
  /** 立即上传（见 FlushReason、FlushOptions）：这一次上传结束之后兑现，交回存上了没有。从不失败 */
  readonly flush: (reason: FlushReason, options?: FlushOptions) => Promise<FlushResult>
  /** 全部存上了没有（此刻） */
  readonly saved: () => SavedState
  /** 挂起定时的捕获与上传、切到后台的上传（开始退出编辑，设计 §3.10）；立即上传照常 */
  readonly suspend: () => void
  /** 恢复（退出编辑没有成功、留在编辑）：立即再看 */
  readonly resume: () => void
  /** 停下并退订（失去编辑权、退出编辑之后）。在途的上传由保存的状态机收尾 */
  readonly dispose: () => void
}

/** 上传的规则（设计 §3.3）用到的状态。时刻都在调度的时钟上 */
export interface UploadState {
  /** 本地修改序号 */
  readonly seq: number
  /** 最近一次捕获（要上传的那一份）的修改序号 */
  readonly capturedSeq: number
  /** 最后一次修改的时刻；没有修改过时为 undefined */
  readonly lastChangeAt: number | undefined
  /** 第一处还没上传的修改的时刻；没有时为 undefined */
  readonly firstUnuploadedAt: number | undefined
  /** 自动重试的时刻（退避）；没有在等重试时为 undefined */
  readonly retryAt: number | undefined
  /** 刚恢复联网：不等静默 */
  readonly immediate: boolean
}

export type UploadDecision
  = | { readonly kind: 'upload', readonly reason: UploadReason }
    | { readonly kind: 'wait', readonly until: number }
    | { readonly kind: 'idle' }

/**
 * 最近一次捕获还没传过时，现在上不上传（设计 §3.3，纯函数；在途、联网、会话、hold 由调度另挡）：退避到点就重试，没到就等；刚恢复联网立即传；
 * 修改停下 uploadQuietMs、捕获覆盖了全部修改就传；从第一处没上传的修改算起满 uploadMaxMs 就传（捕获没覆盖全部修改也传，最多落后一个捕获的上限）
 */
export function decideUpload(state: UploadState, now: number, limits: Pick<AutosaveLimits, 'uploadQuietMs' | 'uploadMaxMs'>): UploadDecision {
  if (state.retryAt !== undefined)
    return now >= state.retryAt ? { kind: 'upload', reason: 'retry' } : { kind: 'wait', until: state.retryAt }
  if (state.immediate)
    return { kind: 'upload', reason: 'online' }
  // 公式没收齐、上限没到时捕获还没覆盖全部修改：等捕获出来再传
  const covered = state.capturedSeq >= state.seq
  const quietDue = (state.lastChangeAt ?? Number.NEGATIVE_INFINITY) + limits.uploadQuietMs
  if (covered && now >= quietDue)
    return { kind: 'upload', reason: 'quiet' }
  const capDue = state.firstUnuploadedAt === undefined ? Number.POSITIVE_INFINITY : state.firstUnuploadedAt + limits.uploadMaxMs
  if (now >= capDue)
    return { kind: 'upload', reason: 'cap' }
  const until = Math.min(covered ? quietDue : Number.POSITIVE_INFINITY, capDue)
  return Number.isFinite(until) ? { kind: 'wait', until } : { kind: 'idle' }
}

/** 第 attempt 次（从 1 起）连续失败之后的退避 */
export function retryDelay(attempt: number, limits: Pick<AutosaveLimits, 'retryInitialMs' | 'retryMaxMs'>): number {
  return Math.min(limits.retryInitialMs * 2 ** Math.max(0, attempt - 1), limits.retryMaxMs)
}

const TERMINAL_STATUSES: ReadonlySet<SaveStatus> = new Set<SaveStatus>(['conflict', 'outdated', 'too-new'])

/** 调度持有元数据引用，正文完全归工作草稿来源。 */
type SlotCapture = DraftCaptureRef

/** 一次交给保存的状态机的上传：started 是轮到了（向来源要了捕获），serial、seq 是上传的那一份的 */
interface UploadRun {
  started: boolean
  serial: number | undefined
  seq: number | undefined
}

/** 交给了保存的状态机的一次上传：outcome 在它结束、记完账之后兑现（从不失败） */
interface StartedUpload {
  readonly run: UploadRun
  readonly outcome: Promise<SaveOutcome>
}

/**
 * 立即上传在按下时做的准备（审查 A1）：各次按下的"提交单元格、等面板"（并进排着的显式保存时不止一次），与等公式的时限（从按下算，
 * 并进时按最晚的一次按下）
 */
interface Prepared {
  readonly inputs: Promise<InputsSettled>[]
  deadline: number
}

/** 排着、还没轮到的那一次显式保存（保存按钮、快捷键）：再按并进它（审查 A2） */
interface QueuedExplicit {
  readonly upload: StartedUpload
  readonly prepared: Prepared
}

export function createAutosave(options: AutosaveOptions): Autosave {
  const { editor, page, uploader, clock } = options
  const tuning = options.tuning ?? DEFAULT_AUTOSAVE_TUNING
  const listeners = new Set<() => void>()
  let disposed = false
  let suspended = false
  /** 保存到了终态（冲突、不兼容）：不再捕获与上传 */
  let ended = false

  // 修改与组合输入（时刻都在 clock 上）
  let lastChangeAt: number | undefined
  let firstUncapturedAt: number | undefined
  let firstUnuploadedAt: number | undefined
  let lastCompositionEndAt: number | undefined
  let wasComposing = editor.composing()

  // 最近一次捕获
  let latest: SlotCapture | undefined
  /** 最近一次捕获带"公式待更新"；没捕获过时是进入编辑时的初值 */
  let capturePending = options.initialFormulasPending
  /** 上一次捕获的耗时与结束的时刻（大文档拉长间隔） */
  let lastCaptureTiming: { readonly durationMs: number, readonly endedAt: number } | undefined
  /** 定时捕获连续出错的次数：第一次退避之后再试，之后等新的修改 */
  let captureFailures = 0
  let captureRetryAt: number | undefined
  let captureBlockedSeq: number | undefined

  // 上传
  const runs = new Set<UploadRun>()
  /** 排着、还没轮到的那一次显式保存：再按并进它；它开始了或者结束了就不再并进 */
  let queuedExplicit: QueuedExplicit | undefined
  /** 上传成功（确认或去重）了的最新捕获 */
  let uploadedSerial = 0
  /** 要等新内容：这一份与更早的捕获不再自动上传 */
  let blockedSerial: number | undefined
  let retryAt: number | undefined
  /** 服务端给的 Retry-After 到的时刻：恢复联网、会话回来时也不早于它 */
  let retryNotBefore: number | undefined
  /** 连续的、会自动重试的失败（退避） */
  let failures = 0
  /**
   * 连着的会话类失败（401、令牌失效）：只有其中的第一次在会话回到本人时立即重试（审查 A3）。页面对每一次会话类失败都确认会话，
   * 可写随之"真 → 假 → 真"——服务端一直拒绝、而确认照常成功时，每次都跳过退避就是按网络往返的速度连着发
   */
  let sessionFailures = 0
  let lastFailure: SaveFailure['kind'] | undefined
  /** 上传连续出了意外（捕获、压缩）的次数 */
  let unexpectedUploads = 0
  /** codec 失败的引用不能重新准备；退避时重新捕获，次数仍按原意外重试上限算。 */
  let retryCapture: DraftCaptureRef | undefined
  /** 刚恢复联网：下一次上传不等静默 */
  let immediate = false

  // 页面的上一次状态（认出变化的方向）
  let wasVisible = page.visible()
  let wasOnline = page.online()
  let wasWritable = page.sessionWritable()

  let timer: { readonly at: number, readonly cancel: () => void } | undefined
  let current = computeView()

  function computeView(): AutosaveView {
    return { offline: !page.online(), paused: !page.sessionWritable(), retrying: retryAt !== undefined || captureRetryAt !== undefined, held: tuning.held() }
  }

  function notify(): void {
    const next = computeView()
    if ((Object.keys(next) as (keyof AutosaveView)[]).every(key => next[key] === current[key]))
      return
    current = next
    for (const listener of [...listeners])
      listener()
  }

  /** 交给测试构建的控制：它出错不影响保存，上报 */
  function observe(event: AutosaveEvent): void {
    try {
      options.observe?.(event)
    }
    catch (error) {
      options.reportError(error)
    }
  }

  function savedState(): SavedState {
    const view = uploader.view()
    return { edits: !view.unsavedEdits, formulas: !view.formulasPending }
  }

  // ---- 计时 ----

  function cancelTimer(): void {
    timer?.cancel()
    timer = undefined
  }

  /** 到 at 再看一次（已经有更早的就不动） */
  function schedule(at: number): void {
    if (disposed || (timer !== undefined && timer.at <= at))
      return
    cancelTimer()
    const cancel = clock.schedule(() => {
      timer = undefined
      evaluate()
    }, Math.max(0, at - clock.now()))
    timer = { at, cancel }
  }

  /** 立即再看一次：排在下一个宏任务里，不在信号的回调里捕获（信号可能在 SDK 执行命令的过程中到达） */
  function kick(): void {
    schedule(clock.now())
  }

  // ---- 捕获 ----

  /** 当场捕获进"最近一次捕获"（同步）；出错原样抛出，由调用方处理 */
  function captureNow(trigger: CaptureTrigger, formulasPending: boolean): SlotCapture {
    const startedAt = clock.now()
    const entry = takeSnapshot(editor, options.draft, { formulasPending, dedupe: trigger !== 'save-button' })
    const endedAt = clock.now()
    latest = entry
    capturePending = formulasPending
    lastCaptureTiming = { durationMs: endedAt - startedAt, endedAt }
    // 捕获是同步的：序号就是现在的，之前的修改都在里面
    firstUncapturedAt = undefined
    captureFailures = 0
    captureRetryAt = undefined
    captureBlockedSeq = undefined
    uploader.noteCapture(entry)
    observe({ kind: 'capture', trigger, at: endedAt, seq: entry.editorSeq, formulasPending, bytes: entry.bytes, durationMs: endedAt - startedAt })
    return entry
  }

  /** 定时、切到后台的捕获出错：上报（保存的状态机显示保存失败），第一次退避之后再试，之后等新的修改 */
  function captureFailed(trigger: CaptureTrigger, error: unknown): void {
    const now = clock.now()
    captureFailures += 1
    if (captureFailures === 1) {
      captureRetryAt = now + retryDelay(1, tuning.limits())
    }
    else {
      captureRetryAt = undefined
      captureBlockedSeq = editor.changeSeq()
    }
    observe({ kind: 'capture-failed', trigger, at: now })
    uploader.captureFailed(error)
    notify()
  }

  /** 定时的捕获（设计 §3.2）：该捕获就捕获；交回下一次该看的时刻（没有要等的时为 Infinity，修改与公式、组合的信号会再叫醒） */
  function captureStep(now: number, limits: AutosaveLimits): number {
    if (captureRetryAt !== undefined && now < captureRetryAt)
      return captureRetryAt
    const seq = editor.changeSeq()
    if (captureBlockedSeq !== undefined && seq <= captureBlockedSeq)
      return Number.POSITIVE_INFINITY
    const captureLimits: CaptureLimits = { quietMs: limits.captureQuietMs, maxMs: limits.captureMaxMs, spacingFactor: limits.captureSpacingFactor }
    const decision = decideCapture({
      seq,
      capturedSeq: latest?.editorSeq ?? 0,
      firstUncapturedAt,
      lastChangeAt,
      composing: editor.composing(),
      lastCompositionEndAt,
      settled: editor.formulasSettled(),
      capturePending,
      lastCapture: lastCaptureTiming,
    }, now, captureLimits)
    if (decision.kind === 'wait')
      return decision.until
    if (decision.kind === 'capture') {
      try {
        captureNow(decision.reason, decision.formulasPending)
      }
      catch (error) {
        captureFailed(decision.reason, error)
        return captureRetryAt ?? Number.POSITIVE_INFINITY
      }
    }
    return Number.POSITIVE_INFINITY
  }

  /** 切到后台、测试构建的控制：有没捕获的修改（或带标记而公式收齐了）就当场捕获，不等静默、不等公式、不管组字 */
  function captureIfNeeded(trigger: CaptureTrigger): void {
    const settled = editor.formulasSettled()
    if (editor.changeSeq() <= (latest?.editorSeq ?? 0) && !(capturePending && settled))
      return
    try {
      captureNow(trigger, !settled)
    }
    catch (error) {
      captureFailed(trigger, error)
    }
  }

  // ---- 上传 ----

  /** 最近一次捕获还要不要传：没传过、不在等新内容、没有排着或在途的上传会带上它 */
  function uploadPending(): boolean {
    if (latest === undefined || latest.serial <= uploadedSerial)
      return false
    if (blockedSerial !== undefined && latest.serial <= blockedSerial)
      return false
    const serial = latest.serial
    return ![...runs].some(run => !run.started || run.serial === serial)
  }

  /**
   * 交给保存的状态机上传（同步排上：调用之后它的视图立即是保存中，先后按调用的顺序）：source 在轮到时给出要上传的那一份（最近一次捕获，
   * 或者等完按下时的准备与公式再捕获的那一份）。结束之后按结果更新退避与"传过了没有"（每次上传只记一次账），立即再看
   */
  function startUpload(trigger: UploadTrigger, source: () => SlotCapture | 'cell-editing' | Promise<SlotCapture | 'cell-editing'>, dedupe: boolean): StartedUpload {
    const run: UploadRun = { started: false, serial: undefined, seq: undefined }
    runs.add(run)
    const startedAt = clock.now()
    /** 交给保存的状态机的这一刻会话可写（定时、切到后台的上传只在可写时发起；立即上传由调用方确认过会话） */
    const writableAtStart = page.sessionWritable()
    if (trigger === 'retry')
      retryAt = undefined
    immediate = false
    notify()
    let finished = false
    /** 结果出来之后（保存的状态机在视图更新之前同步交来，或者 save 兑现时）：只做一次 */
    const finish = (outcome: SaveOutcome): void => {
      if (finished)
        return
      finished = true
      runs.delete(run)
      if (queuedExplicit?.upload.run === run)
        queuedExplicit = undefined
      if (disposed)
        return
      observe({ kind: 'upload', trigger, startedAt, at: clock.now(), seq: run.seq, outcome })
      afterUpload(outcome, run.serial)
      notify()
      kick()
    }
    const saving = uploader.save(async (): Promise<PreparedCapture> => {
      run.started = true
      const entry = await source()
      if (entry === 'cell-editing')
        return entry
      // 轮到时会话比交给保存的状态机时变差了（期间得知令牌失效、开始确认会话、换了人）：不带着它发（令牌失效时一定被拒，P3 复验 UB1）——
      // 排在在途后面的上传会遇到：在途的那一次得到令牌失效，页面随即确认会话。捕获留着、不算一次失败（不另加会话类失败的次数），
      // 会话回来时照常上传。交出时本来就不可写的（调用方确认会话失败、但令牌没有失效时照常保存，P3）不在此列
      if (writableAtStart && !page.sessionWritable())
        return 'session'
      run.serial = entry.serial
      run.seq = entry.editorSeq
      // 这一份是此刻最近的捕获，之后的修改不在里面：上传的上限从它们之中的第一处算
      firstUnuploadedAt = firstUncapturedAt
      return entry
    }, { dedupe, onOutcome: finish })
    const outcome = saving.then((result) => {
      finish(result)
      return result
    })
    return { run, outcome }
  }

  async function runUpload(trigger: UploadTrigger, source: () => SlotCapture | 'cell-editing' | Promise<SlotCapture | 'cell-editing'>, dedupe: boolean): Promise<SaveOutcome> {
    return startUpload(trigger, source, dedupe).outcome
  }

  /**
   * 立即上传在调用（按下）的这一刻的准备（审查 A1，snapshot-capture.ts 的 settleInputs）：提交这一刻开着的单元格编辑（同步发起）、
   * 开始等面板；等公式的时限从这一刻算。没有轮到它（会话不对、已停下）时它的出错不成为没处理的拒绝：轮到时等它照样抛出
   */
  function prepareNow(): Prepared {
    const inputs = settleInputs(editor)
    inputs.catch(() => undefined)
    return { inputs: [inputs], deadline: clock.now() + tuning.limits().captureMaxMs }
  }

  /**
   * 上传按下时准备过的那一份（save-button、exit、handover、idle-release）：轮到时等按下时的准备都做完、等公式（至多到时限）、捕获。
   * 按下时提交不了单元格而它现在还开着：中止（只是提示）；之后用户自己提交或放弃了就照常存。
   * 显式保存排着、还没轮到时再按：并进它——这一次按下的准备也等到，等公式的时限按最晚的一次按下算，结果是同一个，只记一次账（审查 A2：
   * 不能各自再记一遍，否则失败、意外按两次算，退避翻倍过快、一次意外就不再重试，422 挡住之后新的捕获）
   */
  async function uploadPrepared(reason: PreparedReason, prepared: Prepared): Promise<SaveOutcome> {
    const queued = queuedExplicit
    if (reason === 'save-button' && queued !== undefined && !queued.upload.run.started) {
      queued.prepared.inputs.push(...prepared.inputs)
      queued.prepared.deadline = Math.max(queued.prepared.deadline, prepared.deadline)
      return queued.upload.outcome
    }
    const upload = startUpload(reason, async () => {
      const results = await Promise.all(prepared.inputs)
      if (results.includes('cell-editing') && editor.isCellEditing())
        return 'cell-editing'
      return captureSettled(editor, { settleTimeoutMs: () => prepared.deadline - clock.now(), take: formulasPending => captureNow(reason, formulasPending) })
    }, PREPARED_DEDUPE[reason])
    if (reason === 'save-button')
      queuedExplicit = { upload, prepared }
    return upload.outcome
  }

  /** 按这一次上传的结果更新退避与"传过了没有" */
  function afterUpload(outcome: SaveOutcome, serial: number | undefined): void {
    switch (outcome.kind) {
      case 'saved':
      case 'deduped':
        if (serial !== undefined)
          uploadedSerial = Math.max(uploadedSerial, serial)
        failures = 0
        sessionFailures = 0
        unexpectedUploads = 0
        retryAt = undefined
        retryNotBefore = undefined
        lastFailure = undefined
        blockedSerial = undefined
        return
      case 'failed':
        failed(outcome.failure, serial)
        return
      case 'skipped':
        if (outcome.reason === 'ended')
          end()
    }
  }

  /** 上传失败之后（设计 §3.8） */
  function failed(failure: SaveFailure, serial: number | undefined): void {
    const now = clock.now()
    const limits = tuning.limits()
    lastFailure = failure.kind
    sessionFailures = failure.kind === 'session' ? sessionFailures + 1 : 0
    switch (failure.kind) {
      case 'retry': {
        failures += 1
        // 服务端给的 Retry-After 至多按 AUTOSAVE_RETRY_AFTER_MAX_MS 算：异常的大值不让自动保存停上几天，计时器也不溢出（复验 C2）
        const retryAfterMs = failure.retryAfterMs === undefined ? undefined : Math.min(failure.retryAfterMs, AUTOSAVE_RETRY_AFTER_MAX_MS)
        retryNotBefore = retryAfterMs === undefined ? undefined : now + retryAfterMs
        retryAt = now + Math.max(retryDelay(failures, limits), retryAfterMs ?? 0)
        return
      }
      case 'session':
        // 页面在确认会话（会话不对时不发）；会话回到本人时只有连着的第一次不等退避（onPageChange），之后与一直显示可写时一样按退避再试
        failures += 1
        retryAt = now + retryDelay(failures, limits)
        return
      case 'content':
        retryAt = undefined
        blockedSerial = serial ?? latest?.serial
        return
      case 'unexpected': {
        const working = options.draft.view()
        if (working.kind === 'working' && working.ref === latest && working.summary?.kind === 'failed')
          retryCapture = working.ref
        unexpectedUploads += 1
        if (unexpectedUploads === 1) {
          retryAt = now + retryDelay(1, limits)
        }
        else {
          retryAt = undefined
          blockedSerial = latest?.serial
        }
        return
      }
      case 'cell-editing':
        return
      case 'terminal':
        end()
    }
  }

  /** 定时的上传（设计 §3.3）：交回下一次该看的时刻（没有时为 Infinity） */
  function uploadStep(now: number, limits: AutosaveLimits): number {
    if (runs.size > 0 || !uploadPending()) {
      if (runs.size === 0)
        immediate = false
      return Number.POSITIVE_INFINITY
    }
    // 会话、联网、hold、停住（换了人、失去编辑权）：不发，等信号
    if (!page.online() || !page.sessionWritable() || tuning.held() || !uploader.view().canSave)
      return Number.POSITIVE_INFINITY
    const decision = decideUpload({
      seq: editor.changeSeq(),
      capturedSeq: latest?.editorSeq ?? 0,
      lastChangeAt,
      firstUnuploadedAt,
      retryAt,
      immediate,
    }, now, limits)
    if (decision.kind === 'wait')
      return decision.until
    if (decision.kind === 'upload')
      void runUpload(decision.reason, latestCapture, true)
    return Number.POSITIVE_INFINITY
  }

  /** 最近一次捕获（定时、切到后台的上传轮到时取它） */
  function latestCapture(): SlotCapture {
    if (latest === undefined)
      throw new Error('没有可上传的捕获')
    if (retryCapture === latest) {
      retryCapture = undefined
      return captureNow('retry', !editor.formulasSettled())
    }
    return latest
  }

  /** 看一次：该捕获就捕获，该上传就上传，再排下一次 */
  function evaluate(): void {
    if (disposed || ended || suspended)
      return
    const now = clock.now()
    const limits = tuning.limits()
    const captureAt = captureStep(now, limits)
    const uploadAt = uploadStep(now, limits)
    const next = Math.min(captureAt, uploadAt)
    if (Number.isFinite(next))
      schedule(next)
  }

  /** 到了终态（冲突、不兼容）：不再捕获与上传 */
  function end(): void {
    ended = true
    cancelTimer()
  }

  // ---- 信号 ----

  function onEditorChange(): void {
    const now = clock.now()
    lastChangeAt = now
    firstUncapturedAt ??= now
    firstUnuploadedAt ??= now
    kick()
  }

  function onCompositionChange(): void {
    const composing = editor.composing()
    if (wasComposing && !composing)
      lastCompositionEndAt = clock.now()
    wasComposing = composing
    kick()
  }

  /**
   * 切到后台（设计 §3.4）：当场捕获、立刻发起上传，全程不靠计时器；会话或联网不对时只捕获。在退避期内（上一次失败之后的退避、
   * 服务端给的 Retry-After）也只捕获、不立即重发（审查 A4：开着多份文档的人常在标签页之间切换，每次离开都重发一次就违背了服务端的节流）——
   * 到点（计时器）或者回到前台时再传
   */
  function onHidden(): void {
    if (ended || suspended)
      return
    captureIfNeeded('hidden')
    const backingOff = retryAt !== undefined && clock.now() < retryAt
    if (page.online() && page.sessionWritable() && uploader.view().canSave && uploadPending() && !backingOff)
      void runUpload('hidden', latestCapture, true)
  }

  function onPageChange(): void {
    if (disposed)
      return
    const visible = page.visible()
    const online = page.online()
    const writable = page.sessionWritable()
    const hidden = wasVisible && !visible
    const cameOnline = !wasOnline && online
    const cameBack = !wasWritable && writable
    wasVisible = visible
    wasOnline = online
    wasWritable = writable
    const now = clock.now()
    // 恢复联网：立即上传，不等退避；会话回到本人：连着的会话类失败的第一次不等退避（多半是令牌换过了），之后照退避（审查 A3：确认照常成功
    // 而服务端一直拒绝时，不能每次都跳过）。两处都不早于服务端给的 Retry-After（复验 C7）
    const notBeforeRetryAfter = retryNotBefore !== undefined && retryNotBefore > now ? retryNotBefore : now
    if (cameOnline) {
      immediate = true
      if (retryAt !== undefined)
        retryAt = notBeforeRetryAfter
    }
    if (cameBack && lastFailure === 'session' && sessionFailures === 1 && retryAt !== undefined)
      retryAt = notBeforeRetryAfter
    if (hidden)
      onHidden()
    notify()
    kick()
  }

  function onUploaderChange(): void {
    if (TERMINAL_STATUSES.has(uploader.view().status)) {
      end()
      return
    }
    kick()
  }

  function onTuningChange(): void {
    notify()
    kick()
  }

  /** 换钥/恢复可以重写同一编辑序号；旧引用已被取代，不能继续拿它反复准备上传。 */
  function onDraftChange(): void {
    const working = options.draft.view()
    if (disposed || ended || latest === undefined || working.kind !== 'working' || working.ref.sessionId !== latest.sessionId || working.ref.editorSeq !== latest.editorSeq || working.ref.serial <= latest.serial)
      return
    latest = working.ref
    capturePending = working.ref.formulasPending
    retryCapture = undefined
    uploader.noteCapture(working.ref)
    kick()
  }

  const unsubscribers = [
    editor.onChange(onEditorChange),
    editor.onFormulaProgress(kick),
    editor.onCompositionChange(onCompositionChange),
    page.onChange(onPageChange),
    uploader.subscribe(onUploaderChange),
    tuning.onChange(onTuningChange),
    options.draft.subscribe(onDraftChange),
  ]
  // 打开不算修改（与保存的状态机同一个基线 0）：建起来时已经有修改的，按此刻有了修改算
  if (editor.changeSeq() > 0) {
    const now = clock.now()
    lastChangeAt = now
    firstUncapturedAt = now
    firstUnuploadedAt = now
  }
  if (TERMINAL_STATUSES.has(uploader.view().status))
    end()
  kick()

  return {
    view: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    flush: async (reason, flushOptions) => {
      if (disposed || ended)
        return { ...savedState(), outcome: undefined }
      if (reason !== 'control') {
        // 按下的这一刻：提交这一刻开着的单元格编辑、开始等面板，等公式的时限从这一刻算（排在在途的保存后面、等会话的确认、等面板的防抖、
        // 提交单元格时，用掉的时间都算在里面）
        const prepared = prepareNow()
        if (flushOptions?.ready !== undefined && !(await flushOptions.ready()))
          return { ...savedState(), outcome: undefined }
        if (disposed || ended)
          return { ...savedState(), outcome: undefined }
        const outcome = await uploadPrepared(reason, prepared)
        return { ...savedState(), outcome }
      }
      // 测试构建的控制：与切到后台同样的规则——当场捕获、去重，会话或联网不对时不发
      captureIfNeeded(reason)
      if (!page.online() || !page.sessionWritable() || latest === undefined || latest.serial <= uploadedSerial)
        return { ...savedState(), outcome: undefined }
      const outcome = await runUpload(reason, latestCapture, true)
      return { ...savedState(), outcome }
    },
    saved: savedState,
    suspend: () => {
      suspended = true
      cancelTimer()
    },
    resume: () => {
      suspended = false
      kick()
    },
    dispose: () => {
      if (disposed)
        return
      disposed = true
      cancelTimer()
      for (const unsubscribe of unsubscribers.splice(0))
        unsubscribe()
      listeners.clear()
    },
  }
}
