// 请求编辑的两条路的页面自检（M3-P6 设计 §3.10，DEF-062）：被复核的一方是这一页（真实 Safari 里），另一方（另一个账户）由驱动脚本经接口扮演——
// 两条路要复核的都是 Safari 里那一方的行为，另一方的界面已由 Playwright 三个浏览器覆盖（编排与判定在 tests/e2e/support/selftest-request.ts，
// 真实 Safari 的驱动脚本与 Playwright 的校准共用）。各步的先后看测试构建的交接日志（请求方的发出、续期、交给了我、开始进入，申请与结果，进入编辑，
// 离开编辑）、编辑器页的状态每一次变化（host.subscribe，同步记下：页面在后台时 Safari 压低、停下计时器，轮询看不准）与这里自己的观察（可见性、
// 计时器的停顿），随结果交回（timeline，墙上时间）：
// - request-waiter（路 1，请求方：作者，阅读时开始）：另一方已在编辑——页头有"请求编辑"、说明另一个人在编辑；点"请求编辑"→ 在等（读屏状态区说
//   在等谁、按钮换成"取消请求"）。驱动脚本从另一方的心跳里看到请求之后另开标签页让这一页隐藏（同一个窗口里被遮住的标签页只降频、不暂停，P5 F1），
//   经接口交出——这一页在后台的续期得知交给了它（reserved），停在"交给了我"（granted，回到这一页时进入）、不再续期、不申请；驱动脚本等它停够了
//   （库里没有新的一代、后端日志里没有它的申请）再让遮住它的标签页关掉自己——回到前台之后才进入编辑（普通申请，trigger 是 granted）；之后写一格、
//   经控制的 flush 存上（编辑权确实交给了它）。判读：summarizeWaiter；
// - paused-holder（路 2，持有者：作者，编辑时）：前半段与 takeover-holder 相同（./selftest-holder.ts：第一格存上，驱动脚本看到这一版才盖屏；隐藏的那一刻
//   上传第二格；之后写第三格，只在这一页）。驱动脚本以另一方的身份经接口请求编辑、续期；真实 Safari 约 50 秒之后暂停整页（计时器、请求都停，探索 B
//   实测）——心跳停了，空闲满 2 分钟的自动交出也走不到；编辑权按时间到期之后另一方申请成功，驱动脚本移走盖屏：这一页回来，积压的计时器一起触发，
//   得知失去编辑权（另一方在编辑：held:other），第三格另存为副本（副本里三格，原文档里只有前两格）。判读：summarizePausedHolder。
//   Playwright 里页面不会被暂停：校准用模拟的隐藏、拦住这一页的心跳与交出代替（判读相同，计时器的停顿只在真实 Safari 里有）。
import type { RequestScenario, SelftestTimelineEntry } from './selftest-report.ts'
import type { Session } from './selftest-session.ts'
import type { VisibilityWatch } from './selftest-timeline.ts'
import { autosaveControl, prepareAutosave, requestOf } from './selftest-autosave.ts'
import { facade, round } from './selftest-capture-common.ts'
import { waitFor } from './selftest-dom.ts'
import { holderPrelude } from './selftest-holder.ts'
import { PAUSED_HOLDER_EDITS, REQUEST_WAITER_EDIT } from './selftest-report.ts'
import { adoptEditor, check, CHECK_TIMEOUT_MS, chromeButton, describeView, fail, fetchServerContent, SIGNAL_TIMEOUT_MS, SWITCH_TIMEOUT_MS } from './selftest-session.ts'
import { cellOf, cellsIn, editingSteady, lostNoticeText, observation, statusRegionText, statusTexts, timelineWith, watchVisibility } from './selftest-timeline.ts'

/** 页头的按钮（与编辑器页的文案相同；这里不引用编辑器页的模块） */
const REQUEST_EDIT = '请求编辑'
const CANCEL_REQUEST = '取消请求'
const SAVE_AS_COPY = '另存为副本'

/** request-waiter：点了"请求编辑"之后等驱动脚本让这一页隐藏最多多久（它从另一方的心跳里看到请求，2 秒一次） */
const WAITER_HIDDEN_WAIT_MS = 120_000

/** request-waiter：隐藏之后等回到前台最多多久（另一方交出、这一页在后台续期得知、停够了才让它回来；Safari 压低后台标签页的计时器） */
const WAITER_SHOWN_WAIT_MS = 240_000

/** request-waiter：回到前台之后等进入编辑（申请、以可编辑重建、到 steady）最多多久 */
const WAITER_ENTER_WAIT_MS = 60_000

/**
 * paused-holder：写下第三格之后等失去编辑权最多多久：盖屏（Safari 约 50 秒后暂停，编辑权在最后一次续租之后 90 秒到期，另一方随即接手）、移走盖屏、
 * 回来之后的心跳与续上——盖屏期间这一页的计时器停着，回来之后接着等
 */
const HOLDER_LOST_WAIT_MS = 420_000

/**
 * 这两个场景的检查一共最多用多久（selftest-session.ts 的 SCENARIO_BUDGET_MS 是 180 秒，不够：路 2 光是盖屏就约 3 分钟）。
 * 页面被暂停时 performance.now() 照样往前走（单调的真实时间），所以按它算的时限把暂停的时间也算在内
 */
export const REQUEST_SCENARIO_BUDGET_MS = 600_000

/** 计时器的停顿记进时间线的门槛：每秒一次的计时器，两次之间超过它才记（Safari 隐藏之后压低到 1–13 秒，暂停时一停就是几十秒） */
const TICK_GAP_NOTE_MS = 3_000

/** 停顿最多记多少条（结果放在地址里） */
const TICK_GAP_LIMIT = 100

// ---- 观察：状态的每一次变化、计时器的停顿 ----

/** 编辑器页的状态每变一次记一条（page:state）：只记交接相关的几项，与上一条相同的不记 */
function watchStates(session: Session, observations: SelftestTimelineEntry[]): () => void {
  let last = ''
  const record = (): void => {
    const { mode, request, requestUntil, incoming, leaving, loss } = session.host.view()
    const fields = { mode, request, requestUntil, incoming, leaving, loss }
    const signature = JSON.stringify(fields)
    if (signature === last)
      return
    last = signature
    observations.push(observation('state', Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))))
  }
  record()
  return session.host.subscribe(record)
}

/** 计时器的停顿：每秒一次的计时器，两次之间隔得久就记一条 page:tick-gap（gapMs，墙上时间是停顿结束的那一刻） */
interface TickWatch {
  readonly dispose: () => void
}

function watchTicks(observations: SelftestTimelineEntry[]): TickWatch {
  let last = Date.now()
  let noted = 0
  const timer = setInterval(() => {
    const now = Date.now()
    const gap = now - last
    last = now
    if (gap >= TICK_GAP_NOTE_MS && noted < TICK_GAP_LIMIT) {
      noted += 1
      observations.push(observation('tick-gap', { gapMs: gap }))
    }
  }, 1_000)
  return { dispose: () => clearInterval(timer) }
}

// ---- 判读（纯函数，单元测试覆盖） ----

function first(timeline: readonly SelftestTimelineEntry[], kind: string, where: (entry: SelftestTimelineEntry) => boolean = () => true): SelftestTimelineEntry | undefined {
  return timeline.find(entry => entry.kind === kind && where(entry))
}

/** 墙上时间之差（毫秒）；缺一个时 null */
function between(from: SelftestTimelineEntry | undefined, to: SelftestTimelineEntry | undefined): number | null {
  return from === undefined || to === undefined ? null : to.wall - from.wall
}

function seconds(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)} 秒`
}

/**
 * 请求方这一侧走了哪条路：entered-on-return 是设计的那一条（在后台停在交给了我、不申请，回到前台之后才进入编辑）；
 * not-granted（没有等到交给了我）、granted-while-visible（交给了我的时候页面看得见：驱动脚本没让它隐藏）、entered-while-hidden（看得见之前就申请了：
 * 在后台抢到的编辑权会因 Safari 暂停而到期）、not-shown（一直没回到前台）、not-entered（回到前台之后没有进入编辑）
 */
export type WaiterPath = 'entered-on-return' | 'not-granted' | 'granted-while-visible' | 'entered-while-hidden' | 'not-shown' | 'not-entered'

export interface WaiterSummary {
  readonly path: WaiterPath
  /** 各段的毫秒数（墙上时间；没有那一步时 null） */
  readonly ms: Readonly<Record<string, number | null>>
  /** 不合预期的地方（空的就是按设计走完了） */
  readonly problems: readonly string[]
  readonly text: string
}

/**
 * 请求方的时间线（交接日志与场景的观察）判读成一条路（M3-P5 设计 §3.6：reserved、free 时只在页面看得见时进入，后台时停在 granted、回到前台再进）：
 * 发出时在等（pending）；隐藏之后某一次续期得到 reserved（另一方交出之后的保留）、随即 granted 而页面看不见；之后不再续期，看得见之前没有申请；
 * 回到前台之后开始进入（request-enter）、以普通申请（trigger granted，不带接管方式）取得、进入编辑
 */
export function summarizeWaiter(timeline: readonly SelftestTimelineEntry[]): WaiterSummary {
  const sent = first(timeline, 'request-sent')
  const origin = sent?.wall ?? Number.NEGATIVE_INFINITY
  const hidden = first(timeline, 'page:visibility-hidden', entry => entry.wall >= origin)
  const shown = hidden === undefined ? undefined : first(timeline, 'page:visibility-visible', entry => entry.wall >= hidden.wall)
  const granted = first(timeline, 'request-granted', entry => entry.wall >= origin)
  const granting = granted === undefined ? undefined : timeline.filter(entry => entry.kind === 'request-renewed' && entry.wall <= granted.wall).at(-1)
  const renewedWhileGranted = granted === undefined ? [] : timeline.filter(entry => entry.kind === 'request-renewed' && entry.wall > granted.wall && (shown === undefined || entry.wall < shown.wall))
  const acquire = first(timeline, 'acquire', entry => entry.wall >= origin)
  const result = acquire === undefined ? undefined : first(timeline, 'acquire-result', entry => entry.wall >= acquire.wall)
  const entered = acquire === undefined ? undefined : first(timeline, 'entered', entry => entry.wall >= acquire.wall)
  const enter = first(timeline, 'request-enter', entry => entry.wall >= origin)
  let path: WaiterPath
  if (granted === undefined)
    path = 'not-granted'
  else if (hidden === undefined || granted.wall < hidden.wall || granted.visible !== false)
    path = 'granted-while-visible'
  else if (acquire !== undefined && (shown === undefined || acquire.wall < shown.wall))
    path = 'entered-while-hidden'
  else if (shown === undefined)
    path = 'not-shown'
  else if (acquire === undefined || result?.result !== 'acquired' || entered === undefined)
    path = 'not-entered'
  else
    path = 'entered-on-return'
  const problems: string[] = []
  if (sent?.outcome !== 'pending')
    problems.push(`发出请求的结果是 ${String(sent?.outcome ?? '没有发出')}（应当在等 pending：另一方正在编辑）`)
  const why: Readonly<Record<Exclude<WaiterPath, 'entered-on-return'>, string>> = {
    'not-granted': '一直没有得知编辑权交给了这一页（没有 request-granted）',
    'granted-while-visible': '得知交给了这一页的时候页面看得见（驱动脚本没让它隐藏，或者隐藏得太晚）',
    'entered-while-hidden': '页面看不见的时候就申请了编辑权（应当停在交给了我、回到前台再进）',
    'not-shown': '页面一直没有回到前台',
    'not-entered': `回到前台之后没有进入编辑（申请 ${acquire === undefined ? '没有发出' : `结果 ${String(result?.result ?? '没有')}`}，${entered === undefined ? '没有' : '有'}进入编辑）`,
  }
  if (path !== 'entered-on-return')
    problems.push(why[path])
  if (granting !== undefined && granting.outcome !== 'reserved')
    problems.push(`得知交给了这一页的那次续期的结果是 ${String(granting.outcome)}（应当是 reserved：另一方交出之后编辑权留给这一页）`)
  if (renewedWhileGranted.length > 0)
    problems.push(`停在交给了我之后又续期了 ${renewedWhileGranted.length} 次（granted 时不再续期）`)
  if (acquire !== undefined && (acquire.trigger !== 'granted' || acquire.takeover !== null))
    problems.push(`申请的来由是 ${String(acquire.trigger)}、接管方式是 ${String(acquire.takeover)}（应当是请求被批准之后的普通申请：granted、null）`)
  if (path === 'entered-on-return' && (enter === undefined || shown === undefined || enter.wall < shown.wall))
    problems.push('回到前台之后没有记下开始进入（request-enter）')
  const ms = {
    sentToHidden: between(sent, hidden),
    hiddenToGranted: between(hidden, granted),
    held: between(granted, shown),
    shownToAcquire: between(shown, acquire),
    shownToEntered: between(shown, entered),
  }
  const text = [
    `发出请求（${String(sent?.outcome ?? '没有发出')}）`,
    `${seconds(ms.sentToHidden)}之后页面隐藏`,
    granted === undefined ? '一直没有得知交给了这一页' : `隐藏之后 ${seconds(ms.hiddenToGranted)}续期得到 ${String(granting?.outcome ?? '?')}、停在交给了我（页面${granted.visible === false ? '看不见' : '看得见'}）`,
    shown === undefined ? '一直没有回到前台' : `${seconds(ms.held)}之后回到前台（这期间续期 ${renewedWhileGranted.length} 次、${acquire !== undefined && acquire.wall < shown.wall ? '申请了' : '没有申请'}）`,
    acquire === undefined || shown === undefined ? '没有申请' : `回到前台之后 +${String(ms.shownToAcquire)} ms 申请（${String(acquire.trigger)}，接管方式 ${String(acquire.takeover)}，结果 ${String(result?.result ?? '没有')}）、+${String(ms.shownToEntered ?? '—')} ms 进入编辑`,
  ].join('，')
  return { path, ms, problems, text }
}

/**
 * 被暂停的持有者走了哪条路：lost-after-pause 是设计的那一条（隐藏、被暂停期间什么也没做，回到前台之后才得知失去编辑权）；
 * not-hidden（一直没有隐藏）、handed-over（交出了、回到阅读：这一页没有被暂停，空闲满 2 分钟的自动交出走到了）、not-shown（一直没回到前台）、
 * not-lost（回到前台之后没有失去编辑权）、lost-while-hidden（还在后台就得知失去编辑权：这一页没有被暂停）
 */
export type PausedHolderPath = 'lost-after-pause' | 'not-hidden' | 'handed-over' | 'not-shown' | 'not-lost' | 'lost-while-hidden'

export interface PausedHolderSummary {
  readonly path: PausedHolderPath
  readonly ms: Readonly<Record<string, number | null>>
  readonly problems: readonly string[]
  readonly text: string
}

/**
 * 持有者的时间线判读成一条路：隐藏之后（可能先由心跳带来请求、出现提示）被暂停；回到前台之后失去编辑权，原因是续上时别人在编辑（held:other——
 * 另一方已经接手）；从头到尾没有离开编辑回到阅读（没有交出）。另记：心跳带来请求的时刻（暂停之前带到了就有）、回来之后有没有开始自动交出
 * （空闲满 2 分钟的计时到点，积压的计时器一起触发：先保存再交出，保存被拒，随之失去编辑权）、隐藏期间计时器的最长停顿（真实 Safari 里就是暂停）
 */
export function summarizePausedHolder(timeline: readonly SelftestTimelineEntry[]): PausedHolderSummary {
  const hidden = first(timeline, 'page:visibility-hidden')
  const shown = hidden === undefined ? undefined : first(timeline, 'page:visibility-visible', entry => entry.wall >= hidden.wall)
  const states = timeline.filter(entry => entry.kind === 'page:state')
  const arrived = states.find(entry => entry.incoming !== undefined)
  const lost = states.find(entry => entry.mode === 'losing' || entry.mode === 'lost')
  const handedOver = first(timeline, 'left', entry => entry.outcome === 'reading')
  const lateLeave = shown === undefined ? undefined : first(timeline, 'leave', entry => entry.wall >= shown.wall)
  const gaps = hidden === undefined ? [] : timeline.filter(entry => entry.kind === 'page:tick-gap' && entry.wall >= hidden.wall && (shown === undefined || entry.wall <= shown.wall + 5_000))
  const longest = gaps.reduce<SelftestTimelineEntry | undefined>((best, entry) => (best === undefined || Number(entry.gapMs) > Number(best.gapMs) ? entry : best), undefined)
  let path: PausedHolderPath
  if (hidden === undefined)
    path = 'not-hidden'
  else if (handedOver !== undefined)
    path = 'handed-over'
  else if (lost === undefined)
    path = shown === undefined ? 'not-shown' : 'not-lost'
  else if (shown === undefined || lost.wall < shown.wall)
    path = 'lost-while-hidden'
  else
    path = 'lost-after-pause'
  const why: Readonly<Record<Exclude<PausedHolderPath, 'lost-after-pause'>, string>> = {
    'not-hidden': '页面一直没有隐藏（驱动脚本没有盖屏？）',
    'handed-over': `离开编辑回到了阅读（${String(handedOver?.cause ?? '?')}）：这一页没有被暂停，交出了`,
    'not-shown': '页面一直没有回到前台（驱动脚本没有移走盖屏？）',
    'not-lost': '回到前台之后没有失去编辑权',
    'lost-while-hidden': '还在后台就得知失去编辑权：这一页没有被暂停',
  }
  const problems: string[] = []
  if (path !== 'lost-after-pause')
    problems.push(why[path])
  if (lost !== undefined && lost.loss !== 'held:other')
    problems.push(`失去编辑权的原因是 ${String(lost.loss ?? '没有')}（应当是 held:other：续上时另一方已经接手、正在编辑）`)
  const ms = {
    hiddenToRequest: arrived === undefined ? null : between(hidden, arrived),
    longestGap: longest === undefined ? null : Number(longest.gapMs),
    hiddenToShown: between(hidden, shown),
    shownToLost: between(shown, lost),
  }
  const text = [
    hidden === undefined ? '一直没有隐藏' : '隐藏',
    arrived === undefined ? '隐藏期间心跳没有带来请求' : `隐藏之后 ${seconds(ms.hiddenToRequest)}心跳带来请求（出现提示）`,
    longest === undefined ? '计时器没有超过 3 秒的停顿' : `计时器最长停了 ${seconds(ms.longestGap)}（到隐藏之后 ${seconds(between(hidden, longest))}）`,
    shown === undefined ? '一直没有回到前台' : `隐藏之后 ${seconds(ms.hiddenToShown)}回到前台`,
    lateLeave === undefined ? '回来之后没有开始离开编辑' : `回来之后 +${String(between(shown, lateLeave))} ms 开始离开编辑（${String(lateLeave.cause)}）`,
    lost === undefined ? '没有失去编辑权' : `${lost.wall >= (shown?.wall ?? Number.POSITIVE_INFINITY) ? `回来之后 +${String(ms.shownToLost)} ms ` : '还在后台时'}失去编辑权（${String(lost.loss)}）`,
  ].join('，')
  return { path, ms, problems, text }
}

// ---- request-waiter（路 1） ----

async function requestWaiterScenario(session: Session): Promise<void> {
  const observations: SelftestTimelineEntry[] = []
  const visibility = watchVisibility(observations)
  const unsubscribe = watchStates(session, observations)
  const ticks = watchTicks(observations)
  try {
    await waiterSteps(session, visibility, observations)
  }
  finally {
    ticks.dispose()
    unsubscribe()
    visibility.dispose()
    session.timeline = timelineWith(observations)
  }
}

async function waiterSteps(session: Session, visibility: VisibilityWatch, observations: SelftestTimelineEntry[]): Promise<void> {
  const reading = await check(session, 'request.waiter.reading', async () => {
    if (session.host.page.readOnly !== true)
      fail('页面没有按阅读打开')
    if (!await waitFor(() => chromeButton(session, REQUEST_EDIT) !== undefined, SIGNAL_TIMEOUT_MS * 2, 100))
      fail(`页头没有"${REQUEST_EDIT}"（${describeView(session)}）：驱动脚本扮演的另一方没有在编辑？`)
    const said = statusTexts(session).find(text => text.includes('正在编辑这份文档')) ?? ''
    if (said === '' || said.startsWith('你'))
      fail(`说明是"${said}"（应当说另一个人正在编辑这份文档）`)
    return `阅读：说明"${said}"，页头有"${REQUEST_EDIT}"`
  })
  if (!reading)
    return
  const waiting = await check(session, 'request.waiter.send', async () => {
    const button = chromeButton(session, REQUEST_EDIT)
    if (button === undefined)
      fail(`页头没有"${REQUEST_EDIT}"`)
    observations.push(observation('click'))
    button.click()
    if (!await waitFor(() => session.host.view().request === 'waiting', SIGNAL_TIMEOUT_MS, 50))
      fail(`点了"${REQUEST_EDIT}"之后没有在等（进展 ${session.host.view().request ?? '没有'}，${describeView(session)}）`)
    if (!await waitFor(() => statusRegionText(session).startsWith('已请求编辑，等待') && chromeButton(session, CANCEL_REQUEST) !== undefined, SIGNAL_TIMEOUT_MS, 50))
      fail(`在等，读屏状态区说"${statusRegionText(session)}"、${chromeButton(session, CANCEL_REQUEST) === undefined ? '没有' : '有'}"${CANCEL_REQUEST}"（应当说已请求编辑、在等谁回应，按钮换成"${CANCEL_REQUEST}"）`)
    return `点"${REQUEST_EDIT}"之后在等：读屏状态区说"${statusRegionText(session)}"，按钮换成"${CANCEL_REQUEST}"；之后等驱动脚本让这一页隐藏、经接口交出`
  })
  if (!waiting)
    return
  const returned = await check(session, 'request.waiter.hidden', async () => {
    if (!await waitFor(() => visibility.hiddenAt() !== undefined, WAITER_HIDDEN_WAIT_MS, 100))
      fail(`${WAITER_HIDDEN_WAIT_MS / 1000} 秒内页面没有变成隐藏（驱动脚本没有从另一方的心跳里看到请求、另开标签页？）`)
    // 在后台：续期得知交给了这一页，停在 granted、不申请；驱动脚本停够了才让它回来（这里只等回来，先后由时间线判读）
    if (!await waitFor(() => visibility.shownAt() !== undefined, WAITER_SHOWN_WAIT_MS, 100))
      fail(`隐藏之后 ${WAITER_SHOWN_WAIT_MS / 1000} 秒内没有回到前台（进展 ${session.host.view().request ?? '没有'}，${describeView(session)}）`)
    const away = round((visibility.shownAt() ?? 0) - (visibility.hiddenAt() ?? 0))
    return `隐藏了 ${(away / 1000).toFixed(1)} 秒之后回到前台（进展 ${session.host.view().request ?? '没有'}${session.host.view().requestUntil === undefined ? '' : `，在等 ${session.host.view().requestUntil ?? ''}`}，${describeView(session)}）`
  }, WAITER_HIDDEN_WAIT_MS + WAITER_SHOWN_WAIT_MS + CHECK_TIMEOUT_MS)
  if (!returned)
    return
  const entered = await check(session, 'request.waiter.entered', async () => {
    const previous = session.probe
    const gaveUp = (): boolean => {
      const view = session.host.view()
      return view.mode === 'reading' && view.request === undefined && view.notice !== undefined
    }
    if (!await waitFor(() => editingSteady(session) || gaveUp(), WAITER_ENTER_WAIT_MS, 50))
      fail(`回到前台之后 ${WAITER_ENTER_WAIT_MS / 1000} 秒内没有进入编辑（进展 ${session.host.view().request ?? '没有'}，${describeView(session)}）`)
    if (gaveUp())
      fail(`没有进入编辑（说明 ${session.host.view().notice ?? '没有'}，${describeView(session)}）`)
    observations.push(observation('entered'))
    adoptEditor(session, previous)
    const summary = summarizeWaiter(timelineWith(observations))
    session.path = summary.path
    session.timings.push({ id: 'request.waiter', ms: summary.ms })
    if (summary.problems.length > 0)
      fail(`${summary.problems.join('；')}（${summary.text}）`)
    return summary.text
  }, WAITER_ENTER_WAIT_MS + CHECK_TIMEOUT_MS)
  if (!entered)
    return
  await check(session, 'request.waiter.save', async () => {
    const prepared = prepareAutosave({ mode: 'held' })
    const sheet = facade(session).getActiveWorkbook().getActiveSheet()
    if (sheet.getSheetId() !== REQUEST_WAITER_EDIT.sheetId)
      fail(`当前工作表是 ${sheet.getSheetId()}（应当是模板的 ${REQUEST_WAITER_EDIT.sheetId}）`)
    sheet.getRange(REQUEST_WAITER_EDIT.cell).setValue(REQUEST_WAITER_EDIT.value)
    const seq = session.probe.changeSeq()
    // 等这一处修改之后的那一轮公式结束：不然这一次捕获带"公式待更新"（P4-S7 复核 O1），服务器上随之记下标记（与 refresh-save 相同）
    if (!await waitFor(() => session.probe.formulasSettled(), SIGNAL_TIMEOUT_MS))
      fail('写下之后公式一直没有收齐')
    const result = await autosaveControl().flush()
    if (result?.outcome?.kind !== 'saved')
      fail(`控制的 flush 没有存上：${JSON.stringify(result) ?? '没有当前的调度'}`)
    const request = requestOf(result.outcome.requestId)
    if (request?.status !== 200 || request.localSeq !== String(seq))
      fail(`保存请求：状态 ${String(request?.status)}、修改序号 ${String(request?.localSeq)}（应当是 200、${seq}）`)
    const stored = cellOf(await fetchServerContent(session.host.documentId), REQUEST_WAITER_EDIT)
    if (stored !== REQUEST_WAITER_EDIT.value)
      fail(`服务器上 ${REQUEST_WAITER_EDIT.cell} 是 ${JSON.stringify(stored) ?? '空'}（应当是写下的值）`)
    return `进入编辑之后写下 ${REQUEST_WAITER_EDIT.cell}、经控制的 flush 存上（200），服务器上是写下的值（编辑权确实交给了这一页）；${prepared}`
  })
}

// ---- paused-holder（路 2） ----

async function pausedHolderScenario(session: Session): Promise<void> {
  const observations: SelftestTimelineEntry[] = []
  const visibility = watchVisibility(observations)
  const unsubscribe = watchStates(session, observations)
  const ticks = watchTicks(observations)
  try {
    await pausedHolderSteps(session, visibility, observations)
  }
  finally {
    ticks.dispose()
    unsubscribe()
    visibility.dispose()
    session.timeline = timelineWith(observations)
  }
}

async function pausedHolderSteps(session: Session, visibility: VisibilityWatch, observations: SelftestTimelineEntry[]): Promise<void> {
  const prelude = await holderPrelude(session, visibility, observations, {
    edits: PAUSED_HOLDER_EDITS,
    prefix: 'request',
    afterSave: '之后等驱动脚本盖住屏幕（这一页随之隐藏）',
    notHidden: '驱动脚本没有盖屏？',
    // 第三格只在这一页：这一页被暂停、编辑权到期，失去编辑权之后另存为副本
    afterWrite: '之后另一方经接口请求编辑；等这一页被暂停、编辑权到期、另一方接手，移走盖屏之后得知失去编辑权',
  })
  if (!prelude)
    return
  let lost = false
  await check(session, 'request.holder.outcome', async () => {
    // 不等编辑器重建到 steady：回来之后才得知，页头的说明（React）照常更新
    const settled = (): boolean => {
      const { mode } = session.host.view()
      return mode === 'lost' || mode === 'reading'
    }
    if (!await waitFor(settled, HOLDER_LOST_WAIT_MS, 100))
      fail(`${HOLDER_LOST_WAIT_MS / 1000} 秒内没有失去编辑权（${describeView(session)}，${session.host.view().incoming === undefined ? '没有' : '有'}在等回应的请求）`)
    observations.push(observation('outcome'))
    const summary = summarizePausedHolder(timelineWith(observations))
    session.path = summary.path
    session.timings.push({ id: 'request.holder', ms: summary.ms })
    const view = session.host.view()
    const notice = lostNoticeText(session)
    if (summary.problems.length > 0)
      fail(`${summary.problems.join('；')}（${summary.text}；说明"${notice}"）`)
    if (view.mode !== 'lost')
      fail(`没有停在失去编辑权（${describeView(session)}）`)
    if (!notice.includes('正在编辑这份文档') || notice.includes('你在') || !notice.includes('本页的修改没有保存：可以另存为副本'))
      fail(`失去编辑权的说明是"${notice}"（应当说另一个人正在编辑这份文档、本页的修改没有保存、可以另存为副本）`)
    if (view.unsaved !== true || chromeButton(session, SAVE_AS_COPY) === undefined)
      fail(`本页${view.unsaved === true ? '有' : '没有'}没保存的修改，${chromeButton(session, SAVE_AS_COPY) === undefined ? '没有' : '有'}"${SAVE_AS_COPY}"（第三格没有存上：两样都应当有）`)
    lost = true
    return `${summary.text}；说明"${notice}"`
  }, HOLDER_LOST_WAIT_MS + CHECK_TIMEOUT_MS)
  if (!lost)
    return
  await check(session, 'request.holder.copy', async () => {
    const button = chromeButton(session, SAVE_AS_COPY)
    if (button === undefined)
      fail(`没有"${SAVE_AS_COPY}"`)
    button.click()
    // 建好之后页面按最新的内容重建为阅读（说明是 copied），两种都认（与 takeover-holder 相同）
    const finished = (): boolean => {
      const view = session.host.view()
      return (view.mode === 'lost' && (view.copy === 'done' || view.copy === 'failed' || view.copy === 'refused')) || (view.mode === 'reading' && view.notice === 'copied')
    }
    if (!await waitFor(finished, SWITCH_TIMEOUT_MS, 100))
      fail(`${SWITCH_TIMEOUT_MS / 1000} 秒内副本没有建好（${describeView(session)}，副本 ${String(session.host.view().copy)}）`)
    const view = session.host.view()
    const copyId = view.copyDocumentId
    if ((view.mode === 'lost' && view.copy !== 'done') || copyId === undefined)
      fail(`另存为副本没有成功（${describeView(session)}，副本 ${String(view.copy)}）`)
    const copied = cellsIn(await fetchServerContent(copyId), PAUSED_HOLDER_EDITS, [true, true, true])
    const original = cellsIn(await fetchServerContent(session.host.documentId), PAUSED_HOLDER_EDITS, [true, true, false])
    if (copied.wrong.length > 0 || original.wrong.length > 0)
      fail(`副本里 ${copied.text}（三格都应当在），原文档里 ${original.text}（只有前两格）`)
    observations.push(observation('copied', { copyId }))
    return `另存为副本：副本里 ${copied.text}；原文档里 ${original.text}（第三格只在副本里）`
  }, SWITCH_TIMEOUT_MS + CHECK_TIMEOUT_MS)
}

/** 请求编辑的两个场景（场景名在 ./selftest-report.ts 的 REQUEST_SCENARIOS） */
export const REQUEST_SCENARIO_RUNNERS = {
  'request-waiter': requestWaiterScenario,
  'paused-holder': pausedHolderScenario,
} as const satisfies Readonly<Record<RequestScenario, (session: Session) => Promise<void>>>

/** 这两个场景都要求页面在中途变成隐藏（不按"页面被隐藏，余下的检查不做"处理） */
export const REQUEST_EXPECTS_HIDDEN: ReadonlySet<string> = new Set(Object.keys(REQUEST_SCENARIO_RUNNERS))
