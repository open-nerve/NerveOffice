// 编辑器页（P4 设计 §3.7）：载入、会话与页头的编排。阅读与编辑、编辑权与保存交给 edit-mode.ts（M3-P2 设计 §3.4）；
// 界面（editor-chrome.tsx）只订阅这里的状态。编辑器在 React 之外创建：一页一份文档，模式切换一律重建（M3-P2 设计 §3.1）。
// 打开即阅读：载入之后以只读创建；地址带 ?edit=new（新建表格之后的跳转）而且能编辑时直接进入编辑，进入之后去掉这个参数。
// 交互屏障：载入期间、进入与退出编辑、失去编辑权的过程中，以及每次新建编辑器时，页头之外的输入一律拦下（interaction-barrier.ts）。
import type { DocumentAccessVia, DocumentDetail, DocumentSpace, SessionResponse } from '@nerve-office/contracts'
import type { ApiError } from '../../shared/api/index.ts'
import type { PageLocation } from '../../shared/lib/page-location.ts'
import type { SessionChannel } from '../../shared/lib/session-channel.ts'
import type { LeaseClock } from './edit-lease.ts'
import type { EditMode, EditModeApi, EditModeState } from './edit-mode.ts'
import type { LoadedContent } from './editor-api.ts'
import type { CreateModeEditor } from './editor-slot.ts'
import type { PageVisibility } from './reading-checks.ts'
import type { SaveView } from './save-coordinator.ts'
import { DOCUMENT_PROFILES, PLATFORM_FORMAT_VERSIONS } from '@nerve-office/contracts'
import { isAuthenticationError, isMissingResource, setCsrfToken } from '../../shared/api/index.ts'
import { loginPath } from '../../shared/lib/login-path.ts'
import { documentIsNewer } from './client-format.ts'
import { trackActivity } from './edit-lease.ts'
import { createEditMode } from './edit-mode.ts'
import { blockInteractions } from './interaction-barrier.ts'

/**
 * 就绪时页头要的东西：标题与所在的空间（返回链接）、看得到它的途径（只凭授权时返回"与我共享"，M2-P5）、能不能分享（分享的入口）、
 * 看这一页的人（分享时排除自己）。都随 refreshDetail 更新。阅读还是编辑、能不能编辑在 mode 里（edit-mode.ts）
 */
export interface EditorPageReady {
  readonly kind: 'ready'
  readonly documentId: string
  readonly title: string
  readonly space: DocumentSpace
  readonly accessVia: DocumentAccessVia
  readonly canShare: boolean
  readonly userId: string
}

/** 载入的结果：就绪、内容不存在或无权访问、格式不认识、请求失败、编辑器加载失败（之后的重建失败也是它） */
export type EditorPageLoad
  = | { readonly kind: 'loading' }
    | EditorPageReady
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
  /** 阅读还是编辑、编辑权怎样了（载入之后才有） */
  readonly mode: EditModeState | undefined
  /** 编辑时（与退出编辑的过程中）才有：保存的状态 */
  readonly save: SaveView | undefined
  readonly session: EditorPageSession
  /**
   * 最近一次向服务端确认会话失败的原因（网络错误等）；确认成功之后清掉。会话不是 active 时显示在会话的提示里（复验 RB7）；
   * 是 active、而保存因为令牌失效或未登录失败时显示在保存失败的说明里：令牌没有换成，不能说"再保存一次"就好（复验 TB1）
   */
  readonly sessionProblem: unknown
  /**
   * 写的操作要等的会话确认进行中（保存得到未登录或令牌失效；按保存、退出编辑、点"编辑"时要先确认，审查 A10）：页头说明正在确认，
   * 按钮不可用（阅读时的"编辑"也是，复验 C8），会话类的保存失败等确认有了结果再显示（复验 SB5、TB1）
   */
  readonly confirmingSession: boolean
  /** 页头的文档详情没能刷新（DEF-040）：原因；页头留着之前的信息，可以重试。成功之后清掉 */
  readonly detailProblem: unknown
  /**
   * 编辑器容器的状态（与 data-editor-state 相同）：loading 是载入或换编辑器期间（交互屏障挂着），ready 是渲染完成，steady 是
   * 渲染完成之后 3 秒，failed 是没有编辑器。测试构建的页面自检按它等到 steady（selftest-hook.ts）
   */
  readonly surface: EditorSurfaceState
}

export interface EditorPageApi extends EditModeApi {
  readonly session: () => Promise<SessionResponse>
  readonly document: (documentId: string) => Promise<DocumentDetail>
}

/** 地址里"新建之后直接编辑"的标记（?edit=new）：进入编辑之后去掉，刷新不再自动进入 */
export interface EditIntent {
  readonly requested: boolean
  readonly clear: () => void
}

export interface EditorPageOptions {
  /** 地址里的文档 id；地址不是编辑器页的写法时为 undefined，按不存在处理 */
  readonly documentId: string | undefined
  /** Univer 挂载的容器；页面的状态写在它的 data-editor-state 上（loading、ready、steady、failed），E2E 按它等待 */
  readonly surface: HTMLElement
  /** 页头：交互屏障挂着时只有它可以交互（interaction-barrier.ts） */
  readonly chrome: HTMLElement
  readonly api: EditorPageApi
  /** 新建编辑器（适配层的 createSheetEditor）：容器由这里绑定 */
  readonly createEditor: (options: Parameters<CreateModeEditor>[0] & { readonly container: HTMLElement }) => ReturnType<CreateModeEditor>
  readonly page: PageLocation
  readonly sessionChannel: SessionChannel
  /** 单调的"现在"与计时器：编辑租约的心跳、阅读时的检查 */
  readonly clock: LeaseClock
  /** 页面的可见性：隐藏时暂停阅读时的检查 */
  readonly visibility: PageVisibility
  readonly editIntent: EditIntent
  /** 当前的地址（路径与查询）：转到登录页时带上，登录之后回到这里 */
  readonly currentPath: () => string
  readonly newId: () => string
  /** 现在的墙上时间（另存为副本的标题） */
  readonly now: () => Date
  /** 意外的错误：上报（浏览器的 reportError） */
  readonly reportError: (error: unknown) => void
}

export interface EditorPage {
  readonly view: () => EditorPageView
  readonly subscribe: (listener: () => void) => () => void
  readonly load: () => Promise<void>
  readonly save: () => Promise<void>
  /** "编辑"：会话是本人时申请编辑权，重建为可编辑 */
  readonly enterEditing: () => Promise<void>
  /** "退出编辑"：先保存，释放编辑权，重建为只读 */
  readonly exitEditing: () => Promise<void>
  /** "有更新，点击刷新" */
  readonly refreshUpdate: () => Promise<void>
  /** 失去编辑权之后：另存为副本 */
  readonly saveCopy: () => Promise<void>
  /** 失去编辑权之后：放弃本页的修改（或重新加载），按服务端的最新内容重建为阅读 */
  readonly discard: () => Promise<void>
  /** 离开页面会丢掉内容（离开提示用） */
  readonly hasUnsavedWork: () => boolean
  /** 整页重新加载（版本冲突之后、编辑器加载失败之后） */
  readonly reload: () => void
  /**
   * 重新取一次文档详情，更新页头（M2-P5：分享对话框里的写操作结果未知或被拒绝之后；DEF-040 的重试）：标题、所在的空间、途径与
   * 能不能分享，阅读时能不能编辑随之更新。看不到了（404）时不再能分享。别的失败页头留着之前的信息、说明没能刷新、可以重试。不抛出
   */
  readonly refreshDetail: () => Promise<void>
  /**
   * 向服务端确认现在是谁（页头上别的请求得到未登录或令牌失效时，例如分享对话框里的请求）：与别的标签页登录或退出时同一个确认，
   * 会话的提示随之更新，同一个人时换上新的令牌
   */
  readonly recheckSession: () => Promise<void>
  /** 停止计时器，尽力释放编辑权，销毁编辑器 */
  readonly dispose: () => void
}

export type EditorSurfaceState = 'loading' | 'ready' | 'steady' | 'failed'

/** 本页认识的档案与格式版本；别的一律不进入编辑，也不改写（计划书 §8.7） */
function isKnownFormat(document: DocumentDetail): boolean {
  return (DOCUMENT_PROFILES as readonly string[]).includes(document.profile)
    && (PLATFORM_FORMAT_VERSIONS as readonly number[]).includes(document.formatVersion)
}

/** 页头的信息里随文档详情更新的部分 */
type EditorHeading = Omit<EditorPageReady, 'kind'>

function headingOf(document: DocumentDetail, userId: string): EditorHeading {
  return { documentId: document.id, title: document.title, space: document.space, accessVia: document.accessVia, canShare: document.permissions.canShare, userId }
}

/** 这些状态里编辑器在换（或正要换）：交互屏障挂着 */
function switching(mode: EditModeState): boolean {
  return mode.kind === 'opening' || mode.kind === 'entering' || mode.kind === 'exiting' || mode.kind === 'losing'
}

export function createEditorPage(options: EditorPageOptions): EditorPage {
  const { documentId, surface, api, page, sessionChannel, clock } = options
  const listeners = new Set<() => void>()
  let load: EditorPageLoad = { kind: 'loading' }
  let session: EditorPageSession = 'active'
  let userId: string | undefined
  /** 本页这次加载的标识（P1 设计 §3.2）：编辑租约绑定它，保存也带着它（认出"自己追自己"），两处是同一个 */
  const clientInstanceId = options.newId()
  /** 阅读与编辑（载入之后才有） */
  let mode: EditMode | undefined
  /** 本页最后一次键盘、鼠标操作的时刻（单调的时钟）：心跳上报"多久没有操作" */
  let lastActivity = clock.now()
  /** 页头的信息（载入了详情之后才有）：refreshDetail 更新它 */
  let heading: EditorHeading | undefined
  let detailProblem: unknown
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
  /** 已经开始的确认的轮数（每向服务端确认一次加一） */
  let checksStarted = 0
  /**
   * 保存得到令牌失效时已经开始的确认轮数：本页的令牌已知不对，不带着它再发保存（复验 UB1）。
   * 只有在它之后开始、成功了的确认才能清掉它：更早开始的那轮回包可能早于令牌的更换（复验 VB1）
   */
  let staleAfter: number | undefined
  let sessionProblem: unknown
  let confirmingSession = false
  const cleanups: (() => void)[] = []
  /** 交互屏障：撤掉它的函数 */
  let releaseBarrier: (() => void) | undefined
  /** 编辑器容器的状态（写在容器的 data-editor-state 上） */
  let surfaceState: EditorSurfaceState = 'loading'
  let current = computeView()

  function computeView(): EditorPageView {
    const modeView = mode?.view()
    return { load, mode: modeView?.mode, save: modeView?.save, session, sessionProblem, confirmingSession, detailProblem, surface: surfaceState }
  }

  function update(): void {
    const next = computeView()
    const changed = (Object.keys(next) as (keyof EditorPageView)[]).some(key => next[key] !== current[key])
    if (!changed)
      return
    current = next
    for (const listener of [...listeners])
      listener()
  }

  /**
   * 编辑器容器的状态与交互屏障（Codex 评审 CX1，独立复验 N1）：载入、换编辑器期间（loading）页头之外的输入一律拦下，包括
   * Univer 挂在 body 下的浮层；编辑器就绪（ready、steady）或失败时撤掉
   */
  function setSurface(state: EditorSurfaceState): void {
    surfaceState = state
    surface.dataset.editorState = state
    surface.hidden = state === 'failed'
    if (state === 'loading') {
      releaseBarrier ??= blockInteractions(options.chrome)
    }
    else {
      releaseBarrier?.()
      releaseBarrier = undefined
    }
  }

  function finish(result: Exclude<EditorPageLoad, { kind: 'loading' | 'ready' }>): void {
    load = result
    setSurface('failed')
    update()
  }

  /**
   * 阅读与编辑的状态变了：编辑器换掉了就挂上屏障，就绪了就撤掉；编辑器建不起来、读不到了按载入失败说明。
   * 没有编辑器、也没有在换（失去编辑权之后以只读重建失败，审查 A3）：容器按 failed 隐藏、撤掉屏障，页头照常（说明与另存为副本）
   */
  function modeChanged(): void {
    const view = mode?.view()
    if (view === undefined || disposed)
      return
    if (view.mode.kind === 'failed') {
      if (load.kind !== 'editor-failed')
        finish({ kind: 'editor-failed', error: view.mode.error })
      return
    }
    if (view.mode.kind === 'unavailable') {
      if (load.kind !== 'not-found')
        finish({ kind: 'not-found' })
      return
    }
    if (switching(view.mode) || view.surface === 'creating')
      setSurface('loading')
    else if (view.surface === 'none')
      setSurface('failed')
    else
      setSurface(view.surface === 'steady' ? 'steady' : 'ready')
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
    // 内容不存在或无权访问（两者相同，US-M1-08）；地址里的 id 不合法也按不存在处理
    else if (isMissingResource(error))
      finish({ kind: 'not-found' })
    else
      finish({ kind: 'failed', error })
  }

  function enterSession(next: EditorPageSession): void {
    session = next
    mode?.setSession(next)
    update()
  }

  /** 编辑权与另存为副本的请求得到未登录或令牌失效：向服务端确认现在是谁（不显示"正在确认"：不是用户按了保存） */
  function writeProblem(error: ApiError): void {
    if (isAuthenticationError(error))
      unauthenticatedPending = true
    else
      staleAfter = checksStarted
    void recheckSession()
  }

  /** 确认会话得到未登录或登录已过期：现在没有人登录。暂停保存，本页的修改留着，等本页的用户重新登录（不整页跳转，审查 B1） */
  function signedOut(): void {
    setCsrfToken(undefined)
    if (session !== 'signed-out')
      enterSession('signed-out')
  }

  /**
   * 向服务端确认现在是谁：别的标签页登录或退出了、请求得到未登录或 CSRF_TOKEN_INVALID、暂停保存时又按了保存（ADR-008）。
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
   * 写的操作要等的会话确认：进行中页头说明正在确认（复验 SB5、TB1、C8）。trigger 为真时是保存失败触发的新的确认
   * （确认期间又要求的，结束后再确认一次）；否则是要写（按保存、退出编辑、点"编辑"）：有确认在途就等它，不另起一轮
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
    const round = ++checksStarted
    let confirmed: SessionResponse | undefined
    try {
      confirmed = await api.session()
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
    // 确认成功：令牌按确认的结果换上或清掉，不再是已知失效的那个（这轮开始于令牌被标为失效之后）
    unauthenticatedPending = false
    if (staleAfter !== undefined && round > staleAfter)
      staleAfter = undefined
    sessionProblem = undefined
    // 原因清掉之后要刷新：会话的状态可能没变（例如一直是未登录，复验 SB2）
    update()
    if (confirmed === undefined) {
      signedOut()
    }
    else if (confirmed.user.id === userId) {
      // 本页的用户（在别的标签页重新登录了）：换上新的令牌，恢复保存与阅读时的检查
      setCsrfToken(confirmed.csrfToken)
      enterSession('active')
      // 编辑权绑定登录（P1 设计 §3.4.1）：登录可能换过（重新登录、换令牌），恢复续租并立即核对一次——失效时随即说明、停止保存。
      // 确认在它有了结果之后才算结束：按保存时等的是这一步，不带着已经失效的编辑权去保存
      await mode?.resumeLease()
    }
    else {
      // 另一个人：新会话的令牌不交给这个页面，停止保存
      setCsrfToken(undefined)
      enterSession('other-user')
    }
  }

  /**
   * 要写的操作（保存、进入与退出编辑）之前：确认会话进行中（别的标签页的消息、保存得到未登录或 CSRF 失效触发的）就等它结束，按确认的结果决定
   * （复验 RB1）；暂停或停止保存时、上一次确认失败时（令牌可能没有换成，复验 TB1）先向服务端确认一次：本页的用户可能已经在别处重新登录，
   * 广播的消息没有送到。令牌已知失效时一定先确认（复验 VB1）。返回能不能接着做：会话是本人、页面还在、令牌不是已知失效的（复验 UB1）
   */
  async function readyToWrite(): Promise<boolean> {
    if (!confirmedForWrite())
      await confirmForSave(false)
    return session === 'active' && !disposed && staleAfter === undefined
  }

  /** 不必先向服务端确认就能写：没有确认在途、会话是本人、上一次确认没有失败、令牌不是已知失效的 */
  function confirmedForWrite(): boolean {
    return checkInFlight === undefined && session === 'active' && sessionProblem === undefined && staleAfter === undefined
  }

  function createMode(id: string): EditMode {
    const created = createEditMode({
      documentId: id,
      clientInstanceId,
      api,
      createEditor: async editorOptions => options.createEditor({ ...editorOptions, container: surface }),
      clock,
      visibility: options.visibility,
      lastActivity: () => lastActivity,
      newId: options.newId,
      now: options.now,
      title: () => heading?.title ?? '',
      session: {
        // 保存得到未登录：先向服务端确认（回包可能是本人在别处重新登录之前发出的那次保存的，不能据此清掉新的令牌，复验 RB7）
        saveUnauthenticated: () => {
          unauthenticatedPending = true
          void confirmForSave(true)
        },
        saveStale: () => {
          staleAfter = checksStarted
          void confirmForSave(true)
        },
        writeProblem,
        readProblem: () => void recheckSession(),
      },
      reportError: options.reportError,
    })
    cleanups.push(created.subscribe(modeChanged))
    return created
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
      // 本页的键盘、鼠标操作（捕获阶段）：心跳据此上报多久没有操作。挂在交互屏障之前，载入期间被拦下的输入也算有操作。
      // 页面隐藏、关闭时尽力释放编辑权（keepalive，结果不管）
      const pageWindow = options.chrome.ownerDocument.defaultView ?? window
      cleanups.push(trackActivity(pageWindow, () => {
        lastActivity = clock.now()
        mode?.noteActivity()
      }))
      const onPageHide = (): void => mode?.releaseOnHide()
      pageWindow.addEventListener('pagehide', onPageHide)
      cleanups.push(() => pageWindow.removeEventListener('pagehide', onPageHide))
      setSurface('loading')
      cleanups.push(sessionChannel.subscribe(() => void recheckSession()))
      let signedIn: SessionResponse
      let document: DocumentDetail
      let content: LoadedContent
      try {
        // 先确认会话（拿到 CSRF 令牌），再并行读取元数据与内容（P4 设计 §3.7.1）
        signedIn = await api.session()
        setCsrfToken(signedIn.csrfToken)
        userId = signedIn.user.id
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
      heading = headingOf(document, signedIn.user.id)
      const opened = createMode(documentId)
      mode = opened
      // 载入期间别的标签页换了人或者退出了：按确认的结果开始（不是本人时不续租、不检查）
      opened.setSession(session)
      const canEdit = document.permissions.canEdit
      // 这份文档由比本页新的版本写过（服务端回滚之后，M3-P3 设计 §3.5）：一开始就只能阅读、说明，不直接进入编辑
      const blocked = documentIsNewer(document) ? 'document-too-new' : undefined
      const outcome = await opened.open({ snapshot: content.snapshot, revision: content.revision, canEdit }, { enterEdit: options.editIntent.requested && canEdit, blocked })
      if (disposed)
        return
      if (outcome.kind === 'load-failed') {
        loadFailed(outcome.error)
        return
      }
      if (outcome.kind === 'editor-failed')
        return
      // 刚由自己新建的表格进入了编辑：去掉地址里的标记，刷新不再自动进入
      if (outcome.entered)
        options.editIntent.clear()
      load = { kind: 'ready', ...heading }
      modeChanged()
    },
    save: async () => {
      const view = mode?.view()
      if (view?.mode.kind !== 'editing' || view.save === undefined)
        return
      // 保存中、版本冲突之后再按：不做任何事（P4 设计 §3.7.2）；不因为有确认在途就把"保存中"换成"正在确认"（复验 TB9）
      if (view.save.status === 'saving' || view.save.status === 'conflict')
        return
      if (await readyToWrite())
        await mode?.save()
    },
    enterEditing: async () => {
      if (mode?.view().mode.kind !== 'reading')
        return
      // 进入编辑要申请编辑权（写的操作）：与保存、退出编辑同一个会话确认——没有人登录、换了人、令牌已知失效时不申请，
      // 免得先得到一次"没能进入编辑"（审查 A10）。不必确认时在点下去的这一刻就开始（"正在进入编辑"与交互屏障随之就有）
      if (!confirmedForWrite() && !(await readyToWrite()))
        return
      await mode.enter()
    },
    exitEditing: async () => {
      if (mode?.view().mode.kind !== 'editing')
        return
      // 退出要先保存：与按保存同一个会话确认（换了人、令牌已知失效时不发，留在编辑）
      if (await readyToWrite())
        await mode.exit()
    },
    refreshUpdate: async () => {
      await mode?.refresh()
    },
    saveCopy: async () => {
      await mode?.saveCopy()
    },
    discard: async () => {
      await mode?.discard()
    },
    hasUnsavedWork: () => mode?.hasUnsavedWork() ?? false,
    reload: () => page.reload(),
    refreshDetail: async () => {
      if (documentId === undefined || heading === undefined || disposed)
        return
      let document: DocumentDetail
      try {
        document = await api.document(documentId)
      }
      catch (error) {
        if (disposed || heading === undefined)
          return
        // 看不到了（已经删除、移走，或者自己被移出、授权被取消）：不再能分享。未登录交给会话的确认（页头随之说明）；
        // 别的失败：页头留着之前的信息，说明没能刷新、可以重试（DEF-040，与列表的"没能刷新"同一个说法）
        if (isMissingResource(error)) {
          heading = { ...heading, canShare: false }
          detailProblem = undefined
        }
        else if (isAuthenticationError(error)) {
          void recheckSession()
          return
        }
        else {
          detailProblem = error
        }
        if (load.kind === 'ready')
          load = { kind: 'ready', ...heading }
        update()
        return
      }
      if (disposed || heading === undefined)
        return
      heading = headingOf(document, heading.userId)
      detailProblem = undefined
      mode?.updateCanEdit(document.permissions.canEdit)
      if (load.kind === 'ready')
        load = { kind: 'ready', ...heading }
      update()
    },
    recheckSession,
    dispose: () => {
      disposed = true
      releaseBarrier?.()
      releaseBarrier = undefined
      for (const cleanup of cleanups.splice(0))
        cleanup()
      mode?.dispose()
      listeners.clear()
    },
  }
}
