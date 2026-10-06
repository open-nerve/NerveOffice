import type { AutosaveControlHooks, EditIntent, PageActivity, PageNetwork } from './editor-page.ts'
// 编辑器页的组装：真实的接口、编辑器、整页跳转与标签页之间的会话消息；挂上页头、快捷键与离开提示，然后载入。
// 浏览器的实现都在这里给出（M3-P5）：本页的键盘、鼠标操作（窗口的捕获阶段）、同一个浏览器里的锁与交接频道（navigator.locks、
// BroadcastChannel；浏览器没有时退化，same-browser.ts）、刷新时在途的保存的记号（localStorage 与墙上时间）。
// 测试构建（MODE === 'e2e'）先动态引入自动保存的控制（editor/testing/autosave-control.ts，M3-P4 设计 §3.14）再组装：
// 第一个调度建起来之前它就在（?edit=new 直接进入编辑也一样）；生产构建里这个分支与控制的分块都被去掉（门禁 artifacts 核对）。
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
import { acquireEditLease, fetchContent, fetchContentIfChanged, fetchDocument, fetchEditStatus, gzipText, releaseEditLease, renewEditLease, reportOpenCheckFailures, saveConflictCopy, saveContent, snapshotDigest } from './editor-api.ts'
import { EditorChrome } from './editor-chrome.tsx'
import { createEditorPage } from './editor-page.ts'
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
    // 引入失败（分块下载失败）：照常组装，没有控制（用到它的 E2E 随之失败），错误交给浏览器的错误报告
    void import('../../editor/testing/autosave-control.ts').then(
      ({ installAutosaveControl }) => assemble(elements, installAutosaveControl(window, DEFAULT_AUTOSAVE_LIMITS)),
      (error: unknown) => {
        reportError(error)
        assemble(elements, undefined)
      },
    )
    return
  }
  assemble(elements, undefined)
}

function assemble(elements: SheetEditorPageElements, autosaveControl: AutosaveControlHooks | undefined): void {
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
        acquire: async (documentId, clientInstanceId, options) => acquireEditLease(documentId, clientInstanceId, options?.idleSeconds),
        renew: async (documentId, token, idleSeconds) => renewEditLease(documentId, token, idleSeconds),
        release: async (documentId, token) => releaseEditLease(documentId, token),
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
    digest: async snapshot => snapshotDigest(snapshot),
    autosaveControl,
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
  // 测试构建、地址带 selftest 时：页面自检（真实 Safari 的复核，M3-P2 设计 §3.5）。在开始载入之前引入挂接：它很小，
  // 会话与内容的请求回来之前就挂上了页面错误的收集。生产构建里 MODE 是 production，这个分支与自检的分块都被去掉（门禁 artifacts 核对）
  if (import.meta.env.MODE === 'e2e' && new URLSearchParams(window.location.search).has('selftest'))
    void import('./selftest-hook.ts').then(({ watchForSelftest }) => watchForSelftest(page, elements))
  void page.load()
}
