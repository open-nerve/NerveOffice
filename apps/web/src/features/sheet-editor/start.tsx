// 编辑器页的组装：真实的接口、编辑器、整页跳转与标签页之间的会话消息；挂上页头、快捷键与离开提示，然后载入。
import { documentIdFromPagePath } from '@nerve-office/contracts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createSheetEditor } from '../../editor/index.ts'
import { requestSession } from '../../shared/api/index.ts'
import { browserPageLocation } from '../../shared/lib/page-location.ts'
import { openSessionChannel } from '../../shared/lib/session-channel.ts'
import { browserLeaseClock } from './edit-lease.ts'
import { acquireEditLease, fetchContent, fetchDocument, gzipText, releaseEditLease, renewEditLease, saveContent } from './editor-api.ts'
import { EditorChrome } from './editor-chrome.tsx'
import { createEditorPage } from './editor-page.ts'
import { installPageGuards, isApplePlatform } from './page-guards.ts'

export interface SheetEditorPageElements {
  /** 页头与提示（React） */
  readonly chrome: HTMLElement
  /** 编辑器的容器（Univer） */
  readonly surface: HTMLElement
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
      compress: async snapshot => gzipText(snapshot),
      save: async (documentId, request, body, lease) => saveContent(documentId, request, body, lease),
      editLease: {
        acquire: async (documentId, clientInstanceId) => acquireEditLease(documentId, clientInstanceId),
        renew: async (documentId, token, idleSeconds) => renewEditLease(documentId, token, idleSeconds),
        release: (documentId, token) => releaseEditLease(documentId, token),
      },
    },
    createEditor: createSheetEditor,
    page: browserPageLocation,
    sessionChannel: openSessionChannel(),
    clock: browserLeaseClock,
    currentPath: () => `${window.location.pathname}${window.location.search}`,
    newId: () => crypto.randomUUID(),
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
  void page.load()
}
