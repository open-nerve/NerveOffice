import type { SheetEditorFailure } from '../../editor/index.ts'
import type { SessionChannel } from '../../shared/lib/session-channel.ts'
import { historyIdsFromPagePath } from '@nerve-office/contracts'
import { createRoot } from 'react-dom/client'
import { createSheetEditor, SheetEditorLoadError } from '../../editor/index.ts'
import { fetchHistoryContent, fetchHistoryDetail, HistoryContentError } from '../../shared/api/document-history.ts'
import { requestBackgroundSession, requestSession, setApiSession, setCsrfToken } from '../../shared/api/index.ts'
import { openSessionChannel } from '../../shared/lib/session-channel.ts'
import { PreviewChrome } from './preview-chrome.tsx'
import { createHistoryPreview } from './preview-controller.ts'

const RECHECK_MS = 30_000
/** SDK 按数据拒绝的加载失败：同一份历史重试也是同样的结果（M5R-M-05）；Worker、图片限制与就绪超时属于环境，仍可重试 */
const DATA_FAILURES: ReadonlySet<SheetEditorFailure> = new Set<SheetEditorFailure>(['snapshot-invalid', 'create-failed', 'unit-mismatch'])
export interface HistoryPreviewElements {
  readonly chrome: HTMLElement
  readonly surface: HTMLElement
  readonly pathname?: string
  readonly channel?: SessionChannel
}
/** 单独页面的唯一组装点：无 AppRuntime、编辑会话、自动保存或草稿维护。 */
export function startHistoryPreview({ chrome, surface, pathname = window.location.pathname, channel: suppliedChannel }: HistoryPreviewElements): () => Promise<void> {
  const root = createRoot(chrome)
  const ids = historyIdsFromPagePath(pathname)
  if (ids === undefined) {
    surface.hidden = true
    root.render(<PreviewChrome state={{ kind: 'unavailable' }} documentId={undefined} pathname={pathname} imageProblem={false} retry={() => {}} />)
    return async () => root.unmount()
  }
  const channel = suppliedChannel ?? openSessionChannel()
  let imageProblem = false
  let stopped = false
  const preview = createHistoryPreview({
    session: async (signal, activity) => activity === 'user' ? requestSession(signal) : requestBackgroundSession(signal),
    detail: async signal => fetchHistoryDetail(ids.documentId, ids.historyId, signal),
    content: async signal => fetchHistoryContent(ids.documentId, ids.historyId, signal),
    unusable: error => error instanceof HistoryContentError || (error instanceof SheetEditorLoadError && DATA_FAILURES.has(error.reason)),
    adopt: (session) => {
      if (session === undefined)
        setCsrfToken(undefined)
      else
        setApiSession(session)
    },
    mount: async (snapshot, images) => {
      const editor = await createSheetEditor({
        container: surface,
        snapshot,
        access: 'read',
        imageAccess: images,
        onImageFailure: () => {
          imageProblem = true
          show()
        },
      })
      return { usable: editor.openCheck.ok, dispose: editor.dispose }
    },
  })
  function retry(): void {
    void preview.refresh('user')
  }
  function recheck(): void {
    void preview.refresh('background')
  }
  let previous = preview.view().kind
  /**
   * 图片失败提示只在真正重新载入时清除：进入加载态时图片随之暂停，之后会重读、再报失败。
   * 就绪时的后台复核只核验、不重读图片（D-06），已报告的失败要一直显示到用户重新打开（M5R-M-04）
   */
  function changed(): void {
    const kind = preview.view().kind
    if (kind === 'loading' && previous !== 'loading')
      imageProblem = false
    previous = kind
    show()
  }
  function show(): void {
    if (stopped)
      return
    const state = preview.view()
    // 初始化 SDK 时保留布局尺寸，但在身份和资格确认完之前不显示画布。
    surface.hidden = state.kind !== 'ready' && state.kind !== 'loading'
    surface.style.visibility = state.kind === 'ready' ? 'visible' : 'hidden'
    surface.dataset.editorState = state.kind === 'ready' ? 'ready' : state.kind === 'loading' ? 'loading' : 'failed'
    root.render(<PreviewChrome state={state} documentId={ids?.documentId} pathname={pathname} imageProblem={imageProblem} retry={retry} />)
  }
  const unsubscribe = preview.subscribe(changed)
  const unlisten = channel.subscribe(recheck)
  const whenVisible = (): void => {
    if (document.visibilityState === 'visible')
      recheck()
  }
  const interval = window.setInterval(whenVisible, RECHECK_MS)
  document.addEventListener('visibilitychange', whenVisible)
  window.addEventListener('online', whenVisible)
  show()
  retry()
  return async () => {
    if (!stopped) {
      stopped = true
      surface.hidden = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', whenVisible)
      window.removeEventListener('online', whenVisible)
      unlisten()
      unsubscribe()
      channel.close()
      root.unmount()
    }
    await preview.dispose()
  }
}
