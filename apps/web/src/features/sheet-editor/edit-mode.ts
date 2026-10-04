// 阅读与编辑（M3-P2 设计 §3.1、§3.4）：编辑器页里"现在是阅读还是编辑、编辑权怎样了"的状态机。不依赖 Univer 与界面：编辑器经工厂创建，
// 接口、时钟与页面的可见性都可注入，用假的做单元测试（edit-mode.test.ts）。持有当前的编辑器、编辑租约（edit-lease.ts）与保存的状态机
// （save-coordinator.ts）；载入、会话与页头的编排在 editor-page.ts。
//
// 模式切换一律重建（§3.1，需求方 2026-10-04 决定）：进入编辑、退出编辑、失去编辑权、"有更新，点击刷新"、放弃本页的修改，都先取出
// 视图状态、销毁当前的编辑器（Univer 实例与公式 Worker），再以目标的 access 与选定的快照新建一个，就绪之后恢复视图状态。
// 新建期间编辑器页挂着交互屏障（surface 为 creating）；可编辑的编辑器先建好保存的状态机、再接上（撤掉屏障），放开之后的每一处修改
// 都有人接着（Codex 评审 CX1）。不做原地切换，也不在同一个实例里 disposeUnit 再创建（§2：那样新单元的只读不完整）。
//
// 状态（§3.4 的表）：
// - opening：载入之后、第一个编辑器就绪之前；
// - reading：只读的编辑器。canEdit 决定有没有"编辑"；holder 是正在编辑的人（编辑状态或申请被占用时给出）；update 是服务端有没有
//   更新的版本；gone 是这份文档读不到了；notice 是上一次操作留下的说明。阅读时读编辑状态：进入阅读时立即一次，之后每 30 秒一次
//   （页面隐藏、会话不是本人时暂停，回到前台、回到本人时立即读一次）；
// - entering：申请编辑权、按需要取最新的内容、重建为可编辑（交互屏障挡住期间的输入）；
// - editing：可编辑的编辑器与保存的状态机；
// - exiting：先保存（保存失败就留在编辑），捕获，释放编辑权（等它的结果，结果未知也照样退出），重建为只读；
// - losing / lost：失去编辑权（续租或保存得知，续上没有成功；P1 的续上规则不变）：停止保存，提交正在编辑的单元格、捕获本页的内容，
//   重建为只读、显示本页的内容。还读得到（不是 404）而且有没保存的修改：给"另存为副本"与"放弃本页的修改"；有一次结果未知的保存时，
//   给副本之前先原样重发它（重放先于登录与租约，P1）——拿到原来的结果就按已保存处理。读不到了（404）：说明，本页的内容不再能保存；
// - failed：编辑器建不起来（页面按"编辑器加载失败"说明，可以重新加载）；unavailable：放弃本页的修改时读不到了（"内容不存在"）。
// 每开始一件事（进入、退出、失去编辑权、刷新、放弃）都换一个标识：之前那件事在等待之后发现标识变了，就不再接着做。
import type { ConflictCopyQuery, CreatedDocument, DocumentDetail, SaveContentResponse } from '@nerve-office/contracts'
import type { EditorAccess, SheetEditor, SheetEditorLifecycle, SheetViewState } from '../../editor/index.ts'
import type { ApiError } from '../../shared/api/index.ts'
import type { EditLease, EditLeaseApi, LeaseAcquisition, LeaseClock, LeaseHolder, LeaseLoss } from './edit-lease.ts'
import type { FetchedEditStatus, LeaseCredentials, LoadedContent } from './editor-api.ts'
import type { CompressSnapshot, SaveCoordinator, SaveRequest, SaveView } from './save-coordinator.ts'
import { conflictCopyTitle } from '@nerve-office/contracts'
import { isAuthenticationError, isCsrfTokenError, isDefiniteRejection, isNotFoundError, isPermissionDeniedError } from '../../shared/api/index.ts'
import { acquireEditLease, leaseHolderOf, leaseLossOf } from './edit-lease.ts'
import { CONTENT_UNCHANGED } from './editor-api.ts'
import { createSaveCoordinator } from './save-coordinator.ts'

/** 阅读时读编辑状态的间隔（M3 总设计 §2.1、US-M3-05）：30 秒 */
export const READING_CHECK_INTERVAL_MS = 30_000

/** 本页显示的内容：快照的原文与它的修订号（阅读时是服务端那一版；退出编辑之后是保存确认过的那一版） */
interface ShownContent {
  readonly snapshot: string
  readonly revision: number
}

/** 阅读时上一次操作留下的说明 */
export type ReadingNotice
  /** 进入编辑时不能编辑了（403，例如刚被降为查看者、空间刚被归档）：error 带服务端的原因 */
  = | { readonly kind: 'denied', readonly error: ApiError }
  /** 进入编辑没有成功（网络、服务端出错、登录的问题等）：可以再试 */
    | { readonly kind: 'enter-failed', readonly error: unknown }
  /** 进入编辑时，编辑权在编辑器建好之前就失效了 */
    | { readonly kind: 'enter-lost', readonly loss: LeaseLoss }
  /** 以编辑方式重建编辑器失败：已经释放编辑权、回到阅读，可以再试 */
    | { readonly kind: 'editor-failed' }
  /** "有更新"之后没能取到最新的版本：可以再试 */
    | { readonly kind: 'refresh-failed', readonly error: unknown }
  /** 另存为副本成功：新文档（在新标签页打开）；本页已按服务端的最新内容重建为阅读 */
    | { readonly kind: 'copied', readonly document: DocumentDetail }

export interface ReadingMode {
  readonly kind: 'reading'
  /** 现在能不能编辑（打开时取详情的，之后随编辑状态更新）：不能时没有"编辑" */
  readonly canEdit: boolean
  /** 正在编辑的人（编辑状态给出，或者申请时被占用）；没有人在编辑时为 undefined */
  readonly holder: LeaseHolder | undefined
  /** 服务端有比本页新的版本：available 时提示"有更新，点击刷新"，loading 正在取它 */
  readonly update: 'none' | 'available' | 'loading'
  /** 这份文档已经读不到了（编辑状态、进入编辑或刷新时得到 404） */
  readonly gone: boolean
  readonly notice: ReadingNotice | undefined
}

/** 另存为副本的进展 */
export type CopyState
  = | { readonly kind: 'idle' }
    | { readonly kind: 'saving' }
    | { readonly kind: 'failed', readonly error: unknown }
    | { readonly kind: 'done', readonly document: DocumentDetail }

/** 按服务端的最新内容重建为阅读（放弃本页的修改、重新加载、另存为副本之后）的进展 */
export type ReloadState
  = | { readonly kind: 'idle' }
    | { readonly kind: 'loading' }
    | { readonly kind: 'failed', readonly error: unknown }

export interface LostMode {
  readonly kind: 'lost'
  readonly loss: LeaseLoss
  /** 本页有服务端没有确认的内容（捕获时；核对过结果未知的保存之后随之更新） */
  readonly unsaved: boolean
  /** 还读得到这份文档（不是 404）：有修改时给副本，没有修改时可以重新加载 */
  readonly readable: boolean
  /** 正在核对结果未知的那次保存（原样重发）：核对完才给副本 */
  readonly checking: boolean
  /** 本页的内容没能取出（捕获时 SDK 出错）：编辑器留着（还能复制），不给副本、不自动重建 */
  readonly captureFailed: boolean
  readonly copy: CopyState
  readonly reload: ReloadState
}

export type EditModeState
  = | { readonly kind: 'opening' }
    | ReadingMode
    | { readonly kind: 'entering' }
    | { readonly kind: 'editing' }
    | { readonly kind: 'exiting' }
    | { readonly kind: 'losing', readonly loss: LeaseLoss }
    | LostMode
    | { readonly kind: 'failed', readonly error: unknown }
    | { readonly kind: 'unavailable' }

/** 当前编辑器的进展：creating 是正在新建（页面的交互屏障挡着），之后随编辑器的生命周期；没有编辑器时为 none */
export type EditorSurface = 'none' | 'creating' | SheetEditorLifecycle

export interface EditModeView {
  readonly mode: EditModeState
  /** 编辑时（与退出编辑的过程中）才有：保存的状态 */
  readonly save: SaveView | undefined
  readonly surface: EditorSurface
}

export interface EditModeApi {
  /** 内容的全文（放弃本页的修改时：本页的内容不是服务端的哪一版，不能用条件读取） */
  readonly content: (documentId: string) => Promise<LoadedContent>
  /** 条件读取：本页手里是 revision 这一版，服务端还是它时给出 unchanged（304） */
  readonly contentIfChanged: (documentId: string, revision: number) => Promise<LoadedContent | typeof CONTENT_UNCHANGED>
  /** 编辑状态（阅读时每 30 秒一次） */
  readonly editStatus: (documentId: string) => Promise<FetchedEditStatus>
  readonly editLease: EditLeaseApi
  readonly compress: CompressSnapshot
  /** 保存：带上编辑租约的令牌与代次 */
  readonly save: (documentId: string, request: SaveRequest, body: Uint8Array<ArrayBuffer>, lease: LeaseCredentials) => Promise<SaveContentResponse>
  /** 另存为副本：上传本页的快照，新建一份文档（M3-P2 设计 §3.2） */
  readonly conflictCopy: (documentId: string, query: ConflictCopyQuery, body: Uint8Array<ArrayBuffer>) => Promise<CreatedDocument>
}

/** 页面的可见性（document.visibilityState）：隐藏时暂停阅读时的检查 */
export interface PageVisibility {
  readonly hidden: () => boolean
  /** 隐藏与否变了；返回退订的函数 */
  readonly onChange: (listener: () => void) => () => void
}

/** 会话类的问题交给页面确认现在是谁（editor-page.ts）：不同的来源确认的方式不同 */
export interface EditModeSessionHooks {
  /** 保存得到未登录或登录已过期 */
  readonly saveUnauthenticated: (error: ApiError) => void
  /** 保存得到令牌失效 */
  readonly saveStale: () => void
  /** 编辑权的请求（申请、续租、续上）、另存为副本得到未登录或令牌失效 */
  readonly writeProblem: (error: ApiError) => void
  /** 读取（编辑状态、内容）得到未登录 */
  readonly readProblem: (error: ApiError) => void
}

/** 新建编辑器的工厂：容器由页面绑定 */
export type CreateModeEditor = (options: { readonly snapshot: string, readonly access: EditorAccess, readonly viewState?: SheetViewState | undefined }) => Promise<SheetEditor>

export interface EditModeOptions {
  readonly documentId: string
  /** 本页这次加载的标识：编辑租约绑定它，保存也带着它 */
  readonly clientInstanceId: string
  readonly api: EditModeApi
  readonly createEditor: CreateModeEditor
  /** 单调的"现在"与计时器：编辑租约的心跳、阅读时的检查 */
  readonly clock: LeaseClock
  readonly visibility: PageVisibility
  /** 本页最后一次键盘、鼠标操作的时刻（clock.now 的时间轴上） */
  readonly lastActivity: () => number
  readonly newId: () => string
  /** 现在的墙上时间：另存为副本的标题里的时间（页面所在的时区，写到分钟） */
  readonly now: () => Date
  /** 原文档现在的标题：另存为副本的标题以它开头 */
  readonly title: () => string
  readonly session: EditModeSessionHooks
  /** 意外的错误：上报（浏览器的 reportError） */
  readonly reportError: (error: unknown) => void
}

/** 打开的结果：编辑器就绪了（entered：直接进入了编辑）；编辑器建不起来；载入失败（直接进入编辑时申请得到读不到、未登录等） */
export type OpenOutcome
  = | { readonly kind: 'opened', readonly entered: boolean }
    | { readonly kind: 'editor-failed', readonly error: unknown }
    | { readonly kind: 'load-failed', readonly error: unknown }

export interface EditMode {
  readonly view: () => EditModeView
  readonly subscribe: (listener: () => void) => () => void
  /**
   * 打开（载入之后）：以只读创建，进入阅读。enterEdit（地址带 ?edit=new、而且能编辑）时直接申请编辑权、以可编辑创建
   * （新建的表格不必先阅读，M3 总设计 §2.1 的细化）；被占用或不能编辑了就照常阅读
   */
  readonly open: (initial: { readonly snapshot: string, readonly revision: number, readonly canEdit: boolean }, options: { readonly enterEdit: boolean }) => Promise<OpenOutcome>
  /** 进入编辑（阅读、能编辑时；"编辑"按钮） */
  readonly enter: () => Promise<void>
  /** 退出编辑（"退出编辑"按钮） */
  readonly exit: () => Promise<void>
  /** 保存一次（编辑时；按钮与快捷键，会话由页面先确认） */
  readonly save: () => Promise<void>
  /** "有更新，点击刷新"：按条件读取取最新的内容，重建为阅读（保留视图） */
  readonly refresh: () => Promise<void>
  /** 失去编辑权之后：另存为副本 */
  readonly saveCopy: () => Promise<void>
  /** 失去编辑权之后：放弃本页的修改（没有修改、或者已经另存为副本时是重新加载）——按服务端的最新内容重建为阅读 */
  readonly discard: () => Promise<void>
  /** 离开页面会丢掉内容（离开提示） */
  readonly hasUnsavedWork: () => boolean
  /** 页面的会话变了：换了人时停住保存；不是本人时暂停续租与阅读时的检查；回到本人时恢复，之前会话类的保存失败不再说 */
  readonly setSession: (session: 'active' | 'signed-out' | 'other-user') => void
  /** 页面确认会话是本人之后：恢复续租并立即续租一次（登录可能换过）；这一次有了结果之后兑现 */
  readonly resumeLease: () => Promise<void>
  /** 页头的文档详情刷新了：能不能编辑随之更新（阅读时） */
  readonly updateCanEdit: (canEdit: boolean) => void
  /** 本页有键盘、鼠标操作 */
  readonly noteActivity: () => void
  /** 页面隐藏、关闭：尽力释放编辑权（不等结果） */
  readonly releaseOnHide: () => void
  /** 停止计时器，尽力释放编辑权，销毁保存的状态机与编辑器 */
  readonly dispose: () => void
}

/** 另存为副本的标题里的时间：页面所在的时区，写到分钟，例如"2026-10-04 15:30" */
export function conflictCopyLabel(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** 失去编辑权之后的阅读：被收回、不能编辑了时没有"编辑"（之后随编辑状态更新）；别处在编辑时说明是谁 */
function readingAfter(loss: LeaseLoss, notice: ReadingNotice | undefined): ReadingMode {
  const canEdit = loss.kind !== 'denied' && !(loss.kind === 'lease' && loss.reason === 'revoked')
  return { kind: 'reading', canEdit, holder: loss.kind === 'held' ? loss.holder : undefined, update: 'none', gone: false, notice }
}

export function createEditMode(options: EditModeOptions): EditMode {
  const { documentId, api, clock, session: hooks } = options
  const listeners = new Set<() => void>()
  let mode: EditModeState = { kind: 'opening' }
  let surface: EditorSurface = 'none'
  let editor: SheetEditor | undefined
  let stopWatchingEditor: (() => void) | undefined
  let lease: EditLease | undefined
  let coordinator: SaveCoordinator | undefined
  let stopWatchingCoordinator: (() => void) | undefined
  /** 本页显示的内容（阅读时）：进入编辑时与申请得到的修订号比较，"有更新"时作条件读取的基准 */
  let shown: ShownContent = { snapshot: '', revision: 0 }
  /** 保存的状态机建好之前保存的基准（进入编辑时选定的那一份内容的修订号）：续上时比较 */
  let editingBase = 0
  /** 进入编辑之前的阅读：没有进入成功时回到它 */
  let readingBefore: ReadingMode = { kind: 'reading', canEdit: false, holder: undefined, update: 'none', gone: false, notice: undefined }
  /** 失去编辑权时捕获的本页内容：另存为副本上传它 */
  let lostSnapshot: string | undefined
  /** 失去编辑权的时刻（墙上时间）：副本的标题里的时间 */
  let lostAt: Date | undefined
  /** 另存为副本的请求：结果未知之后再试沿用（幂等，服务端只建一份），成功或确定被拒绝之后换新的 */
  let copyQuery: ConflictCopyQuery | undefined
  /** 正在新建可编辑的编辑器（进入编辑、直接进入编辑的打开）：这期间得知的失效等编辑器建好、进入编辑之后再处理 */
  let pendingLoss: LeaseLoss | undefined
  let generation = 0
  let session: 'active' | 'signed-out' | 'other-user' = 'active'
  let disposed = false
  /** 阅读时下一次检查的计时器 */
  let cancelCheck: (() => void) | undefined
  /** 检查进行中（同时只有一个） */
  let checking = false
  const stopWatchingVisibility = options.visibility.onChange(() => {
    if (options.visibility.hidden())
      stopChecks()
    else if (mode.kind === 'reading')
      checkNow()
  })
  let current = computeView()

  /** 保存的状态只在编辑与退出编辑的过程中给出：失去编辑权之后保存的状态机还留着（核对结果未知的保存），但它的说明不再成立 */
  function computeView(): EditModeView {
    return { mode, save: mode.kind === 'editing' || mode.kind === 'exiting' ? coordinator?.view() : undefined, surface }
  }

  function notify(): void {
    const next = computeView()
    if (next.mode === current.mode && next.save === current.save && next.surface === current.surface)
      return
    current = next
    for (const listener of [...listeners])
      listener()
  }

  /** 换上新的状态：离开阅读时停止检查，从别的状态进入阅读时立即检查一次（阅读之内的变化不打断检查的节奏） */
  function setMode(next: EditModeState): void {
    const wasReading = mode.kind === 'reading'
    mode = next
    if (next.kind !== 'reading')
      stopChecks()
    else if (!wasReading)
      checkNow()
    notify()
  }

  /** 开始一件新的事：之前那件事的后续作废。返回这件事的标识 */
  function begin(next: EditModeState): number {
    generation += 1
    setMode(next)
    return generation
  }

  /** 这件事还在：页面没有卸载，也没有开始别的事 */
  function still(token: number): boolean {
    return !disposed && token === generation
  }

  // ---- 编辑器的新建与销毁 ----

  /** 接上编辑器：之后它的生命周期就是 surface（渲染完成时页面撤掉交互屏障） */
  function watch(created: SheetEditor): void {
    editor = created
    stopWatchingEditor = created.onLifecycle((stage) => {
      surface = stage
      notify()
    })
    surface = created.lifecycle()
  }

  function disposeEditor(): void {
    stopWatchingEditor?.()
    stopWatchingEditor = undefined
    editor?.dispose()
    editor = undefined
  }

  /**
   * 重建（§3.1）：取出视图状态、销毁当前的编辑器，以 access 与 snapshot 新建，就绪之后恢复视图状态。新建期间 surface 是 creating
   * （页面挂着交互屏障）；新建的编辑器先交回调用方（可编辑时它要先建好保存的状态机），由 watch 接上之后才撤掉屏障。
   * 新建失败时返回 undefined（已上报），这时没有编辑器
   */
  async function rebuild(access: EditorAccess, snapshot: string): Promise<SheetEditor | undefined> {
    const viewState = editor?.viewState()
    disposeEditor()
    surface = 'creating'
    notify()
    try {
      const created = await options.createEditor({ snapshot, access, viewState })
      if (disposed) {
        created.dispose()
        return undefined
      }
      return created
    }
    catch (error) {
      if (!disposed)
        options.reportError(error)
      return undefined
    }
  }

  /** 编辑器建不起来：页面说明"编辑器加载失败"（可以重新加载） */
  function fail(error: unknown): void {
    surface = 'none'
    begin({ kind: 'failed', error })
  }

  // ---- 阅读时的检查（US-M3-05） ----

  function stopChecks(): void {
    cancelCheck?.()
    cancelCheck = undefined
  }

  /** 读编辑状态的条件：阅读中、会话是本人、页面没有隐藏 */
  function checksAllowed(): boolean {
    return !disposed && mode.kind === 'reading' && session === 'active' && !options.visibility.hidden()
  }

  /** 立即读一次（进入阅读、回到前台、回到本人时），之后每 30 秒一次 */
  function checkNow(): void {
    stopChecks()
    void check()
  }

  function scheduleCheck(): void {
    stopChecks()
    if (checksAllowed()) {
      cancelCheck = clock.schedule(() => {
        cancelCheck = undefined
        void check()
      }, READING_CHECK_INTERVAL_MS)
    }
  }

  async function check(): Promise<void> {
    if (checking || !checksAllowed())
      return
    checking = true
    let fetched: FetchedEditStatus | undefined
    let failure: unknown
    try {
      fetched = await api.editStatus(documentId)
    }
    catch (error) {
      failure = error
    }
    finally {
      checking = false
    }
    if (disposed)
      return
    if (mode.kind === 'reading') {
      const reading = mode
      if (fetched !== undefined) {
        const { status, serverTime } = fetched
        setMode({
          ...reading,
          canEdit: status.canEdit,
          holder: status.editor === null ? undefined : leaseHolderOf(status.editor, serverTime),
          // 正在按新的版本重建时不动它（重建完了以新的修订号为准）
          update: reading.update === 'loading' ? 'loading' : (status.revision > shown.revision ? 'available' : 'none'),
          gone: false,
          // 进入编辑时的"不能编辑了"在又能编辑之后不再成立
          notice: reading.notice?.kind === 'denied' && status.canEdit ? undefined : reading.notice,
        })
      }
      else if (isNotFoundError(failure)) {
        // 读不到了（删除、移走、失去访问）：说明，没有"编辑"与"有更新"；之后照常检查，恢复访问之后随之恢复
        setMode({ ...reading, gone: true, canEdit: false, holder: undefined, update: 'none' })
      }
      else if (isAuthenticationError(failure)) {
        hooks.readProblem(failure)
      }
      // 别的失败（网络、服务端出错）照常下一次再试
    }
    scheduleCheck()
  }

  // ---- 保存与编辑权 ----

  /** 换了人、失去编辑权时停住保存；没有人登录时不停（按保存会先向服务端确认，本人在别处登录了就照常保存） */
  function syncSaving(): void {
    if (session === 'other-user' || mode.kind === 'losing' || mode.kind === 'lost')
      coordinator?.stop()
    else
      coordinator?.resume()
  }

  /**
   * 保存：带上编辑租约现在的令牌与代次（P1 设计 §3.4.7）。得到编辑权失效、读不到、不能编辑时，与续租得知同一个处理：
   * 续上了（或者带的是已被续上取代的上一代）就用现在的编辑权重发这一次（上一次在写入之前就被拒绝，requestId 不变），至多一次；
   * 失效了按保存失败交回；说不准时按那次的错误交回，下一次心跳或保存时再判断
   */
  async function sendSave(held: EditLease, request: SaveRequest, body: Uint8Array<ArrayBuffer>): Promise<SaveContentResponse> {
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

  function disposeCoordinator(): void {
    stopWatchingCoordinator?.()
    stopWatchingCoordinator = undefined
    coordinator?.dispose()
    coordinator = undefined
  }

  /** 申请编辑权（edit-lease.ts）：被占用而且是自己时先再试几次（刷新时旧页面的释放晚到） */
  async function acquire(): Promise<LeaseAcquisition> {
    pendingLoss = undefined
    return acquireEditLease({
      documentId,
      clientInstanceId: options.clientInstanceId,
      api: api.editLease,
      clock,
      lastActivity: options.lastActivity,
      // 续上时的比较：服务端确认过的最新修订（保存状态机建好之前是选定的那一份内容的）
      baseRevision: () => coordinator?.baseRevision() ?? editingBase,
      // 期间的那一版是本页自己一次结果未知的保存：保存状态机按它确认（建好之前还没有保存过，不会是）
      adoptOwnRevision: (revision, source) => coordinator?.adoptOwnRevision(revision, source) ?? false,
      onLost: lost,
      onSessionProblem: hooks.writeProblem,
    })
  }

  /** 编辑权没用上（进入编辑没有成功）：尽力释放，不等 */
  function dropLease(): void {
    void lease?.release()
    lease = undefined
  }

  /**
   * 编辑权失效（续租或保存得知，续上没有成功）。编辑、退出编辑时转入失去编辑权；进入编辑还在申请、取内容（只读的编辑器还在）时
   * 放弃进入、留在阅读；正在新建可编辑的编辑器时等它建好、进入编辑之后再处理（与 P1 一样：建好之后随即停住）
   */
  function lost(loss: LeaseLoss): void {
    if (disposed)
      return
    if (mode.kind === 'editing' || mode.kind === 'exiting') {
      void lose(loss)
    }
    else if (mode.kind === 'entering' && editor !== undefined && surface !== 'creating') {
      lease = undefined
      begin({ ...readingBefore, notice: { kind: 'enter-lost', loss } })
    }
    else if (mode.kind === 'entering' || mode.kind === 'opening') {
      pendingLoss = loss
    }
  }

  /** 申请编辑权、取内容的请求失败时阅读里的说明：不能编辑了、读不到了、会话的问题与别的失败 */
  function readingAfterFailure(error: unknown): ReadingMode {
    if (isPermissionDeniedError(error))
      return { ...readingBefore, canEdit: false, notice: { kind: 'denied', error } }
    if (isNotFoundError(error))
      return { ...readingBefore, gone: true, canEdit: false, holder: undefined, update: 'none', notice: undefined }
    if (isAuthenticationError(error) || isCsrfTokenError(error))
      hooks.writeProblem(error)
    return { ...readingBefore, notice: { kind: 'enter-failed', error } }
  }

  /** 接上只读的编辑器（撤掉屏障），进入阅读（随即检查一次） */
  function enterReading(created: SheetEditor, content: ShownContent, reading: ReadingMode): void {
    shown = content
    watch(created)
    begin(reading)
  }

  /**
   * 取得了编辑权之后：选定内容（申请得到的修订号等于本页的就用本页的，否则按条件读取取服务端的）、以可编辑重建、
   * 建好保存的状态机再接上编辑器。读取失败时已经释放编辑权，交回错误（调用方按它说明）；重建失败时释放编辑权、以只读重建
   * 选定的那一份内容、回到阅读并说明（再失败就是 failed）
   */
  async function startEditing(token: number, held: EditLease, revision: number): Promise<'entered' | 'not-entered' | { readonly error: unknown }> {
    lease = held
    editingBase = revision
    if (session !== 'active')
      held.pause()
    let content: ShownContent = shown
    if (revision !== shown.revision) {
      let fetched: LoadedContent | typeof CONTENT_UNCHANGED
      try {
        fetched = await api.contentIfChanged(documentId, shown.revision)
      }
      catch (error) {
        if (!still(token))
          return 'not-entered'
        dropLease()
        return { error }
      }
      if (!still(token))
        return 'not-entered'
      if (fetched !== CONTENT_UNCHANGED)
        content = fetched
      editingBase = content.revision
    }
    const created = await rebuild('edit', content.snapshot)
    if (!still(token)) {
      created?.dispose()
      return 'not-entered'
    }
    if (created === undefined) {
      pendingLoss = undefined
      dropLease()
      const fallback = await rebuild('read', content.snapshot)
      if (!still(token)) {
        fallback?.dispose()
        return 'not-entered'
      }
      if (fallback === undefined)
        fail(new Error('以编辑方式重建编辑器失败，回到阅读时也没能建好'))
      else
        enterReading(fallback, content, { ...readingBefore, update: 'none', notice: { kind: 'editor-failed' } })
      return 'not-entered'
    }
    shown = content
    // 先建保存的状态机，再接上编辑器（撤掉屏障）：放开之后的每一处修改都有人接着
    coordinator = createSaveCoordinator({
      editor: created,
      compress: api.compress,
      send: async (request, body) => sendSave(held, request, body),
      baseRevision: content.revision,
      clientInstanceId: options.clientInstanceId,
      newRequestId: options.newId,
      onUnauthenticated: hooks.saveUnauthenticated,
      onSessionStale: hooks.saveStale,
      reportError: options.reportError,
    })
    stopWatchingCoordinator = coordinator.subscribe(notify)
    watch(created)
    setMode({ kind: 'editing' })
    syncSaving()
    const loss = pendingLoss
    pendingLoss = undefined
    if (loss !== undefined)
      void lose(loss)
    return 'entered'
  }

  // ---- 失去编辑权 ----

  /** 失去编辑权（§3.4）：停止保存 → 提交正在编辑的单元格、捕获 → 重建为只读、显示本页的内容 → 说明，按需核对结果未知的保存 */
  async function lose(loss: LeaseLoss): Promise<void> {
    const token = begin({ kind: 'losing', loss })
    lease = undefined
    lostAt = options.now()
    copyQuery = undefined
    const saver = coordinator
    const page = editor
    syncSaving()
    let snapshot: string | undefined
    try {
      if (page?.isCellEditing() === true)
        await page.commitCellEditing()
      snapshot = page?.capture()
    }
    catch (error) {
      options.reportError(error)
    }
    if (!still(token))
      return
    const readable = loss.kind !== 'not-found'
    const lostMode: LostMode = { kind: 'lost', loss, unsaved: true, readable, checking: false, captureFailed: false, copy: { kind: 'idle' }, reload: { kind: 'idle' } }
    if (snapshot === undefined) {
      // 捕获失败：编辑器留着（用户还能复制出来），不自动重建，不给副本（P2 设计 §7 的风险表）。有没有没保存的修改照保存的状态机说
      // （离开提示随之）
      begin({ ...lostMode, unsaved: saver?.hasUnsavedWork() ?? false, captureFailed: true })
      return
    }
    // 在途的保存先有结果：它可能正好把本页的内容存上了
    await saver?.settled()
    if (!still(token))
      return
    lostSnapshot = snapshot
    const created = await rebuild('read', snapshot)
    if (!still(token)) {
      created?.dispose()
      return
    }
    if (created === undefined) {
      fail(new Error('失去编辑权之后以只读重建编辑器失败'))
      return
    }
    watch(created)
    // 结果未知的保存：还读得到时先原样重发它，核对它其实提交了没有（读不到了时核对不了：重放也要求能访问）
    const checkFirst = readable && saver?.hasUnknownOutcome() === true
    const checkToken = begin({ ...lostMode, unsaved: saver?.hasUnsavedWork() ?? false, checking: checkFirst })
    if (!checkFirst || saver === undefined)
      return
    await saver.replayUnknownOutcome()
    if (still(checkToken) && mode.kind === 'lost')
      setMode({ ...mode, checking: false, unsaved: saver.hasUnsavedWork() })
  }

  /**
   * 按服务端的最新内容重建为阅读（放弃本页的修改、没有修改时重新加载、另存为副本之后）。放弃时读不到了：显示"内容不存在"；
   * 别的失败留在失去编辑权、说明原因、可以再试（另存为副本之后也是：副本已经建好，说明照旧给出）
   */
  async function reloadLatest(from: LostMode): Promise<void> {
    const copied = from.copy.kind === 'done' ? from.copy.document : undefined
    const token = begin({ ...from, reload: { kind: 'loading' } })
    let content: LoadedContent
    try {
      content = await api.content(documentId)
    }
    catch (error) {
      if (!still(token))
        return
      if (isNotFoundError(error) && copied === undefined) {
        disposeCoordinator()
        disposeEditor()
        surface = 'none'
        begin({ kind: 'unavailable' })
        return
      }
      if (isAuthenticationError(error))
        hooks.readProblem(error)
      begin({ ...from, reload: { kind: 'failed', error } })
      return
    }
    if (!still(token))
      return
    const created = await rebuild('read', content.snapshot)
    if (!still(token)) {
      created?.dispose()
      return
    }
    if (created === undefined) {
      fail(new Error('按最新的内容重建编辑器失败'))
      return
    }
    disposeCoordinator()
    lostSnapshot = undefined
    enterReading(created, content, readingAfter(from.loss, copied === undefined ? undefined : { kind: 'copied', document: copied }))
  }

  // ---- 对外 ----

  return {
    view: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    open: async (initial, { enterEdit }) => {
      shown = { snapshot: initial.snapshot, revision: initial.revision }
      readingBefore = { kind: 'reading', canEdit: initial.canEdit, holder: undefined, update: 'none', gone: false, notice: undefined }
      const token = generation
      if (enterEdit && initial.canEdit) {
        let acquisition: LeaseAcquisition | undefined
        try {
          acquisition = await acquire()
        }
        catch (error) {
          // 能不能编辑刚变了（403）：照常阅读。读不到了（404）、未登录、网络等：与读取元数据、内容失败相同
          if (!isPermissionDeniedError(error))
            return disposed ? { kind: 'opened', entered: false } : { kind: 'load-failed', error }
          readingBefore = { ...readingBefore, canEdit: false, notice: { kind: 'denied', error } }
        }
        if (!still(token)) {
          if (acquisition?.kind === 'acquired')
            void acquisition.lease.release()
          return { kind: 'opened', entered: false }
        }
        if (acquisition?.kind === 'acquired') {
          const started = await startEditing(token, acquisition.lease, acquisition.revision)
          if (started === 'entered')
            return { kind: 'opened', entered: true }
          if (typeof started === 'object')
            return { kind: 'load-failed', error: started.error }
          return mode.kind === 'failed' ? { kind: 'editor-failed', error: mode.error } : { kind: 'opened', entered: false }
        }
        if (acquisition?.kind === 'held')
          readingBefore = { ...readingBefore, holder: acquisition.holder }
      }
      const created = await rebuild('read', shown.snapshot)
      if (!still(token)) {
        created?.dispose()
        return { kind: 'opened', entered: false }
      }
      if (created === undefined) {
        const error = new Error('编辑器加载失败')
        fail(error)
        return { kind: 'editor-failed', error }
      }
      enterReading(created, shown, readingBefore)
      return { kind: 'opened', entered: false }
    },

    enter: async () => {
      if (mode.kind !== 'reading' || !mode.canEdit || mode.gone || disposed)
        return
      readingBefore = { ...mode, notice: undefined }
      const token = begin({ kind: 'entering' })
      let acquisition: LeaseAcquisition
      try {
        acquisition = await acquire()
      }
      catch (error) {
        if (still(token))
          begin(readingAfterFailure(error))
        return
      }
      if (!still(token)) {
        if (acquisition.kind === 'acquired')
          void acquisition.lease.release()
        return
      }
      if (acquisition.kind === 'held') {
        begin({ ...readingBefore, holder: acquisition.holder })
        return
      }
      const started = await startEditing(token, acquisition.lease, acquisition.revision)
      if (typeof started === 'object' && still(token))
        begin(readingAfterFailure(started.error))
    },

    exit: async () => {
      const saver = coordinator
      const held = lease
      const page = editor
      if (mode.kind !== 'editing' || saver === undefined || held === undefined || page === undefined)
        return
      const token = begin({ kind: 'exiting' })
      // 先保存（在途的那一次先有结果）：没有全部存上（保存失败、版本冲突、提交不了正在编辑的单元格、公式结果还没收齐）就留在编辑，
      // 说明由保存的状态给出
      await saver.settled()
      if (!still(token))
        return
      if (saver.hasUnsavedWork()) {
        await saver.save()
        if (!still(token))
          return
        if (saver.hasUnsavedWork()) {
          begin({ kind: 'editing' })
          return
        }
      }
      let snapshot: string
      try {
        snapshot = page.capture()
      }
      catch (error) {
        options.reportError(error)
        if (still(token))
          begin({ kind: 'editing' })
        return
      }
      // 释放：等它的结果（结果未知也照样退出：租约 90 秒内自行到期）
      await held.release()
      if (!still(token))
        return
      lease = undefined
      const revision = saver.baseRevision()
      disposeCoordinator()
      const created = await rebuild('read', snapshot)
      if (!still(token)) {
        created?.dispose()
        return
      }
      if (created === undefined) {
        fail(new Error('退出编辑时以只读重建编辑器失败'))
        return
      }
      enterReading(created, { snapshot, revision }, { kind: 'reading', canEdit: true, holder: undefined, update: 'none', gone: false, notice: undefined })
    },

    save: async () => {
      if (mode.kind === 'editing')
        await coordinator?.save()
    },

    refresh: async () => {
      if (mode.kind !== 'reading' || mode.update !== 'available' || disposed)
        return
      const token = begin({ ...mode, update: 'loading', notice: undefined })
      let fetched: LoadedContent | typeof CONTENT_UNCHANGED | undefined
      let failure: unknown
      try {
        fetched = await api.contentIfChanged(documentId, shown.revision)
      }
      catch (error) {
        failure = error
      }
      if (!still(token) || mode.kind !== 'reading')
        return
      const reading = mode
      if (fetched === undefined) {
        if (isNotFoundError(failure)) {
          begin({ ...reading, update: 'none', gone: true, canEdit: false, holder: undefined })
          return
        }
        if (isAuthenticationError(failure))
          hooks.readProblem(failure)
        begin({ ...reading, update: 'available', notice: { kind: 'refresh-failed', error: failure } })
        return
      }
      if (fetched === CONTENT_UNCHANGED) {
        begin({ ...reading, update: 'none' })
        return
      }
      const created = await rebuild('read', fetched.snapshot)
      if (!still(token)) {
        created?.dispose()
        return
      }
      if (created === undefined) {
        fail(new Error('按新的版本重建编辑器失败'))
        return
      }
      enterReading(created, fetched, { ...reading, update: 'none', gone: false, notice: undefined })
    },

    saveCopy: async () => {
      if (mode.kind !== 'lost' || !mode.readable || !mode.unsaved || mode.checking || mode.captureFailed
        || mode.copy.kind === 'saving' || mode.copy.kind === 'done' || mode.reload.kind === 'loading' || lostSnapshot === undefined) {
        return
      }
      const snapshot = lostSnapshot
      const query = copyQuery ?? { requestId: options.newId(), title: conflictCopyTitle(options.title(), conflictCopyLabel(lostAt ?? options.now())) }
      copyQuery = query
      const token = begin({ ...mode, copy: { kind: 'saving' } })
      let created: CreatedDocument
      try {
        created = await api.conflictCopy(documentId, query, await api.compress(snapshot))
      }
      catch (error) {
        // 确定被拒绝：这一次没有建，下次换新的 requestId；结果未知时沿用（服务端只建一份）。内容一律留着，可以再试
        // （读不到时也是：可能只是取锁之前被移到了别的空间，再试会成功）
        if (isDefiniteRejection(error))
          copyQuery = undefined
        if (isAuthenticationError(error) || isCsrfTokenError(error))
          hooks.writeProblem(error)
        if (still(token) && mode.kind === 'lost')
          begin({ ...mode, copy: { kind: 'failed', error } })
        return
      }
      copyQuery = undefined
      if (!still(token) || mode.kind !== 'lost')
        return
      // 内容已经保住：本页按服务端的最新内容重建为阅读，说明已另存为副本（取不到最新的版本时留在这里，说明之后可以重新加载）
      await reloadLatest({ ...mode, copy: { kind: 'done', document: created } })
    },

    discard: async () => {
      if (mode.kind !== 'lost' || !mode.readable || mode.checking || mode.copy.kind === 'saving' || mode.reload.kind === 'loading')
        return
      await reloadLatest(mode)
    },

    hasUnsavedWork: () => {
      switch (mode.kind) {
        case 'editing':
          return coordinator?.hasUnsavedWork() ?? false
        case 'exiting':
        case 'losing':
          return true
        case 'lost':
          return mode.unsaved && mode.copy.kind !== 'done'
        case 'opening':
        case 'reading':
        case 'entering':
        case 'failed':
        case 'unavailable':
          return false
      }
    },

    setSession: (next) => {
      const previous = session
      session = next
      syncSaving()
      if (next !== 'active') {
        lease?.pause()
        stopChecks()
        return
      }
      // 从未登录或换了人回到本人：之前"登录已过期""请求已失效"这类保存失败的说明不再成立（复验 RB2）
      if (previous !== 'active') {
        coordinator?.dismissSessionProblem()
        if (mode.kind === 'reading')
          checkNow()
      }
    },

    resumeLease: async () => {
      await lease?.resume()
    },

    updateCanEdit: (canEdit) => {
      if (mode.kind === 'reading' && !mode.gone && mode.canEdit !== canEdit)
        setMode({ ...mode, canEdit, notice: mode.notice?.kind === 'denied' && canEdit ? undefined : mode.notice })
    },

    noteActivity: () => lease?.noteActivity(),

    releaseOnHide: () => {
      void lease?.release()
    },

    dispose: () => {
      if (disposed)
        return
      disposed = true
      generation += 1
      stopChecks()
      stopWatchingVisibility()
      void lease?.release()
      lease = undefined
      disposeCoordinator()
      disposeEditor()
      listeners.clear()
    },
  }
}
