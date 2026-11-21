import type { CreatedDocument, SessionResponse } from '@nerve-office/contracts'
import type { EditorPageElements } from '../document-editor/index.ts'
import type { CsvCreatedHost, CsvCreation, CsvCreationOwner } from './csv-create-controller.ts'
import type { SheetEditorPageMount } from './sheet-editor-page.ts'
import { csvCreateLocation } from '@nerve-office/contracts'
import { createRoot } from 'react-dom/client'
import { createDocument } from '../../shared/api/create-document.ts'
import { requestSession, setApiSession } from '../../shared/api/index.ts'
import { subscribeApiSession } from '../../shared/api/session-context.ts'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'
import { watchBrowserConnection } from '../../shared/lib/browser-connection.ts'
import { connectionState } from '../../shared/lib/connection-state.ts'
import { newDocumentPagePath } from '../../shared/lib/edit-intent.ts'
import { loginPath } from '../../shared/lib/login-path.ts'
import { openSessionChannel } from '../../shared/lib/session-channel.ts'
import { spacePath } from '../../shared/lib/space-paths.ts'
import { draftSessionPermitOf } from '../../shared/local-drafts/session-activation.ts'
import { subscribeLocalSession } from '../../shared/local-drafts/session-events.ts'
import { fetchCsvDestination } from './csv-create-api.ts'
import { createCsvCreation } from './csv-create-controller.ts'
import { CsvCreateEntry } from './csv-create-entry.tsx'

export interface CsvCreationPage {
  readonly controller: CsvCreation
  readonly dispose: () => void
}

/** 启动正式的编辑器页（M6-P1 S8c）：编辑器页的入口给出——共用编辑会话层的 startEditorPage 带上表格的 kit */
export type StartSheetEditorPage = (elements: EditorPageElements) => Promise<SheetEditorPageMount | undefined>

/** CSV 只在创建控制器的内存中；创建后换地址并在同一 Document 接入正常编辑/保存。start 是正式编辑器页的启动 */
export function startCsvCreatePage(elements: EditorPageElements, start: StartSheetEditorPage): CsvCreationPage | undefined {
  const location = csvCreateLocation(window.location.pathname, new URLSearchParams(window.location.search))
  const { chrome, surface } = elements
  surface.hidden = true
  if (location === undefined) {
    chrome.textContent = editorMessages.csvCreate.invalidLocation
    return
  }
  const from = `${window.location.pathname}${window.location.search}`
  const flow = document.createElement('div')
  const heading = document.createElement('div')
  heading.hidden = true
  chrome.append(flow, heading)
  const root = createRoot(flow)
  let disposed = false
  let pageHidden = false
  let accepted: SessionResponse | undefined
  let mounted: SheetEditorPageMount | undefined
  let saved = false
  let stopConnection: (() => void) | undefined = watchBrowserConnection({ state: connectionState, probe: requestSession })

  const controller = createCsvCreation({
    location,
    session: requestSession,
    adopt: (response) => {
      accepted = response
      setApiSession(response)
    },
    access: fetchCsvDestination,
    create: createDocument,
    openCreated,
    online: () => connectionState.view().available,
  })
  async function openCreated(document: CreatedDocument, owner: CsvCreationOwner): Promise<CsvCreatedHost> {
    stopConnection?.()
    stopConnection = undefined
    history.replaceState(history.state, '', newDocumentPagePath(document.id))
    // 让 SDK 在实际布局尺寸下初始化；就绪前不接受用户输入。
    surface.hidden = false
    surface.style.visibility = 'hidden'
    let opened: SheetEditorPageMount | undefined
    try {
      opened = await start({ chrome, surface, heading })
      if (opened === undefined)
        throw new Error('正式编辑器未挂载')
      await opened.loaded
      if (disposed || controller.view().stage !== 'opening' || opened.page.view().load.kind !== 'ready' || opened.page.view().surface !== 'ready')
        throw new Error('本轮正式编辑器不可用')
    }
    catch (error) {
      opened?.dispose()
      surface.hidden = true
      if (!disposed && controller.view().stage === 'opening')
        stopConnection = watchBrowserConnection({ state: connectionState, probe: requestSession })
      throw error
    }
    const ready = opened
    mounted = ready
    heading.hidden = false
    surface.style.visibility = ''
    return {
      // 表格的页面扩展（S8b）在正式页载入完成时已经有了（上面核对过 ready）
      apply: async (table, current) => ready.page.extension()?.importCreatedCsv(table, { documentId: document.id, ...owner, current }) ?? false,
      dispose: () => {
        // 真实离开由正式页原有 pagehide 收尾；不能用普通卸载抢先释放仍有保存的租约。
        if (!pageHidden)
          ready.dispose()
      },
    }
  }

  const channel = openSessionChannel()
  const cleanups = [
    // 登录/退出广播没有正文或凭据；它只取消本轮 CSV，正式宿主自行确认自己的会话。
    channel.subscribe(controller.invalidate),
    subscribeApiSession((session) => {
      if (accepted !== undefined && (session?.user.id !== accepted.user.id || session.csrfToken !== accepted.csrfToken))
        controller.invalidate()
    }),
    subscribeLocalSession((event) => {
      const source = accepted === undefined ? undefined : draftSessionPermitOf(accepted)
      if (event.kind === 'stopped' && source?.userId === event.previous.userId && source.generation === event.previous.generation)
        controller.invalidate()
    }),
    controller.subscribe(() => {
      if (controller.view().stage === 'done' && !saved) {
        saved = true
        // 完成应用后矩阵已释放，所有保存/失败说明由正常页负责，不重复导入。
        void mounted?.page.save()
      }
    }),
  ]
  const beforeUnload = (event: BeforeUnloadEvent): void => {
    if (controller.hasPendingWork())
      event.preventDefault()
  }
  const dispose = (): void => {
    if (disposed)
      return
    disposed = true
    const keepDocument = pageHidden && mounted !== undefined
    cleanups.forEach(cleanup => cleanup())
    channel.close()
    window.removeEventListener('beforeunload', beforeUnload)
    window.removeEventListener('pagehide', onPageHide)
    stopConnection?.()
    stopConnection = undefined
    controller.dispose()
    accepted = undefined
    mounted = undefined
    root.unmount()
    flow.remove()
    if (!keepDocument) {
      heading.remove()
      surface.hidden = true
    }
  }
  function onPageHide(): void {
    pageHidden = true
    dispose()
  }
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('pagehide', onPageHide)
  root.render(<CsvCreateEntry controller={controller} backHref={spacePath(location.spaceId)} loginHref={loginPath(from)} />)
  void controller.load()
  return { controller, dispose }
}
