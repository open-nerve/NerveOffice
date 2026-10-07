// 测试构建的页面自检的挂接（M3-P2 设计 §3.5，真实 Safari 的复核）：start.tsx 只在测试构建、地址带 selftest 时动态引入这里
// （生产构建里 MODE 是 production，那个分支与这个分块都被去掉，门禁 artifacts 核对）。
// 页面开始载入时就挂上页面错误与可见性的收集，订阅页面的状态；到 steady（或载入失败、等不到就绪）之后，才动态引入编辑器的自检模块
// （editor/testing/selftest.ts，模块边界只给这个文件开了这一个口子），由它跑完检查、把结果带到地址里的 next。
import type { SelftestHost, SelftestPageView } from '../../editor/testing/selftest.ts'
import type { LeaseLoss } from './edit-lease.ts'
import type { EditModeState } from './edit-mode.ts'
import type { EditorPage, EditorPageLoad } from './editor-page.ts'
import type { SheetEditorPageElements } from './start.tsx'
import { documentIdFromPagePath } from '@nerve-office/contracts'

/** 等页面到 steady 最多等多久（编辑器的就绪时限是 20 秒，steady 在渲染完成之后 3 秒；留出余量） */
const STEADY_TIMEOUT_MS = 90_000

/**
 * 页面开始时在后台（document.visibilityState 是 hidden）：等这么久还是隐藏的，就不等 steady，直接交给自检说明原因。
 * Safari 不给隐藏的标签页动画帧，几秒之后连计时器也停了（2026-10-04 本机 Safari 27.0 实测：open -g 在后台打开的标签页一开始就是 hidden，
 * 动画帧 0 帧，计时器约 6 秒之后不再触发），编辑器画不出来、自检做不完；趁计时器还在走把原因交回去，驱动脚本不必等到超时
 */
const HIDDEN_GRACE_MS = 2_000

/**
 * 浏览器按 ResizeObserver 规范报告的"这一帧还有没送达的尺寸变化通知"：不是应用的错误（与 E2E 的 support/page-errors.ts 同一个判断，
 * 那里写着原委），记进 ignoredNotices
 */
const RESIZE_OBSERVER_LOOP_NOTICE = /^ResizeObserver loop (?:completed with undelivered notifications\.?|limit exceeded)$/

/**
 * 要在编辑时跑的场景（地址里 selftest 的值）：M3-P2 起打开即阅读，到了阅读的 steady 之后先进入编辑（与页头的"编辑"同一个入口），
 * 到了编辑的 steady 再跑自检。enter-exit 在阅读时开始，场景里自己点页头的"编辑""退出编辑"（S5），按 host.view 等页面的状态变化。
 * 捕获时机的复核（M3-P4 S1）都在编辑时跑；交接的复核（M3-P5）里正在编辑的 A（takeover-holder）在编辑时跑，另开的 B 与刷新的那一步在阅读时开始
 */
const EDITING_SCENARIOS: ReadonlySet<string> = new Set(['edit-chrome', 'environment', 'change-detection', 'formula-timing', 'auto-height', 'large-copy', 'composition', 'hidden-save', 'takeover-holder', 'takeover-holder-deaf'])

/**
 * 交接的复核里收不到交接频道消息的 A（地址里 selftest 的值；与 editor/testing/selftest-report.ts 的 DEAF_HOLDER_SCENARIO 相同——模块边界不让这里
 * 引用它，另写一份，Playwright 的校准核对：名字对不上时 A 照常回应，"A 不回应"那一条随之不通过）
 */
const DEAF_HOLDER_SCENARIO = 'takeover-holder-deaf'

/** 交接频道的名字前缀（same-browser.ts 的 nerve-office:doc:<documentId>） */
const HANDOVER_CHANNEL_PREFIX = 'nerve-office:doc:'

/**
 * 交接的复核里收不到交接频道消息的 A（takeover-holder-deaf，M3-P5）：这一页的 BroadcastChannel 换成不挂交接频道的 message 监听的子类（别的频道照常），
 * 模拟被暂停、冻结、卡住的标签页——与 E2E 的 support/sheet.ts 的 deafenHandover 同一个办法。挂接在页面开始载入时就装上：编辑器页进入编辑、
 * 拿到本机锁之后才第一次打开交接频道（same-browser.ts，组装处每次打开时才取全局的 BroadcastChannel）
 */
export function deafenHandoverChannel(scope: { BroadcastChannel: typeof BroadcastChannel } = globalThis): void {
  const Original = scope.BroadcastChannel
  scope.BroadcastChannel = class extends Original {
    override addEventListener<K extends keyof BroadcastChannelEventMap>(type: K, listener: (this: BroadcastChannel, event: BroadcastChannelEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void
    override addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void
    override addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
      if (type === 'message' && this.name.startsWith(HANDOVER_CHANNEL_PREFIX))
        return
      super.addEventListener(type, listener, options)
    }
  }
}

function describe(value: unknown): string {
  if (value instanceof Error)
    return `${value.name}: ${value.message}`
  if (typeof value === 'string')
    return value
  try {
    return JSON.stringify(value) ?? String(value)
  }
  catch {
    return String(value)
  }
}

interface PageLog {
  readonly pageErrors: string[]
  readonly consoleErrors: string[]
  readonly ignoredNotices: string[]
  readonly visibility: string[]
}

/** 挂上收集：没接住的异常、没处理的拒绝、console.error 的调用与页面可见性的变化（自检结束之后整页跳走，不必撤掉） */
function watchPage(target: Window): PageLog {
  const log: PageLog = { pageErrors: [], consoleErrors: [], ignoredNotices: [], visibility: [`${new Date().toISOString()} ${target.document.visibilityState}`] }
  target.addEventListener('error', (event) => {
    const text = event.error instanceof Error ? describe(event.error) : event.message
    ;(RESIZE_OBSERVER_LOOP_NOTICE.test(event.message) ? log.ignoredNotices : log.pageErrors).push(text)
  })
  target.addEventListener('unhandledrejection', (event) => {
    log.pageErrors.push(`没有处理的拒绝 ${describe(event.reason)}`)
  })
  // 自检要收集页面里 console.error 的调用（M3-P2 设计 §3.5）：包装它，照常转给原来的
  /* eslint-disable no-console -- 见上一行：只在测试构建的自检里包装 console.error */
  const original = console.error
  console.error = (...args: unknown[]) => {
    log.consoleErrors.push(args.map(describe).join(' '))
    original.apply(console, args)
  }
  /* eslint-enable no-console */
  target.document.addEventListener('visibilitychange', () => {
    log.visibility.push(`${new Date().toISOString()} ${target.document.visibilityState}`)
  })
  return log
}

/**
 * 自检交回结果时整页跳走：捕获时机的场景在编辑时改了内容、没有保存，编辑器页的离开提示（page-guards.ts 的 beforeunload）会拦这次跳转。
 * 浏览器只在这一页有过可信的用户操作时才弹"确定离开"的对话框（合成的事件不算），而一旦弹出，对话框是模态的，页面停住、结果交不回去：
 * 2026-10-05 第一次 S1 运行就卡在 change-detection 交回结果的那一刻（Safari 的日志里跳转刚开始、窗口随即失去活动状态，之后再没有心跳
 * 与请求；最小的探针页只有合成事件时 Safari 27 不弹，那一页之前可能有人点过窗口，复核报告 F1）。所以自检自己跳走的那一刻（allowLeave 之后）
 * 在捕获阶段先于页面的监听拦下这个事件，离开提示不生效；别的时候照常（DOM 规范：目标上捕获阶段的监听先于冒泡阶段的）
 */
function allowLeaveForReport(target: Window): () => void {
  let leaving = false
  target.addEventListener('beforeunload', (event) => {
    if (leaving)
      event.stopImmediatePropagation()
  }, { capture: true })
  return () => {
    leaving = true
  }
}

/** 载入失败时的说明 */
function failureOf(load: EditorPageLoad): string {
  return 'error' in load ? `${load.kind}：${describe(load.error)}` : load.kind
}

/** 失去编辑权的原因的写法（交给自检）：种类，被接管的另带在哪里（taken-over:this-browser、taken-over:elsewhere） */
function lossOf(loss: LeaseLoss): string {
  return loss.kind === 'taken-over' ? `${loss.kind}:${loss.where}` : loss.kind
}

/**
 * 交接的复核（M3-P5，editor/testing/selftest-handover.ts）要看的那一部分状态：阅读时"在此编辑"的进展、持有者是自己时那个页面在哪里、
 * 上一次操作留下的说明（另存为副本成功之后回到阅读的，另带建好的副本）；失去编辑权时的原因、有没有没保存的修改、另存为副本的进展与建好的副本。
 * 别的状态没有这些
 */
export function handoverViewOf(mode: EditModeState | undefined): Partial<SelftestPageView> {
  if (mode === undefined)
    return {}
  switch (mode.kind) {
    case 'reading':
      // 另存为副本成功之后按最新的内容重建为阅读：说明里带着建好的副本
      return { takeover: mode.takeover?.kind, selfHolder: mode.selfHolder, notice: mode.notice?.kind, copyDocumentId: mode.notice?.kind === 'copied' ? mode.notice.document.id : undefined }
    case 'losing':
      return { loss: lossOf(mode.loss) }
    case 'lost':
      return { loss: lossOf(mode.loss), unsaved: mode.unsaved, copy: mode.copy.kind, copyDocumentId: mode.copy.kind === 'done' ? mode.copy.document.id : undefined }
    case 'opening':
    case 'entering':
    case 'editing':
    case 'exiting':
    case 'failed':
    case 'unavailable':
      return {}
  }
}

/** 地址带 selftest 时（start.tsx 判断）：等页面到 steady，然后跑自检 */
export function watchForSelftest(page: EditorPage, elements: SheetEditorPageElements): void {
  const startedAt = new Date().toISOString()
  const documentId = documentIdFromPagePath(window.location.pathname)
  if (new URLSearchParams(window.location.search).get('selftest') === DEAF_HOLDER_SCENARIO)
    deafenHandoverChannel()
  const log = watchPage(window)
  const allowLeave = allowLeaveForReport(window)
  let started = false
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined
  const begin = (state: SelftestHost['page']): void => {
    if (started)
      return
    started = true
    unsubscribe?.()
    clearTimeout(timer)
    clearTimeout(hiddenTimer)
    const host: SelftestHost = {
      documentId: documentId ?? '',
      surface: elements.surface,
      chrome: elements.chrome,
      startedAt,
      page: state,
      view: () => {
        const { mode, surface, save } = page.view()
        return { mode: mode?.kind, surface, save: save?.status, ...handoverViewOf(mode) }
      },
      visibility: () => log.visibility,
      allowLeave,
      pageErrors: () => log.pageErrors,
      consoleErrors: () => log.consoleErrors,
      ignoredNotices: () => log.ignoredNotices,
    }
    void import('../../editor/testing/selftest.ts').then(async ({ runSelftestAndReport }) => runSelftestAndReport(host))
  }
  // 打开即阅读：要在编辑时跑的场景先进入编辑，只进一次。进入有了结果（进入了编辑，或者被占用、不能编辑而留在阅读）之后再看：
  // 进入了就等编辑的 steady；留在阅读就照样跑，自检按只读打开说明
  let entering: 'no' | 'requested' | 'settled' = EDITING_SCENARIOS.has(new URLSearchParams(window.location.search).get('selftest') ?? '') ? 'no' : 'settled'
  const onChange = (): void => {
    const { load, mode, surface } = page.view()
    if (load.kind === 'ready' && surface === 'steady' && (mode?.kind === 'reading' || mode?.kind === 'editing')) {
      if (mode.kind === 'reading' && entering !== 'settled') {
        if (entering === 'no') {
          entering = 'requested'
          const settle = (): void => {
            entering = 'settled'
            onChange()
          }
          void page.enterEditing().then(settle, settle)
        }
        return
      }
      begin({ state: 'ready', readOnly: mode.kind === 'reading' })
    }
    else if (load.kind !== 'loading' && load.kind !== 'ready') {
      begin({ state: 'failed', detail: failureOf(load) })
    }
  }
  unsubscribe = page.subscribe(onChange)
  timer = setTimeout(() => begin({ state: 'timeout', detail: `${STEADY_TIMEOUT_MS / 1000} 秒内没有到 steady（${page.view().load.kind}）` }), STEADY_TIMEOUT_MS)
  if (document.visibilityState === 'hidden') {
    hiddenTimer = setTimeout(() => {
      if (document.visibilityState === 'hidden')
        begin({ state: 'hidden', detail: '页面在后台（document.visibilityState 是 hidden）：浏览器暂停了隐藏页面的动画帧与计时器，编辑器画不出来，自检做不了。让浏览器的窗口露出来再跑' })
    }, HIDDEN_GRACE_MS)
  }
  onChange()
}
