import type { EditorChromeMembers } from './editor-chrome.tsx'
import type { AutosaveControlHooks, EditIntent, EditorPage, EditorPageAssemblies, ImageOperationState, PageActivity, PageNetwork } from './editor-page.ts'
import type { HandoverTrace } from './handover-trace.ts'
import type { PageVisibility } from './reading-checks.ts'
import type { SameBrowserApis } from './same-browser.ts'
// 编辑器页的组装：真实的接口、编辑器、整页跳转与标签页之间的会话消息；挂上页头、快捷键与离开提示，然后载入。
// 浏览器的实现都在这里给出（M3-P5）：本页的键盘、鼠标操作（窗口的捕获阶段）、同一个浏览器里的锁与交接频道（navigator.locks、
// BroadcastChannel；浏览器没有时退化，same-browser.ts）、刷新时在途的保存的记号（localStorage 与墙上时间）、这一页发出过的请求编辑的记号
// （sessionStorage）。
// 测试构建（MODE === 'e2e'）先动态引入自动保存的控制（editor/testing/autosave-control.ts，M3-P4 设计 §3.14）与交接日志
// （editor/testing/handover-log.ts，M3-P5 设计 §3.13 的观察钩子）再组装：第一个调度建起来、第一次申请之前它们就在（?edit=new 直接进入编辑也一样）；
// 两个各自引入，一个没引入成不影响另一个；地址带 outboxProbe 时另引入发件箱的浏览器层探针、带 crashProbe 时另引入崩溃用例的探针（M4-P1）。
// 生产构建里这个分支与它们的分块都被去掉（门禁 artifacts 核对）。
// M6-P1 S8b（S8 spec §2.8）：编辑器页是共用编辑会话层的通用页面，这里给它装配表（本构建能打开的类型各一项，P1 只有表格）与按档案取的
// 编辑权、请求编辑的请求。
// M6-P1 S8c（S8 spec §3.3）：从表格编辑器搬进共用编辑会话层，成为与类型无关的 startEditorPage(elements, kit)。一类文档专有的部分由 kit 给出
// （EditorPageKit：装配表、编辑器加载失败的判别、测试构建的两个加载器；表格的是 sheet-editor/start.tsx 的 sheetEditorPageKit）。自动保存的控制与
// 交接日志改由 kit 的 testHooks 引入（适配层的 testing/ 只给表格编辑器开了口子），页面自检的挂接由 kit 的 selftest 引入（它在表格编辑器里）；
// 发件箱与崩溃探针、刷新诊断在会话层的 testing/ 下，由这里自己引入。测试构建里的先后不变：探针发出即不管 → 没有文档身份时只装探针就返回 →
// kit 的测试钩子与刷新诊断同时引入（没引入成照常组装、不上报）→ 再判一次已停止 → 依次装刷新诊断、自动保存的控制、交接日志 → 组装页面 →
// 地址带 selftest 时先装好挂接再载入（没引入成照常载入并上报）。两个加载器多一层 then，只差微任务。
// 这是组合处专用的窄入口：会话层的公开入口只转出它的类型，值由编辑器页的入口（entries/editor/mount.tsx）直接引用（eslint.config.ts 的模块边界）
import { documentIdFromPagePath } from '@nerve-office/contracts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiError, requestSession, setApiSession } from '../../shared/api/index.ts'
import { associatedSessionPermit } from '../../shared/api/session-association.ts'
import { reportRequestSessionFailure } from '../../shared/api/session-tracking.ts'
import { watchBrowserConnection } from '../../shared/lib/browser-connection.ts'
import { connectionState } from '../../shared/lib/connection-state.ts'
import { startDraftMaintenance } from '../../shared/lib/draft-maintenance.ts'
import { hasEditIntent, withoutEditIntent } from '../../shared/lib/edit-intent.ts'
import { browserPageLocation } from '../../shared/lib/page-location.ts'
import { openSessionChannel } from '../../shared/lib/session-channel.ts'
import { LocalDataNotice } from '../local-data/notice.ts'
import { browserLeaseClock, trackActivity } from './edit-lease.ts'
import * as editorApi from './editor-api.ts'
import { EditorChrome } from './editor-chrome.tsx'
import { createEditorPage } from './editor-page.ts'
import { issuedRequestMarker } from './issued-request.ts'
import { installPageGuards, isApplePlatform } from './page-guards.ts'
import { pendingSaveMarker } from './pending-save-marker.ts'
import { clearInheritedReloadMarkers } from './recovery/reload-marker.ts'
import { sameBrowserFor } from './same-browser.ts'

export interface EditorPageElements {
  /** 页头与提示（React） */
  readonly chrome: HTMLElement
  /** 编辑器的容器（Univer） */
  readonly surface: HTMLElement
  /** 创建页保留自己的状态条；正式页头放在 chrome 的子容器，屏障仍覆盖整个 chrome。 */
  readonly heading?: HTMLElement
}

export interface EditorPageMount<Extension extends object, Extra extends object, ImageState extends ImageOperationState> {
  readonly page: EditorPage<Extension, Extra, ImageState>
  readonly loaded: Promise<void>
  readonly dispose: () => void
}

/** 测试构建的钩子装在 window 上之后交给页面的：自动保存的控制与交接的观察钩子（各自没引入成时为 undefined） */
export interface InstalledTestHooks {
  readonly autosaveControl: AutosaveControlHooks | undefined
  readonly handoverTrace: HandoverTrace | undefined
}

/** 测试构建的页面自检的挂接（地址带 selftest 时，载入之前挂上）：lifetime 中止时归还它挂上的东西 */
export type SelftestWatch = (page: EditorPage, elements: EditorPageElements, reloadDiagnostics: (() => unknown) | undefined, lifetime: AbortSignal | undefined) => void | Promise<void>

/**
 * 一类文档在启动时交给页面的（S8 spec §3.3）。两个加载器都在函数里面按 import.meta.env.MODE === 'e2e' 判断，import() 写在判断成立的分支里：
 * 生产构建靠常量折叠去掉这两块（门禁 artifacts 按来源、按分块名、禁用关键字三道核对），别的构建里交回 undefined
 */
export interface EditorPageKit<Extension extends object, Extra extends object, ImageState extends ImageOperationState> {
  /** 装配表（本构建能打开的类型各一项） */
  readonly assemblies: EditorPageAssemblies<Extension, Extra, ImageState>
  /** 编辑器的加载失败：交给"页面开始离开之后不报"的上报（loadFailureReporter），别的意外错误立即上报 */
  readonly isLoadFailure: (error: unknown) => boolean
  /** 测试构建：引入自动保存的控制与交接日志，交回 install(window)（组装之前装上） */
  readonly testHooks?: () => Promise<((target: Window) => InstalledTestHooks) | undefined>
  /** 测试构建：引入页面自检的挂接，交回 watchForSelftest（载入之前挂上） */
  readonly selftest?: () => Promise<SelftestWatch | undefined>
}

/** 页面的可见性：document.visibilityState 与 visibilitychange */
const browserVisibility: PageVisibility = {
  hidden: () => document.visibilityState === 'hidden',
  onChange: (listener) => {
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
}

/** 浏览器信号与请求结果共用一份事实；租约确认在 EditingSession，不能直接由 online 放行。 */
const browserNetwork: PageNetwork = {
  connection: connectionState,
  online: () => connectionState.view().browserOnline,
  onChange: connectionState.subscribe,
}

/** 本页的键盘、鼠标操作：窗口的捕获阶段（交互屏障挂在它之后），只认可信事件、零位移的移动不算（edit-lease.ts 的 trackActivity） */
const browserActivity: PageActivity = {
  subscribe: listener => trackActivity(window, listener),
}

/**
 * 同一个浏览器里的锁与交接频道用到的浏览器 API（M3-P5 设计 §3.1、§3.7）：Web Locks 只在安全上下文里有（HTTPS 与本机地址），
 * 没有时（以及没有 BroadcastChannel 时）same-browser.ts 退化
 */
const browserSameBrowserApis: SameBrowserApis = {
  locks: 'locks' in navigator ? navigator.locks : undefined,
  openChannel: typeof BroadcastChannel === 'undefined' ? undefined : name => new BroadcastChannel(name),
}

/** ?edit=new（shared/lib/edit-intent.ts）：进入编辑之后用 history.replaceState 去掉它（不留历史记录、不重新加载），刷新不再自动进入 */
function editIntentOf(location: Location): EditIntent {
  return {
    requested: hasEditIntent(location.search),
    clear: () => history.replaceState(history.state, '', withoutEditIntent(location.href)),
  }
}

/** 页面开始离开之后这么久以内的加载失败不报（loadFailureReporter）：留着是为了离开被取消（离开提示里选了留下）之后照常报 */
const LEAVING_GRACE_MS = 10_000

/**
 * 加载失败的上报（M3-P5 收尾 E1）：页面开始离开之后的不报，别的照常立即交给浏览器的错误报告。整页跳转会取消还在路上的加载——公式 Worker
 * 的脚本让编辑器以 SheetEditorLoadError（worker-failed）失败，动态引入的分块报"TypeError: Importing a module script failed."；WebKit 还常常
 * 在 pagehide 之前就让它们失败（同 S6 的在途保存），pagehide 也不一定派发。那不是错误，E2E 的页面错误夹具却会把它算成页面错误
 * （specs/foundation/page-errors.spec.ts 打开编辑器页、不等加载完就跳走，WebKit 上本机十次失败两次）。"开始离开"认可信的 beforeunload：
 * 三个浏览器在整页跳转（含 Playwright 的 page.goto）时都先派发它、之后才取消加载（探针核对）；页面自己派发的（E2E 的 wouldPromptOnLeave）
 * 不可信，不算。要在加载开始之前就听着：编辑器在载入之后才建，这里在入口一执行就开始听，来得及；入口执行之前就开始的跳转听不到，所以一开始就
 * 引入的测试钩子不经这里上报（见 startEditorPage）。只用在加载失败上：编辑器的加载失败（kit 的 isLoadFailure）另有可见的说明（"编辑器加载失败"），上报只用于诊断；
 * 别的意外错误照常立即上报
 */
function loadFailureReporter(target: Window) {
  let leavingSince: number | undefined
  const onLeave = (event: BeforeUnloadEvent): void => {
    if (event.isTrusted)
      leavingSince = performance.now()
  }
  target.addEventListener('beforeunload', onLeave)
  return {
    report: (error: unknown) => {
      if (leavingSince === undefined || performance.now() - leavingSince >= LEAVING_GRACE_MS)
        reportError(error)
    },
    dispose: () => target.removeEventListener('beforeunload', onLeave),
  }
}

/** 启动编辑器页（S8 spec §3.3）：kit 是这一类文档在启动时交给页面的；Extension 带页头的插槽（EditorChromeMembers） */
export async function startEditorPage<Extension extends EditorChromeMembers<Extension, Extra, ImageState>, Extra extends object, ImageState extends ImageOperationState>(elements: EditorPageElements, kit: EditorPageKit<Extension, Extra, ImageState>): Promise<EditorPageMount<Extension, Extra, ImageState> | undefined> {
  const stopConnection = watchBrowserConnection({ state: connectionState, probe: requestSession })
  const reporter = loadFailureReporter(window)
  let stopped = false
  let mounted: EditorPageMount<Extension, Extra, ImageState> | undefined
  const dispose = (): void => {
    if (stopped)
      return
    stopped = true
    window.removeEventListener('pagehide', dispose)
    stopConnection()
    reporter.dispose()
    mounted?.dispose()
  }
  window.addEventListener('pagehide', dispose)
  try {
    mounted = await prepare(elements, kit, reporter.report, () => stopped, () => window.removeEventListener('pagehide', dispose))
    if (stopped) {
      mounted?.dispose()
      return
    }
    if (mounted === undefined)
      return
    // 准备期监听在实际 page.load 开始时移交；返回 mount 不代表 selftest 的异步准备已经完成。
    return { page: mounted.page, loaded: mounted.loaded, dispose }
  }
  catch (error) {
    dispose()
    throw error
  }
}

async function prepare<Extension extends EditorChromeMembers<Extension, Extra, ImageState>, Extra extends object, ImageState extends ImageOperationState>(elements: EditorPageElements, kit: EditorPageKit<Extension, Extra, ImageState>, reportLoadFailure: (error: unknown) => void, stopped: () => boolean, onLoadStarted: () => void): Promise<EditorPageMount<Extension, Extra, ImageState> | undefined> {
  if (import.meta.env.MODE === 'e2e') {
    const parameters = new URLSearchParams(window.location.search)
    // 地址带 outboxProbe 时：发件箱的浏览器层探针（M4-P1 设计 §3.1，outbox/testing/outbox-probe.ts），挂在 window 上。它不依赖编辑器页，
    // 与组装各走各的；引入失败同样不上报（理由见下），用到它的 E2E 等不到探针、自己会失败
    if (parameters.has('outboxProbe')) {
      void Promise.allSettled([import('./outbox/testing/outbox-probe.ts')]).then(([probe]) => {
        if (probe.status === 'fulfilled') {
          probe.value.installOutboxProbe(window, {
            request: requestSession,
            adopt: setApiSession,
            failed: async (response, kind) => reportRequestSessionFailure(kind === 'preserve'
              ? new ApiError(403, 'CSRF_TOKEN_INVALID', '探针：原请求令牌失效')
              : new ApiError(401, 'SESSION_EXPIRED', '探针：原来源确证停用', { details: { reason: 'account_disabled', userId: response.user.id } }), associatedSessionPermit(response)),
          })
        }
      })
    }
    // 地址带 crashProbe 时：写入中途结束整棵浏览器进程的原子性用例的探针（M4-P1 设计 §3.7，outbox/testing/crash-probe.ts），同上
    if (parameters.has('crashProbe')) {
      void Promise.allSettled([import('./outbox/testing/crash-probe.ts')]).then(([probe]) => {
        if (probe.status === 'fulfilled')
          probe.value.installCrashProbe(window)
      })
    }
    // 独立存储/崩溃探针没有文档身份，只安装探针。后台维护会提前建库或修复原件，破坏首次读取、升级和原子性用例的前提。
    // 真正的文档页即使带探针参数，也必须照常装配页面和维护。
    if (documentIdFromPagePath(window.location.pathname) === undefined && (parameters.has('outboxProbe') || parameters.has('crashProbe')))
      return
    // 引入失败：照常组装，没有那一样，不上报——用到它的 E2E 自己会失败（控制、日志不在）。这两块在页面一开始就引入，整页跳转可能在入口的
    // 脚本还没执行、还没开始听 beforeunload 时就已开始，随后取消它们（WebKit 报"Importing a module script failed."），分不清是不是跳转取消的
    // （M3-P5 收尾 E1：page-errors.spec.ts 在 WebKit 上本机四十次失败两次）。自动保存的控制与交接日志由 kit 的 testHooks 引入（两个各自引入，
    // 一个没引入成不影响另一个，kit 里接住），与刷新诊断同时引入
    const crash = parameters.get('selftest') === 'crash-recovery'
    const [hooks, diagnostics] = await Promise.allSettled([kit.testHooks?.(), crash ? import('./recovery/testing/reload-diagnostics.ts') : Promise.resolve(undefined)])
    if (stopped())
      return
    // 依次装刷新诊断、自动保存的控制、交接日志（install 里先控制后日志），再组装
    const observed = diagnostics.status === 'fulfilled' ? diagnostics.value?.observeReloadStart(() => window.sessionStorage) : undefined
    const installed = hooks.status === 'fulfilled' ? hooks.value?.(window) : undefined
    return assemble(elements, kit, reportLoadFailure, installed?.autosaveControl, installed?.handoverTrace, observed?.snapshot, onLoadStarted)
  }
  return assemble(elements, kit, reportLoadFailure, undefined, undefined, undefined, onLoadStarted)
}

function assemble<Extension extends EditorChromeMembers<Extension, Extra, ImageState>, Extra extends object, ImageState extends ImageOperationState>(elements: EditorPageElements, kit: EditorPageKit<Extension, Extra, ImageState>, reportLoadFailure: (error: unknown) => void, autosaveControl: AutosaveControlHooks | undefined, handoverTrace: HandoverTrace | undefined, reloadDiagnostics: (() => unknown) | undefined, onLoadStarted: () => void): EditorPageMount<Extension, Extra, ImageState> {
  const stopMaintenance = startDraftMaintenance()
  clearInheritedReloadMarkers(() => window.sessionStorage)
  const page = createEditorPage<Extension, Extra, ImageState>({
    // 托管只把编辑器页的地址交给这个页面；万一不是，页面显示内容不存在
    documentId: documentIdFromPagePath(window.location.pathname),
    surface: elements.surface,
    chrome: elements.chrome,
    // 本页的装配表（M6-P1 设计 §3.4，S8 spec §2.3）：由 kit 给出（表格的装配带适配层的编辑器工厂；文字文档的装配在 M6-P2）
    assemblies: kit.assemblies,
    api: {
      session: async () => requestSession(),
      document: async documentId => editorApi.fetchDocument(documentId),
      content: async documentId => editorApi.fetchContent(documentId),
      contentIfChanged: async (documentId, revision) => editorApi.fetchContentIfChanged(documentId, revision),
      editStatus: async documentId => editorApi.fetchEditStatus(documentId),
      save: async (documentId, request, body, lease) => editorApi.saveContent(documentId, request, body, lease),
      replay: async (documentId, request, body) => editorApi.replayContent(documentId, request.request, body, request.writeEpoch),
      conflictCopy: async (documentId, query, body) => editorApi.saveConflictCopy(documentId, query, body),
      reportOpenCheck: async (documentId, report) => editorApi.reportOpenCheckFailures(documentId, report),
      // 编辑权与请求编辑按页面上报的档案取（S8 spec §2.6）：页面以选中的装配的档案取用，申请、续租与发出请求编辑的请求体带它
      editLease: format => ({
        acquire: async (documentId, clientInstanceId, options) => editorApi.acquireEditLease(documentId, clientInstanceId, format, options),
        renew: async (documentId, token, idleSeconds) => editorApi.renewEditLease(documentId, token, idleSeconds, format),
        release: async (documentId, token) => editorApi.releaseEditLease(documentId, token),
        handOver: async (documentId, token, requestId) => editorApi.handOverEditLease(documentId, token, requestId),
        decline: async (documentId, token, requestId) => editorApi.declineEditRequest(documentId, token, requestId),
      }),
      editRequest: format => ({
        send: async documentId => editorApi.sendEditRequest(documentId, format),
        renew: async documentId => editorApi.renewEditRequest(documentId),
        cancel: async documentId => editorApi.cancelEditRequest(documentId),
      }),
    },
    page: browserPageLocation,
    sessionChannel: openSessionChannel(),
    clock: browserLeaseClock,
    visibility: browserVisibility,
    network: browserNetwork,
    activity: browserActivity,
    sameBrowser: documentId => sameBrowserFor(documentId, browserSameBrowserApis),
    // 访问 localStorage 本身就可能抛出（被禁用、沙箱）：每次用时再取，记号自己接住
    pendingSave: (userId, documentId) => pendingSaveMarker(userId, documentId, { storage: () => window.localStorage, now: () => Date.now() }),
    // 每次装配新的内存意图；sessionStorage 只用于清理旧版本记号，不恢复页面身份
    issuedRequest: documentId => issuedRequestMarker(documentId, { storage: () => window.sessionStorage }),
    autosaveControl,
    handoverTrace,
    editIntent: editIntentOf(window.location),
    currentPath: () => `${window.location.pathname}${window.location.search}`,
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
    // 编辑器的加载失败（kit 判别）可能是页面正在离开、加载被取消（loadFailureReporter）；别的意外错误立即上报
    reportError: error => kit.isLoadFailure(error) ? reportLoadFailure(error) : reportError(error),
  })
  // navigator.platform 已不推荐使用，但各浏览器都还给出真实的平台；userAgentData 只有 Chromium 有
  const apple = isApplePlatform(navigator.platform)
  const stopGuards = installPageGuards(window, page, apple)
  const root = createRoot(elements.heading ?? elements.chrome)
  root.render(
    <StrictMode>
      <LocalDataNotice />
      <EditorChrome page={page} apple={apple} />
    </StrictMode>,
  )
  // 测试构建、地址带 selftest 时：页面自检（真实 Safari 的复核，M3-P2 设计 §3.5）。先等挂接引入、挂上，再开始载入（M3-P5 审查 B8）：页面错误的收集
  // 要在会话与内容的请求回来之前挂上，"收不到交接消息"的那一页（takeover-holder-deaf）要在编辑器页第一次打开交接频道之前换上吞消息的频道——
  // 频道在建编辑模式时就打开（订阅交接请求），那时会话、详情与内容都已回来；原来先发起载入、再引入挂接，靠挂接的小分块先回来，不是保证的先后。
  // 挂接由 kit 的 selftest 引入（S8c：它在表格编辑器里；不能挂在选中装配上——那在载入详情之后）。
  // 引入失败照常载入（自检随之没有结果，错误交给浏览器的错误报告）。生产构建里 MODE 是 production，这个分支与 kit 里自检的分块都被去掉（门禁 artifacts 核对）
  let disposed = false
  const selftestAbort = import.meta.env.MODE === 'e2e' ? new AbortController() : undefined
  const load = async (): Promise<void> => {
    if (disposed)
      return
    // load 同步安装正式 pagehide 处理；之后不能用普通 dispose 抢先释放在途保存的租约。
    onLoadStarted()
    await page.load()
  }
  const selftest = import.meta.env.MODE === 'e2e' && new URLSearchParams(window.location.search).has('selftest') ? kit.selftest : undefined
  const loaded = selftest !== undefined
    ? selftest().then(
        (watchForSelftest): void | Promise<void> => {
          if (!disposed)
            return watchForSelftest?.(page, elements, reloadDiagnostics, selftestAbort?.signal)
        },
        (error: unknown) => {
          if (!disposed)
            reportLoadFailure(error)
        },
      ).then(load)
    : load()
  return {
    page,
    loaded,
    dispose() {
      if (disposed)
        return
      disposed = true
      selftestAbort?.abort()
      stopGuards()
      stopMaintenance()
      root.unmount()
      page.dispose()
    },
  }
}
