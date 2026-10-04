import type { EditIntent } from './editor-page.ts'
// 编辑器页的组装：真实的接口、编辑器、整页跳转与标签页之间的会话消息；挂上页头、快捷键与离开提示，然后载入。
import type { PageVisibility } from './reading-checks.ts'
import { documentIdFromPagePath } from '@nerve-office/contracts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createSheetEditor } from '../../editor/index.ts'
import { requestSession } from '../../shared/api/index.ts'
import { hasEditIntent, withoutEditIntent } from '../../shared/lib/edit-intent.ts'
import { browserPageLocation } from '../../shared/lib/page-location.ts'
import { openSessionChannel } from '../../shared/lib/session-channel.ts'
import { browserLeaseClock } from './edit-lease.ts'
import { acquireEditLease, fetchContent, fetchContentIfChanged, fetchDocument, fetchEditStatus, gzipText, releaseEditLease, renewEditLease, saveConflictCopy, saveContent } from './editor-api.ts'
import { EditorChrome } from './editor-chrome.tsx'
import { createEditorPage } from './editor-page.ts'
import { installPageGuards, isApplePlatform } from './page-guards.ts'

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

/** ?edit=new（shared/lib/edit-intent.ts）：进入编辑之后用 history.replaceState 去掉它（不留历史记录、不重新加载），刷新不再自动进入 */
function editIntentOf(location: Location): EditIntent {
  return {
    requested: hasEditIntent(location.search),
    clear: () => history.replaceState(history.state, '', withoutEditIntent(location.href)),
  }
}

export function startSheetEditorPage(elements: SheetEditorPageElements): void {
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
      editLease: {
        acquire: async (documentId, clientInstanceId) => acquireEditLease(documentId, clientInstanceId),
        renew: async (documentId, token, idleSeconds) => renewEditLease(documentId, token, idleSeconds),
        release: async (documentId, token) => releaseEditLease(documentId, token),
      },
    },
    createEditor: createSheetEditor,
    page: browserPageLocation,
    sessionChannel: openSessionChannel(),
    clock: browserLeaseClock,
    visibility: browserVisibility,
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
