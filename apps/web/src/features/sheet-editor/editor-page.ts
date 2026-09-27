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
 * - signed-out：登录已过期或在别处退出了，现在没有人登录。本页的修改还在，暂停保存；本页的用户在别的标签页重新登录之后恢复；
 * - other-user：别的标签页登录了另一个人。本页不能再保存（不把新会话的令牌交给这个页面）；原来的人登录回来之后恢复，
 *   另一个人也退出之后按 signed-out 处理（复验 RB7）。
 * 两种情况都不自动跳转或重新加载：本页可能有未保存的修改。
 */
export type EditorPageSession = 'active' | 'signed-out' | 'other-user'

export interface EditorPageView {
  readonly load: EditorPageLoad
  /** 就绪、而且能编辑时才有 */
  readonly save: SaveView | undefined
  readonly session: EditorPageSession
  /**
   * 最近一次向服务端确认会话失败的原因（网络错误等）；确认成功之后清掉。会话不是 active 时显示在会话的提示里（复验 RB7）；
   * 是 active、而保存因为令牌失效或未登录失败时显示在保存失败的说明里：令牌没有换成，不能说"再保存一次"就好（复验 TB1）
   */
  readonly sessionProblem: unknown
  /**
   * 与保存有关的会话确认进行中（保存得到未登录或令牌失效、按保存时要先确认）：页头说明正在确认，按钮不可用，
   * 会话类的保存失败等确认有了结果再显示（复验 SB5、TB1）
   */
  readonly confirmingSession: boolean
}

export interface EditorPageApi {
  readonly session: () => Promise<SessionResponse>
  readonly document: (documentId: string) => Promise<DocumentDetail>
  readonly content: (documentId: string) => Promise<LoadedContent>
  /** 压缩快照（gzip）：本地的一步 */
  readonly compress: (snapshot: string) => Promise<Uint8Array<ArrayBuffer>>
  readonly save: (documentId: string, request: SaveRequest, body: Uint8Array<ArrayBuffer>) => Promise<SaveContentResponse>
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
  /** 进行中的会话确认（含确认期间又要求的那一轮）：按保存时等它结束（复验 RB1） */
  let checkInFlight: Promise<void> | undefined
  let checkAgain = false
  /** 载入时还不知道本页的用户就收到了会话消息：知道之后再确认一次（复验 RB7） */
  let checkWhenLoaded = false
  /** 保存得到未登录、确认还没有结果：确认时断网也按没有人登录显示（复验 SB4） */
  let unauthenticatedPending = false
  let sessionProblem: unknown
  let confirmingSession = false
  const cleanups: (() => void)[] = []
  let current = computeView()

  function computeView(): EditorPageView {
    return { load, save: coordinator?.view(), session, sessionProblem, confirmingSession }
  }

  function update(): void {
    const next = computeView()
    if (next.load === current.load && next.save === current.save && next.session === current.session
      && next.sessionProblem === current.sessionProblem && next.confirmingSession === current.confirmingSession) {
      return
    }
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
    const previous = session
    session = next
    if (next === 'other-user')
      coordinator?.stop()
    else
      coordinator?.resume()
    // 从未登录或换了人回到本人：之前"登录已过期""请求已失效"这类失败的说明不再成立（复验 RB2）。
    // 一直是本人时保留：用户按了保存，要看到这次没有保存成功（页头提示再保存一次，令牌已经换好，复验 SB1）
    if (next === 'active' && previous !== 'active')
      coordinator?.dismissSessionProblem()
    update()
  }

  /** 确认会话得到未登录或登录已过期：现在没有人登录。暂停保存，本页的修改留着，等本页的用户重新登录（不整页跳转，审查 B1） */
  function signedOut(): void {
    setCsrfToken(undefined)
    if (session !== 'signed-out')
      enterSession('signed-out')
  }

  /**
   * 向服务端确认现在是谁：别的标签页登录或退出了、保存得到未登录或 CSRF_TOKEN_INVALID、暂停保存时又按了保存（ADR-008）。
   * 几次请求合并成一次，确认期间又有请求时结束后再确认一次（与平台页面相同）；返回的 Promise 在这些都结束之后完成（复验 RB1）
   */
  async function recheckSession(): Promise<void> {
    if (leaving || disposed)
      return
    if (userId === undefined) {
      checkWhenLoaded = true
      return
    }
    if (checkInFlight !== undefined) {
      checkAgain = true
      return checkInFlight
    }
    const run = async (): Promise<void> => {
      try {
        for (;;) {
          checkAgain = false
          await checkSessionOnce()
          if (!checkAgain || leaving || disposed)
            break
        }
      }
      finally {
        checkInFlight = undefined
        // 与保存有关的确认结束：会话的结果已经更新，这时才显示会话类的保存失败（复验 TB1）
        if (confirmingSession) {
          confirmingSession = false
          update()
        }
      }
    }
    checkInFlight = run()
    return checkInFlight
  }

  /**
   * 与保存有关的会话确认：进行中页头说明正在确认（复验 SB5、TB1）。trigger 为真时是保存失败触发的新的确认
   * （确认期间又要求的，结束后再确认一次）；否则是按了保存：有确认在途就等它，不另起一轮
   */
  async function confirmForSave(trigger: boolean): Promise<void> {
    const confirming = trigger || checkInFlight === undefined ? recheckSession() : checkInFlight
    if (checkInFlight !== undefined && !confirmingSession) {
      confirmingSession = true
      update()
    }
    return confirming
  }

  async function checkSessionOnce(): Promise<void> {
    let current: SessionResponse | undefined
    try {
      current = await api.session()
    }
    catch (error) {
      // 网络等失败：会话的状态不变；会话不是 active 时页面说明确认失败的原因（复验 RB7）。
      // 保存刚得到未登录时按没有人登录显示（不清令牌），页面给出登录的入口；下一次确认会纠正过来（复验 SB4）
      if (!isAuthenticationError(error)) {
        if (!disposed) {
          sessionProblem = error
          if (unauthenticatedPending && session === 'active')
            enterSession('signed-out')
          update()
        }
        return
      }
    }
    if (disposed)
      return
    unauthenticatedPending = false
    sessionProblem = undefined
    // 原因清掉之后要刷新：会话的状态可能没变（例如一直是未登录，复验 SB2）
    update()
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
        compress: api.compress,
        send: async (request, body) => api.save(document.id, request, body),
        baseRevision,
        clientInstanceId: options.newId(),
        newRequestId: options.newId,
        // 保存得到未登录：先向服务端确认（回包可能是本人在别处重新登录之前发出的那次保存的，不能据此清掉新的令牌，复验 RB7）
        onUnauthenticated: () => {
          unauthenticatedPending = true
          void confirmForSave(true)
        },
        onSessionStale: () => void confirmForSave(true),
        reportError: options.reportError,
      })
      // 创建编辑器期间别的标签页换了人：保存状态机一建好就停住（复验 RB3）
      if (session === 'other-user')
        coordinator.stop()
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
        // 确认会话的回包之前别的标签页登录或退出了：消息当时没法处理，现在补确认一次
        if (checkWhenLoaded)
          void recheckSession()
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
      // 保存中、版本冲突之后再按：不做任何事（P4 设计 §3.7.2）；不因为有确认在途就把"保存中"换成"正在确认"（复验 TB9）
      const { status } = coordinator.view()
      if (status === 'saving' || status === 'conflict')
        return
      // 确认会话进行中（别的标签页的消息、保存得到未登录或 CSRF 失效触发的）：等它结束，按确认的结果决定（复验 RB1）；
      // 暂停或停止保存时、上一次确认失败时（令牌可能没有换成，复验 TB1）先向服务端确认一次：本页的用户可能已经在别处重新登录，广播的消息没有送到
      if (checkInFlight !== undefined || session !== 'active' || sessionProblem !== undefined)
        await confirmForSave(false)
      // 等确认期间页面卸载了：不再捕获与上传（复验 SB6）
      if (session === 'active' && !disposed)
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
