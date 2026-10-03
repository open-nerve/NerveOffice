// 编辑器页（P4 设计 §3.7）：载入、保存、会话；编辑租约（M3-P1 设计 §3.4.7）。界面（editor-chrome.tsx）只订阅这里的状态；
// 编辑器在 React 之外创建：一页一份文档，整页加载与卸载，不随组件的挂载与卸载反复创建（计划书 §10.2）。
// 能编辑时载入之后就申请编辑权（P2 改为打开即阅读、点"编辑"才申请，租约的管理在 edit-lease.ts，原样复用）：
// 取得了按可编辑创建编辑器，被占用按只读创建并说明谁在编辑；编辑权中断时自动续上（期间没人保存过），续不上、失去访问或编辑权时
// 停止保存、说明原因；关闭页面时尽力释放。
import type { DocumentAccessVia, DocumentDetail, DocumentSpace, SaveContentResponse, SessionResponse } from '@nerve-office/contracts'
import type { CreateSheetEditorOptions, SheetEditor, SheetEditorLifecycle } from '../../editor/index.ts'
import type { ApiError } from '../../shared/api/index.ts'
import type { PageLocation } from '../../shared/lib/page-location.ts'
import type { SessionChannel } from '../../shared/lib/session-channel.ts'
import type { EditLease, EditLeaseApi, LeaseAcquisition, LeaseClock, LeaseHolder, LeaseLoss } from './edit-lease.ts'
import type { LeaseCredentials, LoadedContent } from './editor-api.ts'
import type { SaveCoordinator, SaveRequest, SaveView } from './save-coordinator.ts'
import { DOCUMENT_PROFILES, PLATFORM_FORMAT_VERSIONS } from '@nerve-office/contracts'
import { isAuthenticationError, isMissingResource, isPermissionDeniedError, setCsrfToken } from '../../shared/api/index.ts'
import { loginPath } from '../../shared/lib/login-path.ts'
import { acquireEditLease, leaseLossOf, trackActivity } from './edit-lease.ts'
import { blockInteractions } from './interaction-barrier.ts'
import { createSaveCoordinator } from './save-coordinator.ts'

/**
 * 就绪时页头要的东西：标题与所在的空间（返回链接）、看得到它的途径（只凭授权时返回"与我共享"，M2-P5）、能不能分享（分享的入口）、
 * 看这一页的人（分享时排除自己）。标题、空间、途径与能不能分享会随 refreshDetail 更新；能不能编辑（readOnly）在创建编辑器时就定了，不变：
 * 只能查看、申请编辑权被占用或刚失去编辑权（403）时为真
 */
export interface EditorPageReady {
  readonly kind: 'ready'
  readonly documentId: string
  readonly title: string
  readonly space: DocumentSpace
  readonly accessVia: DocumentAccessVia
  readonly canShare: boolean
  readonly userId: string
  readonly readOnly: boolean
  readonly stage: SheetEditorLifecycle
}

/** 载入的结果：就绪（可以编辑）、内容不存在或无权访问、格式不认识、请求失败、编辑器加载失败。 */
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

/**
 * 本页的编辑权（M3-P1 设计 §3.4.7）：
 * - none：不涉及编辑权——载入中、载入失败、只能查看，或者申请时刚失去编辑权（403，按只读）；
 * - editing：本页持有编辑权，可以编辑与保存；
 * - elsewhere：别人（或者自己在另一个标签页、设备上）正在编辑，本页按只读创建。holder 是服务端给出的持有者，认不出时为 undefined；
 * - lost：编辑权失效（续租或保存得知），保存停止，loss 是失效的来源。P2 在这里接上"续上"与"另存为副本"
 */
export type EditorEditing
  = | { readonly kind: 'none' }
    | { readonly kind: 'editing' }
    | { readonly kind: 'elsewhere', readonly holder: LeaseHolder | undefined }
    | { readonly kind: 'lost', readonly loss: LeaseLoss }

export interface EditorPageView {
  readonly load: EditorPageLoad
  /** 就绪、而且持有编辑权时才有（失效之后仍在，停止保存） */
  readonly save: SaveView | undefined
  readonly editing: EditorEditing
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
  /** 保存：带上编辑租约的令牌与代次（M3-P1 设计 §3.4.4） */
  readonly save: (documentId: string, request: SaveRequest, body: Uint8Array<ArrayBuffer>, lease: LeaseCredentials) => Promise<SaveContentResponse>
  /** 编辑权：申请、心跳续租、释放 */
  readonly editLease: EditLeaseApi
}

export interface EditorPageOptions {
  /** 地址里的文档 id；地址不是编辑器页的写法时为 undefined，按不存在处理 */
  readonly documentId: string | undefined
  /** Univer 挂载的容器；页面的状态写在它的 data-editor-state 上（loading、ready、steady、failed），E2E 按它等待 */
  readonly surface: HTMLElement
  /** 页头：载入期间只有它可以交互，其余的用户输入都被交互屏障拦下（interaction-barrier.ts） */
  readonly chrome: HTMLElement
  readonly api: EditorPageApi
  readonly createEditor: (options: CreateSheetEditorOptions) => Promise<SheetEditor>
  readonly page: PageLocation
  readonly sessionChannel: SessionChannel
  /** 编辑租约的时钟（单调的"现在"与计时器）：心跳、空闲的秒数、被占用时的再试 */
  readonly clock: LeaseClock
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
  /** 离开页面会丢掉内容（离开提示用；编辑权失效之后照旧按有没有未保存的修改） */
  readonly hasUnsavedWork: () => boolean
  /** 整页重新加载（版本冲突、编辑权失效之后查看最新版本） */
  readonly reload: () => void
  /**
   * 重新取一次文档详情，更新页头（M2-P5：分享对话框里的写操作结果未知或被拒绝之后）：标题、所在的空间、途径与能不能分享；
   * 看不到了（404）时不再能分享。能不能编辑不变（编辑器已经按打开时的权限创建，保存时由服务端再判断）。失败时页头不变，不抛出
   */
  readonly refreshDetail: () => Promise<void>
  /**
   * 向服务端确认现在是谁（页头上别的请求得到未登录或令牌失效时，例如分享对话框里的请求）：与别的标签页登录或退出时同一个确认，
   * 会话的提示随之更新，同一个人时换上新的令牌
   */
  readonly recheckSession: () => Promise<void>
  /** 停止心跳与计时器，尽力释放编辑权，销毁编辑器 */
  readonly dispose: () => void
}

type SurfaceState = 'loading' | 'ready' | 'steady' | 'failed'

/** 本页认识的档案与格式版本；别的一律不进入编辑，也不改写（计划书 §8.7） */
function isKnownFormat(document: DocumentDetail): boolean {
  return (DOCUMENT_PROFILES as readonly string[]).includes(document.profile)
    && (PLATFORM_FORMAT_VERSIONS as readonly number[]).includes(document.formatVersion)
}

/** 就绪时页头的信息里随文档详情更新的部分（见 EditorPageReady） */
type EditorHeading = Pick<EditorPageReady, 'documentId' | 'title' | 'space' | 'accessVia' | 'canShare' | 'userId'>

function headingOf(document: DocumentDetail, userId: string): EditorHeading {
  return { documentId: document.id, title: document.title, space: document.space, accessVia: document.accessVia, canShare: document.permissions.canShare, userId }
}

export function createEditorPage(options: EditorPageOptions): EditorPage {
  const { documentId, surface, api, page, sessionChannel, clock } = options
  const listeners = new Set<() => void>()
  let load: EditorPageLoad = { kind: 'loading' }
  let session: EditorPageSession = 'active'
  let editor: SheetEditor | undefined
  let coordinator: SaveCoordinator | undefined
  let userId: string | undefined
  /** 本页这次加载的标识（P1 设计 §3.2）：编辑租约绑定它，保存也带着它（认出"自己追自己"），两处是同一个 */
  const clientInstanceId = options.newId()
  let editing: EditorEditing = { kind: 'none' }
  /** 本页持有的编辑租约（取得之后才有；失效、释放之后仍留着，不再续租） */
  let lease: EditLease | undefined
  /** 本页最后一次键盘、鼠标操作的时刻（单调的时钟）：心跳上报"多久没有操作" */
  let lastActivity = clock.now()
  /** 载入的内容的修订号：保存状态机建好之前（创建编辑器期间）它就是保存的基准，续上时与申请得到的修订号比较 */
  let loadedRevision = 0
  /** 页头的信息（就绪之后才有）：refreshDetail 更新它，编辑器的阶段变化时沿用它 */
  let heading: EditorHeading | undefined
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
  /** 载入期间的交互屏障：撤掉它的函数 */
  let releaseBarrier: (() => void) | undefined
  let current = computeView()

  function computeView(): EditorPageView {
    return { load, save: coordinator?.view(), editing, session, sessionProblem, confirmingSession }
  }

  function update(): void {
    const next = computeView()
    if (next.load === current.load && next.save === current.save && next.editing === current.editing && next.session === current.session
      && next.sessionProblem === current.sessionProblem && next.confirmingSession === current.confirmingSession) {
      return
    }
    current = next
    for (const listener of [...listeners])
      listener()
  }

  /**
   * 载入期间挂着交互屏障（interaction-barrier.ts）：编辑器已经画出来、保存与离开提示还没接上，这时页头之外的输入一律拦下，
   * 包括 Univer 挂在 body 下的浮层（Codex 评审 CX1，独立复验 N1）；就绪（ready、steady）或失败时撤掉
   */
  function setSurface(state: SurfaceState): void {
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

  /** 页头的信息更新了（refreshDetail）：就绪时随即换上，能不能编辑与编辑器的阶段不变 */
  function setHeading(next: EditorHeading): void {
    heading = next
    if (load.kind === 'ready') {
      load = { ...load, ...next }
      update()
    }
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
    // 内容不存在或无权访问（两者相同，US-M1-08）；地址里的 id 不合法也按不存在处理
    else if (isMissingResource(error))
      finish({ kind: 'not-found' })
    else
      finish({ kind: 'failed', error })
  }

  /**
   * 保存的状态机停住还是照常：换了人（不把新会话的令牌交给这个页面），或者编辑权已经失效（再保存也一定被拒），都停住。
   * 没有人登录时不停：按保存会先向服务端确认（save 里），本人在别处登录了就照常保存
   */
  function syncSaving(): void {
    if (session === 'other-user' || editing.kind === 'lost')
      coordinator?.stop()
    else
      coordinator?.resume()
  }

  function enterSession(next: EditorPageSession): void {
    const previous = session
    session = next
    syncSaving()
    // 会话不是本人：暂停续租，不带着别人的登录（或已经失效的登录）发续租。回到本人时由确认会话的那一步恢复
    if (next !== 'active')
      lease?.pause()
    // 从未登录或换了人回到本人：之前"登录已过期""请求已失效"这类失败的说明不再成立（复验 RB2）。
    // 一直是本人时保留：用户按了保存，要看到这次没有保存成功（页头提示再保存一次，令牌已经换好，复验 SB1）
    if (next === 'active' && previous !== 'active')
      coordinator?.dismissSessionProblem()
    update()
  }

  /** 编辑权失效（续租或保存得知）：停止保存，页头说明原因、提供重新加载。离开提示照旧按有没有未保存的修改 */
  function leaseLost(loss: LeaseLoss): void {
    if (disposed)
      return
    editing = { kind: 'lost', loss }
    syncSaving()
    update()
  }

  /**
   * 续租得到未登录或令牌失效：与保存得到它们时同一个处理——向服务端确认现在是谁（不显示"正在确认"：不是用户按了保存）。
   * 续租随之暂停，确认是本人之后恢复
   */
  function leaseSessionProblem(error: ApiError): void {
    if (isAuthenticationError(error))
      unauthenticatedPending = true
    else
      staleAfter = checksStarted
    void recheckSession()
  }

  /** 申请编辑权（edit-lease.ts）：被占用而且是自己时先再试几次（刷新时旧页面的释放晚到） */
  async function acquire(id: string): Promise<LeaseAcquisition> {
    return acquireEditLease({
      documentId: id,
      clientInstanceId,
      api: api.editLease,
      clock,
      lastActivity: () => lastActivity,
      // 续上时的比较：服务端确认过的最新修订（保存状态机建好之前是载入的内容的）
      baseRevision: () => coordinator?.baseRevision() ?? loadedRevision,
      onLost: leaseLost,
      onSessionProblem: leaseSessionProblem,
    })
  }

  /** 载入没有完成（失败、页面卸载）：已经取得的编辑权尽力释放 */
  function abandonLease(): void {
    lease?.release()
    lease = undefined
    editing = { kind: 'none' }
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
    const round = ++checksStarted
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
    // 确认成功：令牌按确认的结果换上或清掉，不再是已知失效的那个（这轮开始于令牌被标为失效之后）
    unauthenticatedPending = false
    if (staleAfter !== undefined && round > staleAfter)
      staleAfter = undefined
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
      // 编辑权绑定登录（P1 设计 §3.4.1）：登录可能换过（重新登录、换令牌），恢复续租并立即核对一次——失效时随即说明、停止保存。
      // 确认在它有了结果之后才算结束：按保存时等的是这一步，不带着已经失效的编辑权去保存
      await lease?.resume()
    }
    else {
      // 另一个人：新会话的令牌不交给这个页面，停止保存
      setCsrfToken(undefined)
      enterSession('other-user')
    }
  }

  /**
   * 保存：带上编辑租约现在的令牌与代次。得到编辑权失效（EDIT_LEASE_LOST）、读不到（404）、不能编辑（403）时，
   * 与续租得知同一个处理（P1 设计 §3.4.7）——心跳先发现还是保存先发现，结果一样：
   * - 续上了（或者这次带的是已被续上取代的上一代）：用现在的编辑权重发这一次。上一次在写入之前就被拒绝，确定没有生效，
   *   requestId 不变；至多重发一次；
   * - 失效了：照常按保存失败交回（页头只说明编辑权已失效）；
   * - 暂时说不准（续上时网络出错等）：按那次的错误交回（例如网络连接失败），下一次心跳或保存时再判断
   */
  async function sendSave(documentId: string, held: EditLease, request: SaveRequest, body: Uint8Array<ArrayBuffer>): Promise<SaveContentResponse> {
    for (let resent = false; ; resent = true) {
      const credentials = held.credentials()
      try {
        return await api.save(documentId, request, body, credentials)
      }
      catch (error) {
        const loss = leaseLossOf(error)
        if (loss === undefined)
          throw error
        const outcome = await held.lose(loss, credentials)
        if (outcome.kind === 'unknown')
          throw outcome.error ?? error
        if (outcome.kind === 'lost' || resent)
          throw error
      }
    }
  }

  /**
   * 编辑器就绪：持有编辑权时先建保存状态机（离开提示经它判断），然后才进入 ready、撤掉交互屏障（Codex 评审 CX1）。
   * 只读的文档、别处正在编辑的文档已经以只读创建（createEditor 的 access，M2-P3 设计 §3.5），这里不建保存状态机：没有保存按钮，
   * Ctrl/Cmd+S 不做事，离开不提示
   */
  function ready(document: DocumentDetail, created: SheetEditor, baseRevision: number, viewer: string): void {
    editor = created
    heading = headingOf(document, viewer)
    const held = lease
    const readOnly = held === undefined
    if (held !== undefined) {
      coordinator = createSaveCoordinator({
        editor: created,
        compress: api.compress,
        send: async (request, body) => sendSave(document.id, held, request, body),
        baseRevision,
        clientInstanceId,
        newRequestId: options.newId,
        // 保存得到未登录：先向服务端确认（回包可能是本人在别处重新登录之前发出的那次保存的，不能据此清掉新的令牌，复验 RB7）
        onUnauthenticated: () => {
          unauthenticatedPending = true
          void confirmForSave(true)
        },
        onSessionStale: () => {
          staleAfter = checksStarted
          void confirmForSave(true)
        },
        reportError: options.reportError,
      })
      // 创建编辑器期间别的标签页换了人、编辑权已经失效：保存状态机一建好就停住（复验 RB3）
      syncSaving()
      cleanups.push(coordinator.subscribe(update))
    }
    const enter = (stage: SheetEditorLifecycle): void => {
      if (heading === undefined)
        return
      load = { kind: 'ready', ...heading, readOnly, stage }
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
      // 本页的键盘、鼠标操作（捕获阶段）：心跳据此上报多久没有操作。挂在交互屏障之前，载入期间被拦下的输入也算有操作。
      // 页面隐藏、关闭时尽力释放编辑权（keepalive，结果不管）
      const pageWindow = options.chrome.ownerDocument.defaultView ?? window
      cleanups.push(trackActivity(pageWindow, () => {
        lastActivity = clock.now()
        lease?.noteActivity()
      }))
      const onPageHide = (): void => lease?.release()
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
      loadedRevision = content.revision
      // 能编辑时先申请编辑权（P1 设计 §3.4.7）：取得了才按可编辑创建；被占用、刚失去编辑权（403）按只读
      if (document.permissions.canEdit) {
        let acquisition: LeaseAcquisition | undefined
        try {
          acquisition = await acquire(documentId)
        }
        catch (error) {
          if (disposed)
            return
          // 能不能编辑刚变了（403）：按只读打开。读不到了（404）、未登录、网络等：与读取元数据、内容失败相同
          if (!isPermissionDeniedError(error)) {
            loadFailed(error)
            return
          }
        }
        if (acquisition?.kind === 'acquired') {
          lease = acquisition.lease
          editing = { kind: 'editing' }
          if (disposed) {
            abandonLease()
            return
          }
          // 申请期间别的标签页换了人或者退出了：先暂停，确认是本人之后恢复
          if (session !== 'active')
            lease.pause()
          // 申请得到的修订号是锁下的当前修订：比载入的内容新，说明这期间有人保存过，重新载入一次。
          // 持有编辑权之后别人不能再保存，所以一次就够
          if (acquisition.revision !== content.revision) {
            try {
              content = await api.content(documentId)
              loadedRevision = content.revision
            }
            catch (error) {
              abandonLease()
              if (!disposed)
                loadFailed(error)
              return
            }
            if (disposed) {
              abandonLease()
              return
            }
          }
        }
        else if (acquisition?.kind === 'held') {
          editing = { kind: 'elsewhere', holder: acquisition.holder }
        }
        if (disposed)
          return
      }
      let created: SheetEditor
      try {
        // 能不能编辑由服务端按有效角色给出（ADR-014），并且要持有编辑权：只读时编辑器一开始就以只读创建，没有工具栏等编辑入口（M2-P3 设计 §3.5）
        created = await options.createEditor({ container: surface, snapshot: content.snapshot, access: lease === undefined ? 'read' : 'edit' })
      }
      catch (error) {
        abandonLease()
        if (!disposed)
          finish({ kind: 'editor-failed', error })
        return
      }
      if (disposed) {
        created.dispose()
        abandonLease()
        return
      }
      ready(document, created, content.revision, signedIn.user.id)
    },
    save: async () => {
      // 编辑权已经失效：再保存也一定被拒，不做任何事（页头已经说明）
      if (coordinator === undefined || editing.kind === 'lost')
        return
      // 保存中、版本冲突之后再按：不做任何事（P4 设计 §3.7.2）；不因为有确认在途就把"保存中"换成"正在确认"（复验 TB9）
      const { status } = coordinator.view()
      if (status === 'saving' || status === 'conflict')
        return
      // 确认会话进行中（别的标签页的消息、保存得到未登录或 CSRF 失效触发的）：等它结束，按确认的结果决定（复验 RB1）；
      // 暂停或停止保存时、上一次确认失败时（令牌可能没有换成，复验 TB1）先向服务端确认一次：本页的用户可能已经在别处重新登录，
      // 广播的消息没有送到。令牌已知失效时一定先确认（复验 VB1）：眼下这时确认总是在途或者失败过，这一条保证即使不是这样，
      // 按保存也会去换令牌，而不是一直不发
      if (checkInFlight !== undefined || session !== 'active' || sessionProblem !== undefined || staleAfter !== undefined)
        await confirmForSave(false)
      // 等确认期间页面卸载了：不再捕获与上传（复验 SB6）。令牌已知失效、确认又没有成功：不带着旧的令牌再发，
      // 必然又是令牌失效，只会白传一遍快照；失败的原因页头已经说明（复验 UB1）
      if (session === 'active' && !disposed && staleAfter === undefined)
        await coordinator.save()
    },
    hasUnsavedWork: () => coordinator?.hasUnsavedWork() ?? false,
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
        // 看不到了（已经删除、移走，或者自己被移出、授权被取消）：不再能分享。未登录交给会话的确认（页头随之说明）；别的失败页头不变
        if (isMissingResource(error))
          setHeading({ ...heading, canShare: false })
        else if (isAuthenticationError(error))
          void recheckSession()
        return
      }
      if (!disposed && heading !== undefined)
        setHeading(headingOf(document, heading.userId))
    },
    recheckSession,
    dispose: () => {
      disposed = true
      releaseBarrier?.()
      releaseBarrier = undefined
      lease?.release()
      for (const cleanup of cleanups.splice(0))
        cleanup()
      coordinator?.dispose()
      editor?.dispose()
      listeners.clear()
    },
  }
}
