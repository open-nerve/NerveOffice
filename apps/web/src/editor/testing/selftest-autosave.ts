// 页面自检观察真实的自动保存（M3-P4 S7，设计 §3.15"实现之后再跑一次"：自动保存端到端——改完 → 服务器上的公式值 → 隐藏之后存下）。
// S1 在自动保存实现之前用捕获规则的参考实现另做捕获；S7 起各场景看编辑器页里真实的自动保存（features/sheet-editor/autosave.ts，
// 模块边界不让 editor/testing 引用它）经测试构建的控制（./autosave-control.ts，window.__nerveAutosaveControl）露出来的：
// - 准备（prepareAutosave）：场景开始时核对调度接上了、进入编辑到现在没有捕获与上传（打开不算修改），按场景定下照常（running，
//   与生产相同）还是暂停定时的上传（held：捕获照常，立即上传——切到后台、flush——照常）与节奏；装上保存请求的记录；
// - 捕获：控制的日志（原因、时刻、序号、带不带"公式待更新"、字节数）。要捕获的内容时用同步的订阅（watchCaptures）：调度捕获之后、
//   同一个同步段里另取一份内存快照——序号与字节数都要与调度的那一份相同（核对，不同就记下）；
// - 上传：控制的日志（原因、开始与结束的时刻、序号、结果与 requestId）与页面发出的保存请求（这里包一层 fetch 记下：查询参数里的
//   requestId、"公式待更新"、修改序号，回应的状态码与时刻），两边按 requestId 对上。服务端原样存下上传的 gzip 字节，所以服务器上的
//   内容就是上传的那一份，场景读回来核对（selftest-session.ts 的 fetchServerContent）；
// - 时刻都在 performance.now() 上：调度的时钟（edit-lease.ts 的 browserLeaseClock）、探针的命令日志与这里的请求记录相同。
import type { AutosaveControl, AutosaveControlLimits, AutosaveLogEntry } from './autosave-control.ts'
import type { Session } from './selftest-session.ts'
import { AUTOSAVE_CONTROL_GLOBAL } from './autosave-control.ts'
import { waitFor } from './selftest-dom.ts'
import { fail } from './selftest-session.ts'

export type CaptureEntry = Extract<AutosaveLogEntry, { kind: 'capture' }>
export type UploadEntry = Extract<AutosaveLogEntry, { kind: 'upload' }>

/** 页面上的自动保存控制（测试构建在组装编辑器页之前装上） */
export function autosaveControl(): AutosaveControl {
  const control = (window as unknown as Record<string, AutosaveControl | undefined>)[AUTOSAVE_CONTROL_GLOBAL]
  if (control === undefined)
    fail(`页面上没有自动保存的控制（window.${AUTOSAVE_CONTROL_GLOBAL}）：不是测试构建？`)
  return control
}

// ---- 说法 ----

const TRIGGER_TEXT: Readonly<Record<string, string>> = {
  'quiet': '静默',
  'cap': '上限',
  'formulas': '公式收齐之后补捕获',
  'retry': '重试',
  'online': '恢复联网',
  'hidden': '切到后台',
  'save-button': '保存按钮',
  'exit': '退出编辑',
  'handover': '交出',
  'idle-release': '空闲释放',
  'control': '控制的 flush',
}

export function triggerText(trigger: string): string {
  return TRIGGER_TEXT[trigger] ?? trigger
}

function outcomeText(outcome: UploadEntry['outcome']): string {
  switch (outcome.kind) {
    case 'saved':
      return '存上'
    case 'deduped':
      return '去重'
    case 'failed':
      return `失败（${outcome.failure?.kind ?? '?'}）`
    default:
      return `没做（${outcome.reason ?? '?'}）`
  }
}

/** 日志的一条（给说明） */
function entryText(entry: AutosaveLogEntry): string {
  switch (entry.kind) {
    case 'capture':
      return `捕获（${triggerText(entry.trigger)}，序号 ${entry.seq}${entry.formulasPending ? '，公式待更新' : ''}）`
    case 'capture-failed':
      return `捕获出错（${triggerText(entry.trigger)}）`
    case 'upload':
      return `上传（${triggerText(entry.trigger)}，序号 ${entry.seq ?? '—'}，${outcomeText(entry.outcome)}）`
  }
}

/** 日志的末尾几条与页面的保存状态（给不通过时的说明） */
export function describeAutosave(session: Session): string {
  const control = autosaveControl()
  const log = control.log()
  const tail = log.slice(-6).map(entryText).join('、')
  return `本地修改序号 ${session.probe.changeSeq()}，保存状态 ${session.host.view().save ?? '没有'}，定时的上传${control.held() ? '暂停' : '照常'}；日志 ${log.length} 条${tail === '' ? '' : `，最后：${tail}`}`
}

// ---- 准备 ----

/**
 * 自检开始时（任何场景）：暂停定时的上传、换回默认的节奏（M3-P4 S7 审查 B1）。打开时的状态随入口页（写 held）与 Playwright 的夹具
 * （E2E_AUTOSAVE）而定，这里不依赖它：不验证自动保存的场景（进入与退出编辑、界面检查）里不会按时上传，捕获时机的场景在 checkEditing
 * 里按自己的需要放开（prepareAutosave）。页面上没有控制（不是测试构建）时什么也不做，捕获时机的场景会在准备时说明
 */
export function holdTimedAutosave(): void {
  const control = (window as unknown as Record<string, AutosaveControl | undefined>)[AUTOSAVE_CONTROL_GLOBAL]
  control?.resetLimits()
  control?.hold()
}

/** 一个场景里自动保存怎么跑 */
export interface AutosaveSetup {
  /**
   * running：照常（与生产相同，真实 Safari 里打开时就是这样）；held：定时触发的上传暂停——捕获照常，立即上传（切到后台、控制的 flush）
   * 照常（autosave.ts 的 AutosaveTuning）
   */
  readonly mode: 'running' | 'held'
  /** 换节奏（其余是生产的默认值） */
  readonly limits?: Partial<AutosaveControlLimits> | undefined
}

/**
 * 场景开始时（编辑的 steady 之后）：调度接上了；进入编辑到现在没有捕获、没有上传（打开不算修改：公式的写回、强制重算都不是修改）；
 * 按 setup 定下照常还是暂停、节奏；装上保存请求的记录。交回说明
 */
export function prepareAutosave(setup: AutosaveSetup): string {
  const control = autosaveControl()
  if (!control.attached())
    fail('进入了编辑，自动保存的调度却没有接上')
  const early = control.log()
  if (early.length > 0)
    fail(`进入编辑到自检开始，自动保存已经有 ${early.length} 条记录（${early.slice(0, 6).map(entryText).join('、')}）：打开不算修改，不应捕获与上传`)
  control.resetLimits()
  if (setup.limits !== undefined)
    control.setLimits(setup.limits)
  if (setup.mode === 'held')
    control.hold()
  else
    control.release()
  installSaveRequestLog()
  const changed = Object.entries(setup.limits ?? {}).map(([key, value]) => `${key} ${String(value)}`).join('、')
  return `进入编辑到现在自动保存没有捕获与上传；这一场景里${setup.mode === 'held' ? '暂停定时的上传（捕获与立即上传照常）' : '自动保存照常运行'}${changed === '' ? '' : `，节奏改为 ${changed}`}`
}

// ---- 页面发出的保存请求 ----

/** 页面发出的一次保存（PUT /api/documents/<id>/content）：查询参数里的几项与回应 */
export interface SaveRequestMark {
  /** 发出的时刻（performance.now()） */
  readonly at: number
  readonly requestId: string | null
  /** "公式待更新"：'true' 或 'false' */
  readonly formulasPending: string | null
  readonly localSeq: string | null
  answeredAt?: number
  /** 状态码；请求失败（网络）时 failed */
  status?: number | 'failed'
}

const SAVE_PATH = /^\/api\/documents\/[^/]+\/content$/

let saveRequestLog: SaveRequestMark[] | undefined

/**
 * 包一层 fetch 记下保存的请求（只观察，不改变请求与回应；同一页只装一次）：页面的请求层每次调用时取全局的 fetch（shared/api/client.ts），
 * 包一层就看得到每个请求（与 ./switch-timing.ts 同样的办法，两层互不影响）
 */
function installSaveRequestLog(): SaveRequestMark[] {
  if (saveRequestLog !== undefined)
    return saveRequestLog
  const marks: SaveRequestMark[] = []
  saveRequestLog = marks
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const url = new URL(request?.url ?? String(input), location.href)
    if (method !== 'PUT' || !SAVE_PATH.test(url.pathname))
      return originalFetch(input, init)
    const mark: SaveRequestMark = { at: performance.now(), requestId: url.searchParams.get('requestId'), formulasPending: url.searchParams.get('formulasPending'), localSeq: url.searchParams.get('localSeq') }
    marks.push(mark)
    try {
      const response = await originalFetch(input, init)
      mark.answeredAt = performance.now()
      mark.status = response.status
      return response
    }
    catch (error) {
      mark.answeredAt = performance.now()
      mark.status = 'failed'
      throw error
    }
  }
  return marks
}

/** 到目前为止页面发出的保存请求（prepareAutosave 装上记录之后的） */
export function saveRequests(): readonly SaveRequestMark[] {
  return saveRequestLog ?? []
}

/** requestId 对应的那一次保存请求 */
export function requestOf(requestId: string | undefined): SaveRequestMark | undefined {
  return requestId === undefined ? undefined : saveRequests().find(mark => mark.requestId === requestId)
}

// ---- 日志 ----

export function capturesIn(log: readonly AutosaveLogEntry[]): CaptureEntry[] {
  return log.filter((entry): entry is CaptureEntry => entry.kind === 'capture')
}

export function uploadsIn(log: readonly AutosaveLogEntry[]): UploadEntry[] {
  return log.filter((entry): entry is UploadEntry => entry.kind === 'upload')
}

/** 服务端确认了这一次（存上；去重的是与最近一次确认过的相同，也算） */
export function confirmed(upload: UploadEntry): boolean {
  return upload.outcome.kind === 'saved' || upload.outcome.kind === 'deduped'
}

/** 日志里不该有的：上传失败、捕获出错。交回说明；没有时 undefined */
function troubleIn(log: readonly AutosaveLogEntry[]): string | undefined {
  const bad = log.find(entry => entry.kind === 'capture-failed' || (entry.kind === 'upload' && !confirmed(entry)))
  return bad === undefined ? undefined : `自动保存出了问题：${entryText(bad)}`
}

// ---- 捕获的内容：同步的订阅 ----

/** 调度的一次捕获，与同一时刻另取的内存快照、公式收齐与否 */
export interface WatchedCapture {
  readonly entry: CaptureEntry
  readonly snapshot: string
  /** 捕获的那一刻公式收齐了没有（与调度读的是同一个跟踪器、同一个同步段）：不带"公式待更新"的捕获都应当是收齐的 */
  readonly settled: boolean
}

export interface CaptureWatch {
  readonly captures: () => readonly WatchedCapture[]
  /** 另取的那一份与调度捕获的对不上（序号或字节数不同）：说明。应当一条都没有 */
  readonly mismatches: () => readonly string[]
  readonly dispose: () => void
}

const UTF8 = new TextEncoder()

/**
 * 订阅调度的捕获：控制在调度捕获之后、同一个同步段里送来日志的这一条（autosave.ts 的 captureNow：取快照、交给保存的状态机、记日志，
 * 中间没有别的命令），这里随即取公式收齐与否、本地修改序号与内存快照（探针的 snapshot 与编辑器的捕获都是 JSON.stringify(save())），
 * 与日志里的序号、字节数（与服务端解压后的字节同一个口径）核对。只在要捕获的内容的场景里用：另取一份快照要时间（大表几十毫秒），
 * 会推迟调度接下来的上传
 */
export function watchCaptures(session: Session): CaptureWatch {
  const captures: WatchedCapture[] = []
  const mismatches: string[] = []
  const unsubscribe = autosaveControl().subscribe((entry) => {
    if (entry.kind !== 'capture')
      return
    const settled = session.probe.formulasSettled()
    const seq = session.probe.changeSeq()
    const snapshot = session.probe.snapshot()
    const bytes = UTF8.encode(snapshot).byteLength
    if (seq !== entry.seq || bytes !== entry.bytes)
      mismatches.push(`捕获（${triggerText(entry.trigger)}，序号 ${entry.seq}、${entry.bytes} 字节）的同一时刻内存里是序号 ${seq}、${bytes} 字节`)
    captures.push({ entry, snapshot, settled })
  })
  return { captures: () => captures, mismatches: () => mismatches, dispose: unsubscribe }
}

// ---- 等 ----

/** 看日志的间隔 */
const POLL_MS = 20

/** 一次确认的上传与它的请求（去重的没有请求） */
export interface Uploaded {
  readonly upload: UploadEntry
  readonly request: SaveRequestMark | undefined
  /** 等的期间看到公式由没收齐变成收齐的最后一个时刻；没看到时为 undefined */
  readonly settledAt: number | undefined
}

/** 这一次上传带不带"公式待更新"：按它的请求的查询参数（去重的没有请求，按不带算——服务器上已有同样的内容与标记） */
export function uploadFlagged(upload: UploadEntry): boolean {
  return requestOf(upload.outcome.requestId)?.formulasPending === 'true'
}

/**
 * 等自动保存把到 seq 为止的修改上传、服务端确认，而且上传的那一份不带"公式待更新"（flagged 为真时带不带都行）。
 * 日志里出现上传失败、捕获出错时立即不通过；确认了的上传在页面上没有记下请求（requestId 对不上）也不通过
 */
export async function untilUploaded(session: Session, seq: number, options: { readonly timeoutMs: number, readonly flagged?: boolean }): Promise<Uploaded> {
  const control = autosaveControl()
  let unsettledSeen = !session.probe.formulasSettled()
  let settledAt: number | undefined
  let found: UploadEntry | undefined
  let trouble: string | undefined
  const look = (): boolean => {
    if (!session.probe.formulasSettled()) {
      unsettledSeen = true
    }
    else if (unsettledSeen) {
      unsettledSeen = false
      settledAt = performance.now()
    }
    const log = control.log()
    trouble = troubleIn(log)
    if (trouble !== undefined)
      return true
    for (const upload of uploadsIn(log)) {
      if (upload.seq === undefined || upload.seq < seq || !confirmed(upload))
        continue
      if (upload.outcome.kind === 'saved' && requestOf(upload.outcome.requestId) === undefined) {
        trouble = `上传 ${upload.outcome.requestId ?? '?'} 存上了，页面上却没有记下它的请求`
        return true
      }
      if (options.flagged === true || !uploadFlagged(upload)) {
        found = upload
        return true
      }
    }
    return false
  }
  if (!await waitFor(look, options.timeoutMs, POLL_MS))
    fail(`${options.timeoutMs / 1000} 秒内自动保存没有把序号 ${seq} 之前的修改上传${options.flagged === true ? '' : '（不带"公式待更新"的一份）'}：${describeAutosave(session)}`)
  if (trouble !== undefined)
    fail(`${trouble}；${describeAutosave(session)}`)
  if (found === undefined)
    fail(`等上传的循环结束了却没有结果：${describeAutosave(session)}`)
  return { upload: found, request: requestOf(found.outcome.requestId), settledAt }
}

/** 自动保存跟上了全部修改的那一刻 */
export interface CaughtUp {
  /** 最后一次捕获（这期间没有修改时没有） */
  readonly capture: CaptureEntry | undefined
  /** 最后一次确认的上传（只在 uploads 为真时看） */
  readonly upload: UploadEntry | undefined
}

/**
 * 等自动保存跟上全部修改，之后 monitorMs 内本地修改序号与日志都不再变：最后一次捕获的序号等于本地修改序号（uploads 为真时最后一次确认的
 * 上传也是，而且不带"公式待更新"）。monitorMs 内又有修改（迟到的修改被检测到）就接着等它被捕获、上传。
 * 日志里出现上传失败、捕获出错时立即不通过
 */
export async function untilCaughtUp(session: Session, options: { readonly uploads: boolean, readonly monitorMs: number, readonly timeoutMs: number }): Promise<CaughtUp> {
  const control = autosaveControl()
  let state: { seq: number, entries: number, since: number } | undefined
  let result: CaughtUp | undefined
  let trouble: string | undefined
  const look = (): boolean => {
    const log = control.log()
    trouble = troubleIn(log)
    if (trouble !== undefined)
      return true
    const seq = session.probe.changeSeq()
    const capture = capturesIn(log).at(-1)
    const upload = uploadsIn(log).filter(confirmed).at(-1)
    const caught = (capture?.seq ?? 0) >= seq && (!options.uploads || ((upload?.seq ?? 0) >= seq && (upload === undefined || !uploadFlagged(upload))))
    const now = performance.now()
    if (!caught || state === undefined || state.seq !== seq || state.entries !== log.length) {
      state = caught ? { seq, entries: log.length, since: now } : undefined
      return false
    }
    if (now - state.since < options.monitorMs)
      return false
    result = { capture, upload: options.uploads ? upload : undefined }
    return true
  }
  if (!await waitFor(look, options.timeoutMs, POLL_MS))
    fail(`${options.timeoutMs / 1000} 秒内自动保存没有跟上全部修改${options.monitorMs > 0 ? `并且之后 ${options.monitorMs / 1000} 秒没有新的变化` : ''}：${describeAutosave(session)}`)
  if (trouble !== undefined)
    fail(`${trouble}；${describeAutosave(session)}`)
  if (result === undefined)
    fail(`等的循环结束了却没有结果：${describeAutosave(session)}`)
  return result
}

// ---- 捕获的时刻与规则 ----

/** 编辑器认作修改的一条命令：记下的时刻与记下时的本地修改序号 */
export interface DetectedChange {
  readonly at: number
  readonly seq: number
}

/**
 * 编辑器认作修改的命令：mark 之后执行完、记下时本地修改序号比前一条大的那些（探针的 changeSeq：变更检测先于探针订阅，
 * 执行完的那一条记下时序号已经加过）——与调度订阅的是同一个信号
 */
export function detectedChanges(session: Session, mark: number, seqAtMark: number): DetectedChange[] {
  let previous = seqAtMark
  const changes: DetectedChange[] = []
  for (const command of session.probe.commands(mark)) {
    if (command.phase === 'executed' && command.changeSeq > previous)
      changes.push({ at: command.at, seq: command.changeSeq })
    previous = Math.max(previous, command.changeSeq)
  }
  return changes
}

/** 命令日志记下修改的时刻比调度记下的略晚（同一个同步段里，探针在变更检测之后订阅）：比较时留出的余量 */
const TIMING_TOLERANCE_MS = 20

/**
 * 捕获的时刻不早于规则（设计 §3.2）允许的那一刻：静默的不早于它之前最后一处修改 + 捕获的静默，上限的不早于上一次捕获之后的第一处修改
 * + 捕获的上限。只看下限（太早捕获才会存下过期的内容；晚了由各场景的时限与时间线看出）。交回不合的说明
 */
export function captureTimingProblems(captures: readonly CaptureEntry[], changes: readonly DetectedChange[], limits: Pick<AutosaveControlLimits, 'captureQuietMs' | 'captureMaxMs'>, baseSeq: number): string[] {
  const problems: string[] = []
  let previousSeq = baseSeq
  for (const capture of captures) {
    if (capture.trigger === 'quiet') {
      const last = changes.filter(change => change.seq <= capture.seq).at(-1)
      if (last !== undefined && capture.at < last.at + limits.captureQuietMs - TIMING_TOLERANCE_MS)
        problems.push(`静默的捕获（序号 ${capture.seq}）在最后一处修改之后 ${Math.round(capture.at - last.at)} ms（应当不早于 ${limits.captureQuietMs} ms）`)
    }
    else if (capture.trigger === 'cap') {
      const first = changes.find(change => change.seq > previousSeq && change.seq <= capture.seq)
      if (first !== undefined && capture.at < first.at + limits.captureMaxMs - TIMING_TOLERANCE_MS)
        problems.push(`上限的捕获（序号 ${capture.seq}）在第一处没捕获的修改之后 ${Math.round(capture.at - first.at)} ms（应当不早于 ${limits.captureMaxMs} ms）`)
    }
    previousSeq = Math.max(previousSeq, capture.seq)
  }
  return problems
}

/** 捕获与上传的经过的一条（给说明）：原因与相对 origin 的毫秒数 */
function timelineText(entry: AutosaveLogEntry, origin: number): string {
  switch (entry.kind) {
    case 'capture':
      return `捕获（${triggerText(entry.trigger)}${entry.formulasPending ? '，公式待更新' : ''}）+${Math.round(entry.at - origin)} ms`
    case 'capture-failed':
      return `捕获出错（${triggerText(entry.trigger)}）+${Math.round(entry.at - origin)} ms`
    case 'upload':
      return `上传（${triggerText(entry.trigger)}${uploadFlagged(entry) ? '，公式待更新' : ''}）+${Math.round(entry.startedAt - origin)}–${Math.round(entry.at - origin)} ms ${outcomeText(entry.outcome)}`
  }
}

/** 捕获与上传的经过（给说明） */
export function autosaveTimeline(log: readonly AutosaveLogEntry[], origin: number): string {
  return log.map(entry => timelineText(entry, origin)).join('、')
}
