// 交接的页面自检（M3-P5 设计 §3.14，S8 后半）：在真实 Safari 上复核同一个浏览器里两个标签页的本人接管（"在此编辑"，US-M3-08），与刷新时
// 在途的保存（设计 §3.7 的 R1、风险表里"WebKit 在刷新一开始就取消在途的保存"那一条，7a759da）。驱动脚本（tests/e2e/safari/selftest.ts）编排：
// 另开标签页、锁住服务器上的内容行让保存停在服务端、按库里的证据判定；Playwright 的校准（specs/editor/selftest.spec.ts）照同样的编排、模拟隐藏。
// 各步的先后看测试构建的交接日志（./handover-log.ts，window.__nerveHandoverLog）与这里自己的观察，随结果交回（timeline，墙上时间）：
// - takeover-holder（A，作者，编辑时）：第一格经控制的 flush 存上（驱动脚本看到这一版才另开 B），同时写第二格（留着）；等 A 变成隐藏（B 一打开
//   A 就隐藏了）——自动保存在隐藏的那一刻上传第二格（P4）；隐藏之后再写第三格（捕获的静默与上限调到一小时，留着）；然后等结果：
//   · handed-over：A 回应了 B 的交接请求，先保存（第三格也存上）再交出、回到阅读，说明"已在本浏览器的另一个标签页接着编辑"；
//   · lost：A 没有回应（被 Safari 暂停、冻结），B 3 秒之后本人接管并抢锁，A 得知锁被抢（回到前台时）——失去编辑权，说法是"你在本浏览器的
//     另一个标签页接手了编辑"，第三格没有存上，"另存为副本"：副本里有三格，原文档里只有前两格。
//   Playwright 里 A 从不被暂停：照常回应（handed-over）；校准另有一条只给 A 吞掉交接频道的消息（与 S6 的 E2E 同一个办法），走 lost；
// - takeover-taker（B，同一个会话直接打开编辑器页）：阅读时说明"你在本浏览器的另一个标签页里正在编辑"，从页面开始载入算 8 秒之后点"在此编辑"，
//   等进入编辑；按交接日志判定走了哪条路（answered：3 秒内收到 ack、等 A 做完再普通申请；silent：3 秒没有回应、以本人接管申请并抢锁），
//   记下回应用了多久、多久进入编辑；核对服务器上 A 的修改（前两格一定在，第三格只在 answered 时在）；
// - refresh-save（作者，阅读时开始，跨两次载入）：第一次——点"编辑"，写一格，经控制的 flush 发出保存（驱动脚本让这份文档的保存在服务端停
//   10 秒），1.5 秒之后还在途就刷新（location.reload）；离开时看到了什么（保存的请求什么时候失败、pagehide 时保存的状态、页面的处理之后 localStorage
//   里有没有记号、有没有发释放或交出）同步记进 sessionStorage。第二次（刷新之后）——这些交回；阅读时说明"另一台设备或浏览器（也可能是刚关闭、
//   刷新过的页面）"；记号在；点"在此编辑"先等（waiting-save，"上一个页面的保存还在进行，稍后接手…"），那次保存提交了（在服务端停完）才以
//   本人接管申请、进入编辑（committed），或者等满 30 秒（expired，从记号的时刻算）；服务器上有那次保存，记号清掉。
import type { HandoverLog, HandoverLogEntry } from './handover-log.ts'
import type { SelftestCheck, SelftestTimelineEntry, SelftestTiming } from './selftest-report.ts'
import type { Session } from './selftest-session.ts'
import { HANDOVER_LOG_GLOBAL } from './handover-log.ts'
import { autosaveControl, capturesIn, describeAutosave, prepareAutosave, requestOf, saveRequests, triggerText, untilUploaded } from './selftest-autosave.ts'
import { checkEditing, facade, round, sleep } from './selftest-capture-common.ts'
import { waitFor } from './selftest-dom.ts'
import { REFRESH_SAVE_EDIT, TAKEOVER_EDITS, TAKEOVER_TAKER_DELAY_MS } from './selftest-report.ts'
import { adoptEditor, check, CHECK_TIMEOUT_MS, chromeButton, describe, describeView, fail, fetchServerContent, fetchServerDocument, SIGNAL_TIMEOUT_MS, SWITCH_TIMEOUT_MS, untilSwitched } from './selftest-session.ts'

/** 页头里"在此编辑"的说法（与编辑器页的文案相同；这里不引用编辑器页的模块） */
const TAKE_OVER_HERE = '在此编辑'

/** 捕获的静默与上限调到一小时：场景里只有控制的 flush 与切到后台会捕获、上传 */
const NO_TIMED_CAPTURE_MS = 3_600_000

/** 等页面变成隐藏最多多久：驱动脚本在库里看到第一格之后才另开 B */
const HIDDEN_WAIT_MS = 120_000

/** 隐藏之后等自动保存把第二格上传最多多久（Safari 隐藏几秒之后就压低计时器：上传要在那之前发出） */
const SAVE_WAIT_MS = 20_000

/**
 * A 隐藏之后等结果最多多久：B 载入、等 8 秒、请 A 交出（至多 3 秒回应、20 秒做完）、进入编辑、交回结果、关掉标签页之后 A 才回到前台——
 * A 被暂停时它自己的计时器也停着，回到前台之后才接着看
 */
const HOLDER_OUTCOME_WAIT_MS = 150_000

/** B 点"在此编辑"之后等进入编辑最多多久：回应 3 秒 + 做完 20 秒 + 申请与以可编辑重建、到 steady */
const TAKER_ENTER_WAIT_MS = 60_000

/** refresh-save：发出保存之后等多久再看它还在不在途（驱动脚本让它在服务端停 10 秒，这时还没有结果） */
const SAVE_HELD_CONFIRM_MS = 1_500

/** refresh-save：点了"在此编辑"之后等进入编辑最多多久：记号的 30 秒 + 申请与重建、到 steady */
const REFRESH_ENTER_WAIT_MS = 60_000

/**
 * 刷新之前在途的保存最多等多久（从记号的时刻算，contracts 的 EDIT_PENDING_SAVE_WAIT_MS）与等的时候读编辑状态的间隔（编辑器页 self-takeover.ts 的
 * PENDING_SAVE_POLL_MS）。这里不引用 contracts 与编辑器页的模块（引用 contracts 会改变测试构建的分块：测试构建里多出一次 zod 的 eval 探测，
 * CSP 违规），另写一份，单元测试核对与 contracts 的相同
 */
export const PENDING_SAVE_WAIT_MS = 30_000
const PENDING_SAVE_POLL_MS = 2_000

/** refresh-save：刷新之后的那次载入要的（同一个标签页的 sessionStorage，刷新之后还在） */
const REFRESH_CARRY_KEY = 'nerve-office.selftest.refresh-save'

/** 刷新时在途的保存的记号（编辑器页的 pending-save-marker.ts 的键；这里不引用编辑器页的模块，另写一份） */
export function pendingSaveKeyOf(documentId: string): string {
  return `nerve-office:pending-save:${documentId}`
}

// ---- 日志与时间线 ----

/** 交接日志里的一条（./handover-log.ts 的 HandoverLogEntry：种类、本页的单调时钟、墙上时间与各自的字段） */
export type LogEntry = Pick<HandoverLogEntry, 'kind' | 'at' | 'wall'> & Readonly<Record<string, unknown>>

/** 页面上的交接日志（测试构建在组装编辑器页之前装上） */
function handoverLog(): HandoverLog {
  const log = (window as unknown as Record<string, HandoverLog | undefined>)[HANDOVER_LOG_GLOBAL]
  if (log === undefined)
    fail(`页面上没有交接日志（window.${HANDOVER_LOG_GLOBAL}）：不是测试构建？`)
  return log
}

/** 场景自己的一条观察：种类带 page: 前缀（与交接日志的分开），墙上时间与本页的单调时钟 */
function observation(kind: string, fields: Readonly<Record<string, unknown>> = {}): SelftestTimelineEntry {
  return { kind: `page:${kind}`, wall: Date.now(), at: round(performance.now()), ...fields }
}

/** 交回的时间线：交接日志（拷贝）与场景的观察，按墙上时间排好 */
function timelineWith(observations: readonly SelftestTimelineEntry[]): SelftestTimelineEntry[] {
  const log = (window as unknown as Record<string, HandoverLog | undefined>)[HANDOVER_LOG_GLOBAL]?.log() ?? []
  return [...log.map(entry => ({ ...entry, at: round(entry.at) })), ...observations].sort((a, b) => a.wall - b.wall)
}

/** 页面变成隐藏、又显示出来（记进时间线）；在 window 上的捕获阶段听：先于编辑器页挂在 document 上的处理（自动保存在那里同步捕获、发起上传） */
interface VisibilityWatch {
  /** 第一次变成隐藏的时刻（performance.now） */
  readonly hiddenAt: () => number | undefined
  readonly dispose: () => void
}

function watchVisibility(observations: SelftestTimelineEntry[]): VisibilityWatch {
  let hiddenAt: number | undefined
  const listener = (): void => {
    observations.push(observation(`visibility-${document.visibilityState}`))
    if (document.visibilityState === 'hidden')
      hiddenAt ??= performance.now()
  }
  window.addEventListener('visibilitychange', listener, true)
  return { hiddenAt: () => hiddenAt, dispose: () => window.removeEventListener('visibilitychange', listener, true) }
}

// ---- 页面上的文字 ----

/** 空白合并之后的文字 */
function textOf(element: Element | null | undefined): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** 页头里的读屏状态（role=status）的文字 */
function statusTexts(session: Session): string[] {
  return [...session.host.chrome.querySelectorAll('[role="status"]')].map(textOf).filter(text => text !== '')
}

/** 一直在的读屏状态区（data-slot="status-region"）的文字 */
function statusRegionText(session: Session): string {
  return textOf(session.host.chrome.querySelector('[data-slot="status-region"]'))
}

/** 失去编辑权的说明（role=alert，以"编辑权已失效"开头）的文字；没有时空串 */
function lostNoticeText(session: Session): string {
  return [...session.host.chrome.querySelectorAll('[role="alert"]')].map(textOf).find(text => text.startsWith('编辑权已失效')) ?? ''
}

/** 快照里一格的值 */
function cellOf(snapshot: string, cell: { readonly sheetId: string, readonly row: number, readonly column: number }): unknown {
  const workbook = JSON.parse(snapshot) as { readonly sheets: Readonly<Record<string, { readonly cellData?: Readonly<Record<string, Readonly<Record<string, { readonly v?: unknown }>>>> }>> }
  return workbook.sheets[cell.sheetId]?.cellData?.[cell.row]?.[cell.column]?.v
}

/** 内容里这几格在不在（值相同）：交回"A1 在、A3 不在"一类的说明与不符合 expected 的那些 */
function cellsIn(snapshot: string, cells: readonly { readonly sheetId: string, readonly cell: string, readonly row: number, readonly column: number, readonly value: string }[], expected: readonly boolean[]): { readonly text: string, readonly wrong: string[] } {
  const present = cells.map(cell => cellOf(snapshot, cell) === cell.value)
  return {
    text: cells.map((cell, index) => `${cell.cell}${present[index] === true ? '在' : '不在'}`).join('、'),
    wrong: cells.flatMap((cell, index) => present[index] === expected[index] ? [] : [`${cell.cell}${expected[index] === true ? '应当在' : '不应在'}`]),
  }
}

// ---- 交接日志的判读（纯函数，单元测试覆盖） ----

/** B 这一侧走了哪条路 */
export type TakerPath = 'answered' | 'silent' | 'failed' | 'unknown'

export interface TakerSummary {
  readonly path: TakerPath
  /** 各段的毫秒数（相对"在此编辑"开始或发出请求；没有那一步时 null） */
  readonly ms: Readonly<Record<string, number | null>>
  /** 不合预期的地方（空的就是按设计走完了一条路） */
  readonly problems: readonly string[]
  readonly text: string
}

function firstOf(log: readonly LogEntry[], kind: string, where: (entry: LogEntry) => boolean = () => true): LogEntry | undefined {
  return log.find(entry => entry.kind === kind && where(entry))
}

function since(entry: LogEntry | undefined, origin: LogEntry | undefined): number | null {
  return entry === undefined || origin === undefined ? null : round(entry.at - origin.at)
}

/**
 * B 的交接日志（"在此编辑"开始之后）判读成一条路（M3-P5 设计 §3.7）：
 * - answered：3 秒内收到 ack，之后锁空了或收到 done（A 存上、释放、放了锁），再普通申请（接管方式为空；A 的释放没送到、被自己占着时另以本人接管再申请一次）；
 * - silent：3 秒没有回应（或者回应了、20 秒没做完），以本人接管申请；
 * - failed：A 回应没能保存（这里不该出现）；unknown：别的。
 * 都要求先看到锁在本浏览器、发出了请求，申请取得了编辑权、进入了编辑
 */
export function summarizeTaker(log: readonly LogEntry[]): TakerSummary {
  const start = firstOf(log, 'takeover-start')
  const after = start === undefined ? [] : log.filter(entry => entry.at >= start.at)
  const locate = firstOf(after, 'takeover-locate')
  const request = firstOf(after, 'handover-request')
  const reply = firstOf(after, 'handover-reply')
  const ack = firstOf(after, 'handover-reply', entry => entry.reply === 'ack')
  const done = firstOf(after, 'handover-reply', entry => entry.reply === 'done')
  const failedReply = firstOf(after, 'handover-reply', entry => entry.reply === 'failed')
  const lockFree = firstOf(after, 'handover-lock-free')
  const silent = firstOf(after, 'handover-silent')
  const acquires = after.filter(entry => entry.kind === 'acquire')
  const results = after.filter(entry => entry.kind === 'acquire-result')
  const entered = firstOf(after, 'entered')
  const finished = lockFree ?? done
  const path: TakerPath = silent !== undefined ? 'silent' : finished !== undefined ? 'answered' : failedReply !== undefined ? 'failed' : 'unknown'
  const problems: string[] = []
  if (start === undefined)
    problems.push('日志里没有"在此编辑"开始（takeover-start）')
  if (locate?.here !== true)
    problems.push(`锁不在本浏览器（takeover-locate 是 ${JSON.stringify(locate?.here) ?? '没有'}）：A 已经不在编辑了？`)
  if (request === undefined)
    problems.push('没有发出交接请求（handover-request）')
  const takeovers = acquires.map(entry => entry.takeover ?? null)
  if (path === 'silent' && takeovers[0] !== 'self')
    problems.push(`没有回应之后应当以本人接管申请，申请的接管方式是 ${takeovers.map(String).join('、') || '（没有申请）'}`)
  if (path === 'answered' && !(takeovers[0] === null && (takeovers.length === 1 || (takeovers.length === 2 && takeovers[1] === 'self' && results[0]?.result === 'held'))))
    problems.push(`A 做完之后应当普通申请（被自己占着时另以本人接管再申请一次），申请的接管方式是 ${takeovers.map(String).join('、') || '（没有申请）'}`)
  if (path === 'failed')
    problems.push(`A 回应没能交出（${String(failedReply?.detail)}）`)
  if (path === 'unknown')
    problems.push('既没有收到 A 做完的信号，也没有到时限')
  if (results.at(-1)?.result !== 'acquired')
    problems.push(`申请的结果是 ${String(results.at(-1)?.result ?? '没有')}（应当取得编辑权）`)
  if (entered === undefined)
    problems.push('没有进入编辑（entered）')
  const ms = {
    request: since(request, start),
    reply: since(reply, request),
    finished: since(finished, request),
    silent: since(silent, request),
    acquire: since(acquires[0], start),
    entered: since(entered, start),
  }
  const replyText = path === 'silent'
    ? `${ms.silent ?? '—'} ms 没有回应（${ack === undefined ? '一直没有回应' : `+${since(ack, request)} ms 回应过 ack、没做完`}）、以本人接管申请`
    : `+${ms.reply ?? '—'} ms 收到回应（${String(reply?.reply ?? '—')}）、+${ms.finished ?? '—'} ms ${lockFree !== undefined ? '锁空了' : '收到 done'}、普通申请`
  return { path, ms, problems, text: `点"在此编辑"之后 +${ms.request ?? '—'} ms 发出交接请求，${replyText}，+${ms.entered ?? '—'} ms 进入编辑` }
}

/** A 这一侧的判读：回应了没有（handover-answer）、锁有没有被抢（lock-stolen）、离开编辑的结果 */
export interface HolderSummary {
  readonly answered: boolean
  readonly stolen: boolean
  readonly left: string | undefined
  readonly text: string
}

/** A 的交接日志判读（hiddenWall 是 A 变成隐藏的墙上时间：各步写成相对它的秒数） */
export function summarizeHolder(log: readonly LogEntry[], hiddenWall: number | undefined): HolderSummary {
  const answer = firstOf(log, 'handover-answer')
  const stolen = firstOf(log, 'lock-stolen')
  const left = firstOf(log, 'left')
  const finish = firstOf(log, 'handover-finish')
  const relative = (entry: LogEntry | undefined): string => entry === undefined ? '—' : hiddenWall === undefined ? `${entry.wall}` : `+${((entry.wall - hiddenWall) / 1000).toFixed(1)} 秒`
  const parts = [
    answer === undefined ? '没有回应交接请求' : `隐藏之后 ${relative(answer)} 回应 ${String(answer.answer)}（${String(answer.state)}）`,
    ...(finish === undefined ? [] : [`${relative(finish)} 告诉 B ${String(finish.outcome)}`]),
    ...(left === undefined ? [] : [`${relative(left)} 离开编辑（${String(left.cause)}，${String(left.outcome)}）`]),
    ...(stolen === undefined ? [] : [`${relative(stolen)} 得知锁被抢`]),
  ]
  return { answered: answer !== undefined, stolen: stolen !== undefined, left: left === undefined ? undefined : String(left.outcome), text: parts.join('，') }
}

// ---- takeover-holder（A） ----

async function takeoverHolderScenario(session: Session): Promise<void> {
  const observations: SelftestTimelineEntry[] = []
  const visibility = watchVisibility(observations)
  try {
    await holderSteps(session, visibility, observations)
  }
  finally {
    visibility.dispose()
    session.timeline = timelineWith(observations)
  }
}

async function holderSteps(session: Session, visibility: VisibilityWatch, observations: SelftestTimelineEntry[]): Promise<void> {
  if (!await checkEditing(session, { mode: 'held', limits: { captureQuietMs: NO_TIMED_CAPTURE_MS, captureMaxMs: NO_TIMED_CAPTURE_MS } }))
    return
  const control = autosaveControl()
  const [first, second, third] = TAKEOVER_EDITS
  const sheet = facade(session).getActiveWorkbook().getActiveSheet()
  const saved = await check(session, 'takeover.holder.first-save', async () => {
    if (sheet.getSheetId() !== first.sheetId)
      fail(`当前工作表是 ${sheet.getSheetId()}（应当是模板的 ${first.sheetId}）`)
    sheet.getRange(first.cell).setValue(first.value)
    const firstSeq = session.probe.changeSeq()
    // 控制的 flush：同步捕获第一格、发起上传；随即写第二格——它不在这一次里，留到隐藏的那一刻（与 hidden-save 相同）
    const started = performance.now()
    const flushing = control.flush()
    sheet.getRange(second.cell).setValue(second.value)
    const result = await flushing
    if (result?.outcome?.kind !== 'saved')
      fail(`控制的 flush 没有存上：${JSON.stringify(result) ?? '没有当前的调度'}；${describeAutosave(session)}`)
    const request = requestOf(result.outcome.requestId)
    if (request?.status !== 200 || request.localSeq !== String(firstSeq))
      fail(`第一格的保存请求：状态 ${String(request?.status)}、修改序号 ${String(request?.localSeq)}（应当是 200、${firstSeq}）`)
    if (session.host.view().save !== 'dirty')
      fail(`第一格存上之后保存状态是 ${session.host.view().save ?? '没有'}（应当是 dirty：第二格还没上传）`)
    observations.push(observation('first-saved'))
    return `第一格（${first.cell}）经控制的 flush 存上（${round(performance.now() - started)} ms），第二格（${second.cell}）留着；之后等驱动脚本另开 B（A 随之隐藏）`
  })
  if (!saved)
    return
  const uploaded = await check(session, 'takeover.holder.hidden-upload', async () => {
    if (!await waitFor(() => visibility.hiddenAt() !== undefined, HIDDEN_WAIT_MS, 100))
      fail(`${HIDDEN_WAIT_MS / 1000} 秒内页面没有变成隐藏（驱动脚本没有另开 B？）`)
    const hiddenAt = visibility.hiddenAt() ?? 0
    const seq = session.probe.changeSeq()
    const { upload, request } = await untilUploaded(session, seq, { timeoutMs: SAVE_WAIT_MS })
    const capture = capturesIn(control.log()).find(item => item.trigger === 'hidden')
    if (capture?.seq !== seq || upload.trigger !== 'hidden')
      fail(`隐藏的那一刻自动保存没有捕获、上传第二格（捕获 ${capture === undefined ? '没有' : triggerText(capture.trigger)}，上传 ${triggerText(upload.trigger)}）：${describeAutosave(session)}`)
    if (request?.status !== 200 || request.answeredAt === undefined)
      fail(`隐藏之后的保存请求：状态 ${String(request?.status)}`)
    const ms = { capture: round(capture.at - hiddenAt), request: round(request.at - hiddenAt), response: round(request.answeredAt - hiddenAt) }
    session.timings.push({ id: 'takeover.hidden-upload', ms })
    return `隐藏之后 +${ms.capture} ms 自动保存捕获第二格（切到后台）、+${ms.request} ms 发出保存请求、+${ms.response} ms 收到 200`
  }, HIDDEN_WAIT_MS + SAVE_WAIT_MS + CHECK_TIMEOUT_MS)
  if (!uploaded)
    return
  const wrote = await check(session, 'takeover.holder.after-hidden-edit', async () => {
    // 隐藏之后再写一格：模拟切走之前最后一刻没被捕获的修改（真实的用户在隐藏的页面里不会键入）。捕获的静默与上限是一小时、定时的上传暂停：
    // 它只在 A 回应交接（先保存再交出）时存上
    sheet.getRange(third.cell).setValue(third.value)
    if (session.host.view().save !== 'dirty')
      fail(`写了第三格，保存状态是 ${session.host.view().save ?? '没有'}（应当是 dirty）`)
    observations.push(observation('after-hidden-edit'))
    return `隐藏之后写下第三格（${third.cell}），留着没捕获、没上传；之后等 B 的"在此编辑"`
  })
  if (!wrote)
    return
  const hiddenWall = observations.find(entry => entry.kind === 'page:visibility-hidden')?.wall
  let outcome: 'handed-over' | 'lost' | undefined
  await check(session, 'takeover.holder.outcome', async () => {
    // 不等编辑器重建到 steady：A 在后台时 Safari 不给动画帧，只读的编辑器画不出来；页头的说明（React）照常更新
    const settled = (): boolean => {
      const { mode } = session.host.view()
      return mode === 'reading' || mode === 'lost'
    }
    if (!await waitFor(settled, HOLDER_OUTCOME_WAIT_MS, 100))
      fail(`${HOLDER_OUTCOME_WAIT_MS / 1000} 秒内没有交出、也没有失去编辑权（${describeView(session)}）`)
    observations.push(observation('outcome'))
    const view = session.host.view()
    const holder = summarizeHolder(handoverLog().log(), hiddenWall)
    if (view.mode === 'reading') {
      outcome = 'handed-over'
      session.path = outcome
      if (view.notice !== 'handed-over-tab')
        fail(`回到了阅读，说明是 ${view.notice ?? '没有'}（应当是交给了本浏览器的另一个标签页）；${holder.text}`)
      const said = statusRegionText(session)
      if (!said.includes('已在本浏览器的另一个标签页接着编辑'))
        fail(`读屏状态区说"${said}"（应当说已在本浏览器的另一个标签页接着编辑）`)
      if (!holder.answered || holder.left !== 'reading')
        fail(`回到阅读却没有回应交接请求、离开编辑：${holder.text}`)
      return `A 回应了 B：${holder.text}；读屏状态区说"${said}"`
    }
    outcome = 'lost'
    session.path = outcome
    const notice = lostNoticeText(session)
    if (view.loss !== 'taken-over:this-browser')
      fail(`失去编辑权的原因是 ${view.loss ?? '没有'}（应当是本浏览器的另一个标签页接手了：锁被抢）；说明"${notice}"；${holder.text}`)
    if (!notice.includes('你在本浏览器的另一个标签页接手了编辑') || !notice.includes('本页的修改没有保存：可以另存为副本'))
      fail(`失去编辑权的说明是"${notice}"（应当说本浏览器的另一个标签页接手了编辑、本页的修改没有保存、可以另存为副本）`)
    if (view.unsaved !== true || chromeButton(session, '另存为副本') === undefined)
      fail(`本页${view.unsaved === true ? '有' : '没有'}没保存的修改，${chromeButton(session, '另存为副本') === undefined ? '没有' : '有'}"另存为副本"（第三格没有存上：两样都应当有）`)
    return `A 失去编辑权：${holder.text}；说明"${notice}"`
  }, HOLDER_OUTCOME_WAIT_MS + CHECK_TIMEOUT_MS)
  if (outcome === 'handed-over') {
    await check(session, 'takeover.holder.server', async () => {
      const cells = cellsIn(await fetchServerContent(session.host.documentId), TAKEOVER_EDITS, [true, true, true])
      if (cells.wrong.length > 0)
        fail(`服务器上 ${cells.text}（A 先保存再交出：三格都应当在）`)
      return `服务器上 ${cells.text}（交出之前存上了第三格）`
    })
  }
  if (outcome === 'lost') {
    await check(session, 'takeover.holder.copy', async () => {
      const button = chromeButton(session, '另存为副本')
      if (button === undefined)
        fail('没有"另存为副本"')
      button.click()
      if (!await waitFor(() => session.host.view().copy === 'done' || session.host.view().copy === 'failed' || session.host.view().copy === 'refused', SWITCH_TIMEOUT_MS, 100))
        fail(`${SWITCH_TIMEOUT_MS / 1000} 秒内副本没有建好（${String(session.host.view().copy)}）`)
      const copyId = session.host.view().copyDocumentId
      if (session.host.view().copy !== 'done' || copyId === undefined)
        fail(`另存为副本没有成功（${String(session.host.view().copy)}）`)
      const copied = cellsIn(await fetchServerContent(copyId), TAKEOVER_EDITS, [true, true, true])
      const original = cellsIn(await fetchServerContent(session.host.documentId), TAKEOVER_EDITS, [true, true, false])
      if (copied.wrong.length > 0 || original.wrong.length > 0)
        fail(`副本里 ${copied.text}（三格都应当在），原文档里 ${original.text}（只有前两格）`)
      observations.push(observation('copied', { copyId }))
      return `另存为副本：副本里 ${copied.text}；原文档里 ${original.text}（第三格只在副本里）`
    }, SWITCH_TIMEOUT_MS + CHECK_TIMEOUT_MS)
  }
}

// ---- takeover-taker（B） ----

async function takeoverTakerScenario(session: Session): Promise<void> {
  const observations: SelftestTimelineEntry[] = []
  try {
    await takerSteps(session, observations)
  }
  finally {
    session.timeline = timelineWith(observations)
  }
}

/** 进入了编辑：编辑的 steady，容器上是可编辑的编辑器 */
function editingSteady(session: Session): boolean {
  const view = session.host.view()
  return view.mode === 'editing' && view.surface === 'steady' && session.host.surface.getAttribute('data-editor-access') === 'edit'
}

async function takerSteps(session: Session, observations: SelftestTimelineEntry[]): Promise<void> {
  const reading = await check(session, 'takeover.taker.reading', async () => {
    if (session.host.page.readOnly !== true)
      fail('页面没有按阅读打开')
    if (!await waitFor(() => session.host.view().selfHolder === 'this-browser', SIGNAL_TIMEOUT_MS * 2, 100))
      fail(`持有者不是本浏览器的另一个标签页（${describeView(session)}，selfHolder ${session.host.view().selfHolder ?? '没有'}）`)
    const said = statusTexts(session).find(text => text.includes('正在编辑这份文档')) ?? ''
    if (!said.includes('你在本浏览器的另一个标签页里正在编辑这份文档'))
      fail(`说明是"${said}"（应当说你在本浏览器的另一个标签页里正在编辑）`)
    if (chromeButton(session, TAKE_OVER_HERE) === undefined)
      fail(`页头没有"${TAKE_OVER_HERE}"`)
    return `阅读：说明"${said}"，页头有"${TAKE_OVER_HERE}"`
  })
  if (!reading)
    return
  const entered = await check(session, 'takeover.taker.take-over', async () => {
    // 从页面开始载入算 8 秒（B 一打开，A 就隐藏了）
    const wait = TAKEOVER_TAKER_DELAY_MS - (Date.now() - Date.parse(session.host.startedAt))
    if (wait > 0)
      await sleep(wait)
    const button = chromeButton(session, TAKE_OVER_HERE)
    if (button === undefined)
      fail(`页头没有"${TAKE_OVER_HERE}"`)
    const previous = session.probe
    observations.push(observation('click', { sinceStart: Date.now() - Date.parse(session.host.startedAt) }))
    button.click()
    const gaveUp = (): boolean => {
      const view = session.host.view()
      return view.mode === 'reading' && (view.takeover === 'failed' || (view.takeover === undefined && view.notice !== undefined))
    }
    if (!await waitFor(() => editingSteady(session) || gaveUp(), TAKER_ENTER_WAIT_MS, 50))
      fail(`${TAKER_ENTER_WAIT_MS / 1000} 秒内没有进入编辑（${describeView(session)}）`)
    if (gaveUp())
      fail(`没有进入编辑（${describeView(session)}，进展 ${session.host.view().takeover ?? '没有'}，说明 ${session.host.view().notice ?? '没有'}）`)
    observations.push(observation('entered'))
    adoptEditor(session, previous)
    const summary = summarizeTaker(handoverLog().log())
    session.path = summary.path
    session.timings.push({ id: 'takeover.taker', ms: summary.ms })
    if (summary.problems.length > 0)
      fail(`${summary.problems.join('；')}（${summary.text}）`)
    return summary.text
  }, TAKEOVER_TAKER_DELAY_MS + TAKER_ENTER_WAIT_MS + CHECK_TIMEOUT_MS)
  if (!entered)
    return
  await check(session, 'takeover.taker.server', async () => {
    // A 的修改：第一格（控制的 flush）、第二格（切到后台立即上传）一定在服务器上；第三格只在 A 回应了、先保存再交出时在
    const handedOver = session.path === 'answered'
    const stored = await fetchServerContent(session.host.documentId)
    const cells = cellsIn(stored, TAKEOVER_EDITS, [true, true, handedOver])
    if (cells.wrong.length > 0)
      fail(`服务器上 ${cells.text}（${handedOver ? 'A 先保存再交出：三格都应当在' : 'A 没有回应：前两格在（P4 的切到后台立即上传），第三格不在'}）`)
    const shown = cellsIn(session.probe.snapshot(), TAKEOVER_EDITS, [true, true, handedOver])
    if (shown.wrong.length > 0)
      fail(`进入编辑之后编辑器里 ${shown.text}（应当与服务器上的相同）`)
    return `服务器上与进入编辑之后的编辑器里都是 ${cells.text}`
  })
}

// ---- refresh-save ----

/** 第一次载入交给刷新之后那一次的：检查的结果、计时、时间线与停在服务端的那次保存的基准修订号（发出之前读到） */
interface RefreshCarry {
  readonly documentId: string
  readonly checks: SelftestCheck[]
  readonly timings: SelftestTiming[]
  readonly timeline: SelftestTimelineEntry[]
  baseRevision: number
}

function readCarry(documentId: string): RefreshCarry | undefined {
  try {
    const raw = sessionStorage.getItem(REFRESH_CARRY_KEY)
    const carry = raw === null ? undefined : JSON.parse(raw) as RefreshCarry
    return carry?.documentId === documentId ? carry : undefined
  }
  catch {
    return undefined
  }
}

function writeCarry(carry: RefreshCarry): void {
  try {
    sessionStorage.setItem(REFRESH_CARRY_KEY, JSON.stringify(carry))
  }
  catch {
    // 写不进去：刷新之后的那次载入当作第一次（结果里看得出）
  }
}

function clearCarry(): void {
  try {
    sessionStorage.removeItem(REFRESH_CARRY_KEY)
  }
  catch {
    // 同上
  }
}

async function refreshSaveScenario(session: Session): Promise<void> {
  const carried = readCarry(session.host.documentId)
  if (carried === undefined)
    await refreshBeforeReload(session)
  else
    await refreshAfterReload(session, carried)
}

/**
 * 离开时看到了什么，每一条随即（同步）写进 sessionStorage：保存的请求的结果（WebKit 在导航一开始就取消它）、释放与交出的请求（不该有）、
 * pagehide 时保存的状态（在 window 的捕获阶段听：先于编辑器页的处理）、编辑器页处理之后 localStorage 里的记号（之后挂上的冒泡阶段：
 * 排在编辑器页的那一个后面）、变成隐藏。包一层 fetch（在发出保存之前装上，那一次也经过它）
 */
function watchLeaving(session: Session, carry: RefreshCarry): void {
  const note = (entry: SelftestTimelineEntry): void => {
    carry.timeline.push(entry)
    writeCarry(carry)
  }
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const path = new URL(request?.url ?? String(input), location.href).pathname
    const leasePath = /\/edit-lease(?:\/handover)?$/.test(path)
    if (leasePath && (method === 'DELETE' || path.endsWith('/handover')))
      note(observation(method === 'DELETE' ? 'release-sent' : 'handover-sent', { method, path, keepalive: init?.keepalive === true }))
    const save = method === 'PUT' && path.endsWith('/content')
    try {
      const response = await originalFetch(input, init)
      if (save)
        note(observation('save-answered', { status: response.status }))
      return response
    }
    catch (error) {
      if (save)
        note(observation('save-failed', { error: describe(error) }))
      throw error
    }
  }
  window.addEventListener('pagehide', (event) => {
    const mark = saveRequests().at(-1)
    note(observation('pagehide', { persisted: event.persisted, save: session.host.view().save ?? null, request: mark?.status ?? 'pending' }))
  }, { capture: true })
  window.addEventListener('pagehide', () => {
    let marker: string | null = null
    try {
      marker = localStorage.getItem(pendingSaveKeyOf(session.host.documentId))
    }
    catch {
      // 读不了：当作没有
    }
    note(observation('after-pagehide', { marker }))
  })
  document.addEventListener('visibilitychange', () => note(observation(`visibility-${document.visibilityState}`)))
}

async function refreshBeforeReload(session: Session): Promise<void> {
  const carry: RefreshCarry = { documentId: session.host.documentId, checks: [], timings: [], timeline: [observation('first-load')], baseRevision: 0 }
  const entered = await check(session, 'refresh.enter', async () => {
    if (session.host.page.readOnly !== true)
      fail('页面没有按阅读打开')
    const button = chromeButton(session, '编辑')
    if (button === undefined)
      fail(`页头没有"编辑"（${describeView(session)}）`)
    const previous = session.probe
    button.click()
    await untilSwitched(session, 'editing', 'entering')
    adoptEditor(session, previous)
    return `进入编辑；${prepareAutosave({ mode: 'held', limits: { captureQuietMs: NO_TIMED_CAPTURE_MS, captureMaxMs: NO_TIMED_CAPTURE_MS } })}`
  }, SWITCH_TIMEOUT_MS + CHECK_TIMEOUT_MS)
  if (!entered)
    return
  const held = await check(session, 'refresh.save-held', async () => {
    const { revision } = await fetchServerDocument(session.host.documentId)
    carry.baseRevision = revision
    watchLeaving(session, carry)
    facade(session).getActiveWorkbook().getActiveSheet().getRange(REFRESH_SAVE_EDIT.cell).setValue(REFRESH_SAVE_EDIT.value)
    // 等这一处修改之后的那一轮公式结束：不然这一次捕获带"公式待更新"（P4-S7 复核 O1），服务器上随之记下标记
    if (!await waitFor(() => session.probe.formulasSettled(), SIGNAL_TIMEOUT_MS))
      fail('写下之后公式一直没有收齐')
    let settled: string | undefined
    void autosaveControl().flush().then(result => settled = JSON.stringify(result) ?? '没有当前的调度', error => settled = describe(error))
    carry.timeline.push(observation('save-sent'))
    await sleep(SAVE_HELD_CONFIRM_MS)
    if (settled !== undefined)
      fail(`保存没有停在服务端：${SAVE_HELD_CONFIRM_MS} ms 内有了结果（${settled}）——驱动脚本没有让这份文档的保存在服务端停住？`)
    const request = saveRequests().at(-1)
    if (request === undefined || request.status !== undefined)
      fail(`没有在途的保存请求（${request === undefined ? '没有发出' : `状态 ${String(request.status)}`}）`)
    if (session.host.view().save !== 'saving')
      fail(`保存状态是 ${session.host.view().save ?? '没有'}（应当是 saving）`)
    return `写下 ${REFRESH_SAVE_EDIT.cell}，经控制的 flush 发出保存（基准修订号 ${revision}）；${SAVE_HELD_CONFIRM_MS} ms 之后它还在途（保存状态 saving）：停在服务端`
  })
  if (!held)
    return
  await check(session, 'refresh.reload', async () => {
    // 交给刷新之后的那一次：到这里的检查与计时（这一项记为通过：真的刷新了，之后的那一次才看得到；没有刷新时这一项照常超时、交回结果）
    carry.checks.push(...session.checks, { id: 'refresh.reload', pass: true, detail: '保存在途时刷新页面（location.reload）', ms: 0 })
    carry.timings.push(...session.timings)
    carry.timeline.push(observation('reload'))
    writeCarry(carry)
    session.host.allowLeave()
    window.location.reload()
    await new Promise(() => {})
    return '没有刷新'
  })
  clearCarry()
}

/** 刷新之后的那一次：交回第一次的结果与离开时的观察，再看阅读的样子、记号与"在此编辑" */
async function refreshAfterReload(session: Session, carry: RefreshCarry): Promise<void> {
  clearCarry()
  session.checks.push(...carry.checks)
  session.timings.push(...carry.timings)
  const observations: SelftestTimelineEntry[] = [...carry.timeline, observation('second-load')]
  try {
    await refreshSteps(session, carry, observations)
  }
  finally {
    session.timeline = timelineWith(observations)
  }
}

/** 离开时的观察判读成一句话：保存的请求与 pagehide 的先后、pagehide 时保存的状态、记号与释放 */
export function leavingSummary(timeline: readonly SelftestTimelineEntry[]): { readonly problems: readonly string[], readonly text: string } {
  const at = (kind: string): SelftestTimelineEntry | undefined => timeline.find(entry => entry.kind === `page:${kind}`)
  const reload = at('reload')
  const failed = at('save-failed')
  const answered = at('save-answered')
  const hide = at('pagehide')
  const after = at('after-pagehide')
  const sent = timeline.filter(entry => entry.kind === 'page:release-sent' || entry.kind === 'page:handover-sent')
  const problems: string[] = []
  if (hide === undefined)
    problems.push('没有记下页面关闭（pagehide）')
  if (sent.length > 0)
    problems.push(`页面关闭时发了 ${sent.map(entry => `${String(entry.method)} ${String(entry.path)}`).join('、')}（保存在途或者结果未知时不应释放、交出）`)
  if (typeof after?.marker !== 'string' || after.marker === '')
    problems.push('编辑器页处理 pagehide 之后 localStorage 里没有记号')
  const relative = (entry: SelftestTimelineEntry | undefined): string => entry === undefined || reload === undefined ? '—' : `+${entry.wall - reload.wall} ms`
  const order = failed !== undefined && hide !== undefined && failed.wall <= hide.wall
    ? `保存的请求先失败（刷新之后 ${relative(failed)}，${String(failed.error)}），之后才派发 pagehide（${relative(hide)}，保存的状态 ${String(hide.save)}）——导航一开始就取消了在途的请求`
    : hide === undefined
      ? '没有 pagehide'
      : `pagehide 时（刷新之后 ${relative(hide)}）保存还在途（保存的状态 ${String(hide.save)}，请求 ${String(hide.request)}）${failed === undefined ? '' : `，之后请求失败（${relative(failed)}）`}`
  const text = `${order}；${answered === undefined ? '' : `保存的请求有了回应（${String(answered.status)}）；`}编辑器页处理之后 localStorage 里${typeof after?.marker === 'string' ? `有记号 ${after.marker}` : '没有记号'}；${sent.length === 0 ? '没有发释放与交出' : `发了 ${sent.length} 个释放或交出`}`
  return { problems, text }
}

async function refreshSteps(session: Session, carry: RefreshCarry, observations: SelftestTimelineEntry[]): Promise<void> {
  await check(session, 'refresh.pagehide', async () => {
    const summary = leavingSummary(carry.timeline)
    if (summary.problems.length > 0)
      fail(`${summary.problems.join('；')}（${summary.text}）`)
    return summary.text
  })
  const reading = await check(session, 'refresh.reading', async () => {
    if (session.host.page.readOnly !== true)
      fail('刷新之后页面没有按阅读打开')
    if (!await waitFor(() => session.host.view().selfHolder === 'elsewhere', SIGNAL_TIMEOUT_MS * 2, 100))
      fail(`持有者不是"别处"（${describeView(session)}，selfHolder ${session.host.view().selfHolder ?? '没有'}）：刷新之前那一代被释放了？`)
    const said = statusTexts(session).find(text => text.includes('正在编辑这份文档')) ?? ''
    if (!said.includes('你在另一台设备或浏览器上正在编辑这份文档（也可能是刚关闭、刷新过的页面）'))
      fail(`说明是"${said}"（应当说另一台设备或浏览器，也可能是刚关闭、刷新过的页面）`)
    if (chromeButton(session, TAKE_OVER_HERE) === undefined)
      fail(`页头没有"${TAKE_OVER_HERE}"`)
    return `阅读：说明"${said}"，页头有"${TAKE_OVER_HERE}"（刷新之前那一代还在、本机锁随页面放开了）`
  })
  if (!reading)
    return
  let markerAt: number | undefined
  await check(session, 'refresh.marker', async () => {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(pendingSaveKeyOf(session.host.documentId))
    }
    catch (error) {
      fail(`读不了 localStorage：${describe(error)}`)
    }
    if (raw === null)
      fail('localStorage 里没有记号')
    const marker = JSON.parse(raw) as { readonly v?: unknown, readonly at?: unknown, readonly revision?: unknown }
    if (marker.v !== 1 || typeof marker.at !== 'number' || marker.revision !== carry.baseRevision)
      fail(`记号是 ${raw}（应当是版本 1、带时刻、基准修订号 ${carry.baseRevision}）`)
    markerAt = marker.at
    const age = Date.now() - marker.at
    return `记号 ${raw}：${round(age)} ms 之前记下，基准修订号 ${carry.baseRevision}`
  })
  let clickWall = 0
  const tookOver = await check(session, 'refresh.take-over', async () => {
    const button = chromeButton(session, TAKE_OVER_HERE)
    if (button === undefined)
      fail(`页头没有"${TAKE_OVER_HERE}"`)
    const previous = session.probe
    let waitingSeen: number | undefined
    let waitingSaid = ''
    const look = (): boolean => {
      const view = session.host.view()
      if (view.takeover === 'waiting-save' && waitingSeen === undefined) {
        waitingSeen = Date.now()
        waitingSaid = statusRegionText(session)
        observations.push(observation('waiting-save', { said: waitingSaid }))
      }
      return editingSteady(session) || (view.mode === 'reading' && view.takeover === undefined && view.notice !== undefined)
    }
    clickWall = Date.now()
    observations.push(observation('click'))
    button.click()
    if (!await waitFor(look, REFRESH_ENTER_WAIT_MS, 50))
      fail(`${REFRESH_ENTER_WAIT_MS / 1000} 秒内没有进入编辑（${describeView(session)}，进展 ${session.host.view().takeover ?? '没有'}）`)
    if (!editingSteady(session))
      fail(`没有进入编辑（${describeView(session)}，说明 ${session.host.view().notice ?? '没有'}）`)
    observations.push(observation('entered'))
    adoptEditor(session, previous)
    if (waitingSeen === undefined)
      fail('"在此编辑"没有先等上一个页面的保存（进展里没有 waiting-save）')
    if (!waitingSaid.includes('上一个页面的保存还在进行，稍后接手'))
      fail(`等的时候读屏状态区说"${waitingSaid}"（应当说上一个页面的保存还在进行，稍后接手…）`)
    const log = handoverLog().log().filter(entry => entry.wall >= clickWall)
    const locate = firstOf(log, 'takeover-locate')
    const acquire = firstOf(log, 'acquire')
    const result = firstOf(log, 'acquire-result')
    const entered = firstOf(log, 'entered')
    if (locate?.here !== false || acquire?.takeover !== 'self' || result?.result !== 'acquired' || entered === undefined)
      fail(`交接日志不对：锁在本浏览器 ${JSON.stringify(locate?.here) ?? '没有'}、申请的接管方式 ${JSON.stringify(acquire?.takeover) ?? '没有申请'}、结果 ${String(result?.result ?? '没有')}、${entered === undefined ? '没有' : '有'}进入编辑（应当是锁不在本浏览器、以本人接管申请、取得、进入）`)
    // 等到了 30 秒（从记号的时刻算）才申请就是 expired；之前申请的是读到了修订号前进（那次保存提交了）
    const waited = acquire.wall - waitingSeen
    session.path = markerAt !== undefined && acquire.wall >= markerAt + PENDING_SAVE_WAIT_MS - PENDING_SAVE_POLL_MS / 2 ? 'expired' : 'committed'
    const ms = { waitingSave: waitingSeen - clickWall, waited, acquire: acquire.wall - clickWall, entered: entered.wall - clickWall }
    session.timings.push({ id: 'refresh.take-over', ms })
    return `点"${TAKE_OVER_HERE}"之后 +${ms.waitingSave} ms 开始等（"${waitingSaid}"），等了 ${waited} ms（${session.path === 'committed' ? '那次保存提交了' : '等满了 30 秒'}）以本人接管申请，+${ms.entered} ms 进入编辑`
  }, REFRESH_ENTER_WAIT_MS + CHECK_TIMEOUT_MS)
  if (!tookOver)
    return
  await check(session, 'refresh.server', async () => {
    const { revision } = await fetchServerDocument(session.host.documentId)
    const stored = cellOf(await fetchServerContent(session.host.documentId), REFRESH_SAVE_EDIT)
    const shown = cellOf(session.probe.snapshot(), REFRESH_SAVE_EDIT)
    if (session.path === 'committed' && (revision !== carry.baseRevision + 1 || stored !== REFRESH_SAVE_EDIT.value || shown !== REFRESH_SAVE_EDIT.value))
      fail(`服务器上修订号 ${revision}、${REFRESH_SAVE_EDIT.cell} 是 ${JSON.stringify(stored) ?? '空'}，编辑器里是 ${JSON.stringify(shown) ?? '空'}（那次保存提交了：应当是修订号 ${carry.baseRevision + 1}、两边都是写下的值）`)
    let marker: string | null = null
    try {
      marker = localStorage.getItem(pendingSaveKeyOf(session.host.documentId))
    }
    catch {
      // 读不了：当作没有
    }
    if (marker !== null)
      fail(`接手之后记号还在：${marker}`)
    return `服务器上修订号 ${revision}、${REFRESH_SAVE_EDIT.cell} 是 ${JSON.stringify(stored) ?? '空'}，进入编辑之后的编辑器里是 ${JSON.stringify(shown) ?? '空'}；接手之后记号清掉了`
  })
}

/** 交接的各场景（场景名在 ./selftest-report.ts 的 HANDOVER_SCENARIOS） */
export const HANDOVER_SCENARIO_RUNNERS = {
  'takeover-holder': takeoverHolderScenario,
  'takeover-taker': takeoverTakerScenario,
  'refresh-save': refreshSaveScenario,
} as const satisfies Readonly<Record<string, (session: Session) => Promise<void>>>

/** 这些场景要求页面在中途变成隐藏：A 被另开的 B 遮住 */
export const HANDOVER_EXPECTS_HIDDEN: ReadonlySet<string> = new Set(['takeover-holder'])
