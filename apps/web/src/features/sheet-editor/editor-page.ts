// 编辑器页（P4 设计 §3.7）：载入、保存、会话。界面（editor-chrome.tsx）只订阅这里的状态；
// 编辑器在 React 之外创建：一页一份文档，整页加载与卸载，不随组件的挂载与卸载反复创建（计划书 §10.2）。
import type { DocumentDetail, SaveContentResponse, SessionResponse } from '@nerve-office/contracts'
import type { CreateSheetEditorOptions, SheetEditor, SheetEditorLifecycle } from '../../editor/index.ts'
import type { PageLocation } from '../../shared/lib/page-location.ts'
import type { SessionChannel } from '../../shared/lib/session-channel.ts'
import type { LoadedContent } from './editor-api.ts'
import type { SaveCoordinator, SaveRequest, SaveView } from './save-coordinator.ts'
import { DOCUMENT_PROFILES, PLATFORM_FORMAT_VERSIONS } from '@nerve-office/contracts'
import { ApiError, isAuthenticationError, setCsrfToken } from '../../shared/api/index.ts'
import { loginPath } from '../../shared/lib/login-path.ts'
import { createSaveCoordinator } from './save-coordinator.ts'

/** 载入的结果：就绪（可以编辑）、内容不存在或无权访问、格式不认识、请求失败、编辑器加载失败。 */
export type EditorPageLoad
  = | { readonly kind: 'loading' }
    | { readonly kind: 'ready', readonly title: string, readonly readOnly: boolean, readonly stage: SheetEditorLifecycle }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'unsupported' }
    | { readonly kind: 'failed', readonly error: unknown }
    | { readonly kind: 'editor-failed', readonly error: unknown }

/**
 * 本页的会话（P4 设计 §3.7.3，审查 B1）：
 * - active：本页的用户在登录中，可以保存；
 * - signed-out：登录已过期或在别处退出了。本页的修改还在，暂停保存；本页的用户在别的标签页重新登录之后恢复；
 * - other-user：别的标签页登录了另一个人。本页不能再保存（不把新会话的令牌交给这个页面）；原来的人登录回来之后恢复。
 * 两种情况都不自动跳转或重新加载：本页可能有未保存的修改。
 */
export type EditorPageSession = 'active' | 'signed-out' | 'other-user'

export interface EditorPageView {
  readonly load: EditorPageLoad
  /** 就绪、而且能编辑时才有 */
  readonly save: SaveView | undefined
  readonly session: EditorPageSession
}

export interface EditorPageApi {
  readonly session: () => Promise<SessionResponse>
  readonly document: (documentId: string) => Promise<DocumentDetail>
  readonly content: (documentId: string) => Promise<LoadedContent>
  readonly save: (documentId: string, request: SaveRequest) => Promise<SaveContentResponse>
}

export interface EditorPageOptions {
  /** 地址里的文档 id；地址不是编辑器页的写法时为 undefined，按不存在处理 */
  readonly documentId: string | undefined
  /** Univer 挂载的容器；页面的状态写在它的 data-editor-state 上（loading、ready、steady、failed），E2E 按它等待 */
  readonly surface: HTMLElement
  readonly api: EditorPageApi
  readonly createEditor: (options: CreateSheetEditorOptions) => Promise<SheetEditor>
  readonly page: PageLocation
  readonly sessionChannel: SessionChannel
  /** 当前的地址（路径与查询）：转到登录页时带上，登录之后回到这里 */
  readonly currentPath: () => string
  readonly newId: () => string
  /** 意外的错误：上报（浏览器的 reportError） */
  readonly reportError: (error: unknown) => void
}

export interface EditorPage {
  readonly view: () => EditorPageView
  readonly subscribe: (listener: () => void) => () => void
  readonly load: () => Promise<void>
  readonly save: () => Promise<void>
  /** 离开页面会丢掉内容（离开提示用） */
  readonly hasUnsavedWork: () => boolean
  /** 整页重新加载（版本冲突之后查看最新版本） */
  readonly reload: () => void
  readonly dispose: () => void
}

type SurfaceState = 'loading' | 'ready' | 'steady' | 'failed'

/** 本页认识的档案与格式版本；别的一律不进入编辑，也不改写（计划书 §8.7） */
function isKnownFormat(document: DocumentDetail): boolean {
  return (DOCUMENT_PROFILES as readonly string[]).includes(document.profile)
    && (PLATFORM_FORMAT_VERSIONS as readonly number[]).includes(document.formatVersion)
}

/** 读取时得到这些错误码：内容不存在或无权访问（两者相同，US-M1-08）；地址里的 id 不合法也按不存在处理 */
function isMissing(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'NOT_FOUND' || error.code === 'REQUEST_INVALID')
}

export function createEditorPage(options: EditorPageOptions): EditorPage {
  const { documentId, surface, api, page, sessionChannel } = options
  const listeners = new Set<() => void>()
  let load: EditorPageLoad = { kind: 'loading' }
  let session: EditorPageSession = 'active'
  let editor: SheetEditor | undefined
  let coordinator: SaveCoordinator | undefined
  let userId: string | undefined
  let disposed = false
  /** 正在整页转到别处：之后的事件都不再处理 */
  let leaving = false
  let checking = false
  let checkAgain = false
  const cleanups: (() => void)[] = []
  let current = computeView()

  function computeView(): EditorPageView {
    return { load, save: coordinator?.view(), session }
  }

  function update(): void {
    const next = computeView()
    if (next.load === current.load && next.save === current.save && next.session === current.session)
      return
    current = next
    for (const listener of [...listeners])
      listener()
  }

  function setSurface(state: SurfaceState): void {
    surface.dataset.editorState = state
    surface.hidden = state === 'failed'
  }

  function finish(result: Exclude<EditorPageLoad, { kind: 'loading' | 'ready' }>): void {
    load = result
    setSurface('failed')
    update()
  }

  /** 载入时未登录或登录已过期：还没有内容可丢，整页转到登录页，登录之后回到这里。转走之前不再带 CSRF 令牌 */
  function leaveToLogin(error: ApiError): void {
    if (leaving)
      return
    leaving = true
    setCsrfToken(undefined)
    page.replace(loginPath(options.currentPath(), error.code === 'SESSION_EXPIRED' ? 'expired' : 'required'))
  }

  function loadFailed(error: unknown): void {
    if (isAuthenticationError(error))
      leaveToLogin(error)
    else if (isMissing(error))
      finish({ kind: 'not-found' })
    else
      finish({ kind: 'failed', error })
  }

  function enterSession(next: EditorPageSession): void {
    session = next
    if (next === 'other-user')
      coordinator?.stop()
    else
      coordinator?.resume()
    update()
  }

  /** 保存得到未登录或登录已过期：暂停保存，本页的修改留着，等本页的用户重新登录（不整页跳转，审查 B1） */
  function signedOut(): void {
    setCsrfToken(undefined)
    if (session === 'active')
      enterSession('signed-out')
  }

  /**
   * 向服务端确认现在是谁：别的标签页登录或退出了、保存得到 CSRF_TOKEN_INVALID、暂停保存时又按了保存（ADR-008）。
   * 几次请求合并成一次，确认期间又有请求时结束后再确认一次（与平台页面相同）
   */
  async function recheckSession(): Promise<void> {
    if (leaving || disposed || userId === undefined)
      return
    if (checking) {
      checkAgain = true
      return
    }
    checking = true
    try {
      for (;;) {
        checkAgain = false
        await checkSessionOnce()
        if (!checkAgain || leaving || disposed)
          break
      }
    }
    finally {
      checking = false
    }
  }

  async function checkSessionOnce(): Promise<void> {
    let current: SessionResponse | undefined
    try {
      current = await api.session()
    }
    catch (error) {
      // 网络等失败：状态不变，下一次保存会显示错误
      if (!isAuthenticationError(error))
        return
    }
    if (disposed)
      return
    if (current === undefined) {
      signedOut()
    }
    else if (current.user.id === userId) {
      // 本页的用户（在别的标签页重新登录了）：换上新的令牌，恢复保存
      setCsrfToken(current.csrfToken)
      enterSession('active')
    }
    else {
      // 另一个人：新会话的令牌不交给这个页面，停止保存
      setCsrfToken(undefined)
      enterSession('other-user')
    }
  }

  function ready(document: DocumentDetail, created: SheetEditor, baseRevision: number): void {
    editor = created
    const readOnly = !document.permissions.canEdit
    if (readOnly) {
      created.setEditable(false)
    }
    else {
      coordinator = createSaveCoordinator({
        editor: created,
        send: async request => api.save(document.id, request),
        baseRevision,
        clientInstanceId: options.newId(),
        newRequestId: options.newId,
        onUnauthenticated: signedOut,
        onSessionStale: () => void recheckSession(),
        reportError: options.reportError,
      })
      cleanups.push(coordinator.subscribe(update))
    }
    const enter = (stage: SheetEditorLifecycle): void => {
      load = { kind: 'ready', title: document.title, readOnly, stage }
      // 渲染完成之后可以输入（ready）；steady 之后才判断"打开是否被判定为有修改"
      setSurface(stage === 'steady' ? 'steady' : 'ready')
      update()
    }
    cleanups.push(created.onLifecycle(enter))
    enter(created.lifecycle())
  }

  return {
    view: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load: async () => {
      if (documentId === undefined) {
        finish({ kind: 'not-found' })
        return
      }
      setSurface('loading')
      cleanups.push(sessionChannel.subscribe(() => void recheckSession()))
      let session: SessionResponse
      let document: DocumentDetail
      let content: LoadedContent
      try {
        // 先确认会话（拿到 CSRF 令牌），再并行读取元数据与内容（P4 设计 §3.7.1）
        session = await api.session()
        setCsrfToken(session.csrfToken)
        userId = session.user.id
        ;[document, content] = await Promise.all([api.document(documentId), api.content(documentId)])
      }
      catch (error) {
        if (!disposed)
          loadFailed(error)
        return
      }
      if (disposed)
        return
      if (!isKnownFormat(document)) {
        finish({ kind: 'unsupported' })
        return
      }
      let created: SheetEditor
      try {
        created = await options.createEditor({ container: surface, snapshot: content.snapshot })
      }
      catch (error) {
        if (!disposed)
          finish({ kind: 'editor-failed', error })
        return
      }
      if (disposed) {
        created.dispose()
        return
      }
      ready(document, created, content.revision)
    },
    save: async () => {
      if (coordinator === undefined)
        return
      // 暂停或停止保存时先向服务端确认一次：本页的用户可能已经在别处重新登录，广播的消息没有送到
      if (session !== 'active')
        await recheckSession()
      if (session === 'active')
        await coordinator.save()
    },
    hasUnsavedWork: () => coordinator?.hasUnsavedWork() ?? false,
    reload: () => page.reload(),
    dispose: () => {
      disposed = true
      for (const cleanup of cleanups.splice(0))
        cleanup()
      coordinator?.dispose()
      editor?.dispose()
      listeners.clear()
    },
  }
}
