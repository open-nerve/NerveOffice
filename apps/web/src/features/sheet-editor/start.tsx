import type { AutosaveControlHooks, EditIntent, PageActivity, PageNetwork } from './editor-page.ts'
import type { HandoverTrace } from './handover-trace.ts'
// 编辑器页的组装：真实的接口、编辑器、整页跳转与标签页之间的会话消息；挂上页头、快捷键与离开提示，然后载入。
// 浏览器的实现都在这里给出（M3-P5）：本页的键盘、鼠标操作（窗口的捕获阶段）、同一个浏览器里的锁与交接频道（navigator.locks、
// BroadcastChannel；浏览器没有时退化，same-browser.ts）、刷新时在途的保存的记号（localStorage 与墙上时间）、这一页发出过的请求编辑的记号
// （sessionStorage）。
// 测试构建（MODE === 'e2e'）先动态引入自动保存的控制（editor/testing/autosave-control.ts，M3-P4 设计 §3.14）与交接日志
// （editor/testing/handover-log.ts，M3-P5 设计 §3.13 的观察钩子）再组装：第一个调度建起来、第一次申请之前它们就在（?edit=new 直接进入编辑也一样）；
// 两个各自引入，一个没引入成不影响另一个；生产构建里这个分支与它们的分块都被去掉（门禁 artifacts 核对）。
import type { PageVisibility } from './reading-checks.ts'
import type { SameBrowserApis } from './same-browser.ts'
import { documentIdFromPagePath } from '@nerve-office/contracts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createSheetEditor } from '../../editor/index.ts'
import { requestSession } from '../../shared/api/index.ts'
import { hasEditIntent, withoutEditIntent } from '../../shared/lib/edit-intent.ts'
import { browserPageLocation } from '../../shared/lib/page-location.ts'
import { openSessionChannel } from '../../shared/lib/session-channel.ts'
import { DEFAULT_AUTOSAVE_LIMITS } from './autosave.ts'
import { browserLeaseClock, trackActivity } from './edit-lease.ts'
import { acquireEditLease, cancelEditRequest, declineEditRequest, fetchContent, fetchContentIfChanged, fetchDocument, fetchEditStatus, gzipText, handOverEditLease, releaseEditLease, renewEditLease, renewEditRequest, reportOpenCheckFailures, saveConflictCopy, saveContent, sendEditRequest, snapshotDigest } from './editor-api.ts'
import { EditorChrome } from './editor-chrome.tsx'
import { createEditorPage } from './editor-page.ts'
import { issuedRequestMarker } from './issued-request.ts'
import { installPageGuards, isApplePlatform } from './page-guards.ts'
import { pendingSaveMarker } from './pending-save-marker.ts'
import { sameBrowserFor } from './same-browser.ts'

export interface SheetEditorPageElements {
  /** 页头与提示（React） */
  readonly chrome: HTMLElement
  /** 编辑器的容器（Univer） */
  readonly surface: HTMLElement
}

/** 页面的可见性：document.visibilityState 与 visibilitychange */
const browserVisibility: PageVisibility = {
  hidden: () => document.visibilityState === 'hidden',
  onChange: (listener) => {
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
}

/** 联网与否：navigator.onLine 与 online、offline 事件（自动保存离线时不发，恢复时立即上传） */
const browserNetwork: PageNetwork = {
  online: () => navigator.onLine,
  onChange: (listener) => {
    window.addEventListener('online', listener)
    window.addEventListener('offline', listener)
    return () => {
      window.removeEventListener('online', listener)
      window.removeEventListener('offline', listener)
    }
  },
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

export function startSheetEditorPage(elements: SheetEditorPageElements): void {
  if (import.meta.env.MODE === 'e2e') {
    // 引入失败（分块下载失败）：照常组装，没有那一样（用到它的 E2E 随之失败），错误交给浏览器的错误报告
    void Promise.allSettled([import('../../editor/testing/autosave-control.ts'), import('../../editor/testing/handover-log.ts')]).then(([control, log]) => {
      if (control.status === 'rejected')
        reportError(control.reason)
      if (log.status === 'rejected')
        reportError(log.reason)
      assemble(
        elements,
        control.status === 'fulfilled' ? control.value.installAutosaveControl(window, DEFAULT_AUTOSAVE_LIMITS) : undefined,
        log.status === 'fulfilled' ? log.value.installHandoverLog(window).observe : undefined,
      )
    })
    return
  }
  assemble(elements, undefined, undefined)
}

function assemble(elements: SheetEditorPageElements, autosaveControl: AutosaveControlHooks | undefined, handoverTrace: HandoverTrace | undefined): void {
  const page = createEditorPage({
    // 托管只把编辑器页的地址交给这个页面；万一不是，页面显示内容不存在
    documentId: documentIdFromPagePath(window.location.pathname),
    surface: elements.surface,
    chrome: elements.chrome,
    api: {
      session: async () => requestSession(),
      document: async documentId => fetchDocument(documentId),
      content: async documentId => fetchContent(documentId),
      contentIfChanged: async (documentId, revision) => fetchContentIfChanged(documentId, revision),
      editStatus: async documentId => fetchEditStatus(documentId),
      compress: async snapshot => gzipText(snapshot),
      save: async (documentId, request, body, lease) => saveContent(documentId, request, body, lease),
      conflictCopy: async (documentId, query, body) => saveConflictCopy(documentId, query, body),
      reportOpenCheck: async (documentId, report) => reportOpenCheckFailures(documentId, report),
      editLease: {
        acquire: async (documentId, clientInstanceId, options) => acquireEditLease(documentId, clientInstanceId, options),
        renew: async (documentId, token, idleSeconds) => renewEditLease(documentId, token, idleSeconds),
        release: async (documentId, token) => releaseEditLease(documentId, token),
        handOver: async (documentId, token, requestId) => handOverEditLease(documentId, token, requestId),
        decline: async (documentId, token, requestId) => declineEditRequest(documentId, token, requestId),
      },
      editRequest: {
        send: async documentId => sendEditRequest(documentId),
        renew: async documentId => renewEditRequest(documentId),
        cancel: async documentId => cancelEditRequest(documentId),
      },
    },
    createEditor: createSheetEditor,
    page: browserPageLocation,
    sessionChannel: openSessionChannel(),
    clock: browserLeaseClock,
    visibility: browserVisibility,
    network: browserNetwork,
    activity: browserActivity,
    sameBrowser: documentId => sameBrowserFor(documentId, browserSameBrowserApis),
    // 访问 localStorage 本身就可能抛出（被禁用、沙箱）：每次用时再取，记号自己接住
    pendingSave: documentId => pendingSaveMarker(documentId, { storage: () => window.localStorage, now: () => Date.now() }),
    // 这一页发出过的请求编辑（审查 B2）：按标签页、刷新之后还在，所以是 sessionStorage；同样每次用时再取
    issuedRequest: documentId => issuedRequestMarker(documentId, { storage: () => window.sessionStorage }),
    digest: async snapshot => snapshotDigest(snapshot),
    autosaveControl,
    handoverTrace,
    editIntent: editIntentOf(window.location),
    currentPath: () => `${window.location.pathname}${window.location.search}`,
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
    reportError: error => reportError(error),
  })
  // navigator.platform 已不推荐使用，但各浏览器都还给出真实的平台；userAgentData 只有 Chromium 有
  const apple = isApplePlatform(navigator.platform)
  installPageGuards(window, page, apple)
  createRoot(elements.chrome).render(
    <StrictMode>
      <EditorChrome page={page} apple={apple} />
    </StrictMode>,
  )
  // 测试构建、地址带 selftest 时：页面自检（真实 Safari 的复核，M3-P2 设计 §3.5）。先等挂接引入、挂上，再开始载入（M3-P5 审查 B8）：页面错误的收集
  // 要在会话与内容的请求回来之前挂上，"收不到交接消息"的那一页（takeover-holder-deaf）要在编辑器页第一次打开交接频道之前换上吞消息的频道——
  // 频道在建编辑模式时就打开（订阅交接请求），那时会话、详情与内容都已回来；原来先发起载入、再引入挂接，靠挂接的小分块先回来，不是保证的先后。
  // 引入失败照常载入（自检随之没有结果，错误交给浏览器的错误报告）。生产构建里 MODE 是 production，这个分支与自检的分块都被去掉（门禁 artifacts 核对）
  if (import.meta.env.MODE === 'e2e' && new URLSearchParams(window.location.search).has('selftest')) {
    void import('./selftest-hook.ts').then(
      ({ watchForSelftest }) => watchForSelftest(page, elements),
      (error: unknown) => reportError(error),
    ).then(async () => page.load())
    return
  }
  void page.load()
}
