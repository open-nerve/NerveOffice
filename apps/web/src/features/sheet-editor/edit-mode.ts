// 阅读与编辑（M3-P2 设计 §3.1、§3.4）：编辑器页里"现在是阅读还是编辑、编辑权怎样了"的状态机。不依赖 Univer 与界面：编辑器经工厂创建，
// 接口、时钟与页面的可见性都可注入，用假的做单元测试（edit-mode.test.ts）。这里只留各条转移（打开、进入、退出、失去编辑权、刷新、
// 另存为副本与放弃）与它们之间的作废；持有编辑租约（edit-lease.ts）与保存的状态机（save-coordinator.ts）。分出去的三样：
// - 编辑器槽位（editor-slot.ts）：当前的编辑器、surface 与在途的那一次创建，单飞的重建——同一个容器里至多一个编辑器（审查 A1）；
// - 阅读时的检查（reading-checks.ts）：计时、暂停与恢复，只认最新发出的那一次检查（审查 A9）；
// - 失去编辑权之后的那一份（lost-copy.ts）：捕获的内容、失去的时刻与副本的请求，每失去一次编辑权一个。
// 载入、会话与页头的编排在 editor-page.ts。
//
// 模式切换一律重建（§3.1，需求方 2026-10-04 决定）：进入编辑、退出编辑、失去编辑权、"有更新，点击刷新"、放弃本页的修改，都先取出
// 视图状态、销毁当前的编辑器（Univer 实例与公式 Worker），再以目标的 access 与选定的快照新建一个，就绪之后恢复视图状态。
// 新建期间编辑器页挂着交互屏障（surface 为 creating）；可编辑的编辑器先建好保存的状态机、再接上（撤掉屏障），放开之后的每一处修改
// 都有人接着（Codex 评审 CX1）。不做原地切换，也不在同一个实例里 disposeUnit 再创建（§2：那样新单元的只读不完整）。
//
// 状态（§3.4 的表）：
// - opening：载入之后、第一个编辑器就绪之前；
// - reading：只读的编辑器。canEdit 决定有没有"编辑"；holder 是正在编辑的人（编辑状态或申请被占用时给出）；update 是服务端有没有
//   更新的版本（loading 时正在按它重建，这期间不能进入编辑，审查 A1）；gone 是这份文档读不到了；notice 是上一次操作留下的说明；
//   releaseUnconfirmed 是本页刚退出编辑、没能确认放掉编辑权（审查 A13；至多一个有效期，复验 C4）。阅读时读编辑状态：进入阅读时立即一次，之后每 30 秒一次
//   （页面隐藏、会话不是本人时暂停，回到前台、回到本人时立即读一次）；
// - entering：申请编辑权、按需要取最新的内容、重建为可编辑（交互屏障挡住期间的输入）；
// - editing：可编辑的编辑器与保存的状态机；
// - exiting：先保存（保存失败就留在编辑），捕获，释放编辑权（等它的结果，至多 EXIT_RELEASE_WAIT_MS；结果未知、到了时限也照样退出），
//   重建为只读；
// - losing / lost：失去编辑权（续租或保存得知，续上没有成功；P1 的续上规则不变）：停止保存，提交正在编辑的单元格、捕获本页的内容，
//   重建为只读、显示本页的内容（重建失败时留在 lost，说明编辑器没能重新打开，副本照常给，审查 A3）。还读得到（不是 404）而且有没保存的
//   修改：给"另存为副本"与"放弃本页的修改"；有一次结果未知的保存时，给副本之前先原样重发它（重放先于登录与租约，P1）——拿到原来的
//   结果就按已保存处理。副本被拒、再试也一样（本页过旧、内容不合规则或太大，M3-P3 审查 B3）：不再给副本，内容留着。
//   读不到了（404）：说明，本页的内容不再能保存。另存为副本之后按最新的内容重建失败也留在 lost（副本的说明照旧，复验 C1）；
// - failed：编辑器建不起来（页面按"编辑器加载失败"说明，可以重新加载）；unavailable：放弃本页的修改时读不到了（"内容不存在"）。
// 每开始一件事（进入、退出、失去编辑权、刷新、放弃）都换一个标识：之前那件事在等待之后发现标识变了，就不再接着做。
//
// 自动保存（M3-P4 设计 §3.1–§3.10）：调度（autosave.ts）跟保存的状态机同生命周期——进入编辑时先建保存的状态机、再建调度、再接上编辑器；
// 去掉保存的状态机时一并去掉；失去编辑权开始时立即去掉（在途的那一次由保存的状态机收尾）；终态之后它自己停。退出编辑：先挂起调度，
// 有没存的就立即上传一次（flush('exit')：先等面板的防抖、提交单元格、等公式），等在途的都有结果，仍有没存的就恢复调度、留在编辑。
// 保存按钮与快捷键是立即上传（flush('save-button')：不去重，在途时排一次）。进入编辑时申请编辑权的响应带"公式待更新"：以强制全量重算
// 重建（slot.replace 的 recalculate），保存的状态机与调度都以它起步，收齐之后补存、服务端清掉标记。阅读时说明"公式待更新"（ReadingMode 的
// formulasPending：载入时详情的、之后每 30 秒的编辑状态里的，只认本页显示的那一版的）。页面关闭（pagehide）时有保存在途就不释放编辑权，
// 让它到期——否则释放多半先提交、那次保存被拒（releaseOnHide）。
//
// 与服务端不兼容（M3-P3 设计 §3.5、§3.10）：
// - 编辑时保存或续租得到 CLIENT_OUTDATED（本页过旧）、DOCUMENT_TOO_NEW（文档比服务端新）：保存的状态机转入终态（需要刷新、不能保存），
//   编辑租约停止续租、放掉手里那一代；编辑器留着（本页的修改还能复制出来），页头说明并给"重新加载"（过旧时）；
// - 申请编辑权得到它们：留在阅读并说明，不再给"编辑"（blocked）；打开时就看得出文档比本页新（详情的 sdkVersion）同样只能阅读；
// - 不兼容的阅读不会因为检查读到能编辑就恢复"编辑"：重新加载才是新的页面。
//
// 打开自检（M3-P4 设计 §3.11–§3.13）：任何一次新建都看新编辑器的 openCheck（打开、?edit=new、"编辑"、退出编辑、"有更新"、失去编辑权之后、
// 放弃与副本之后），失败的上报服务端（每次创建至多一次，会话不是本人时不发，不看结果）。阅读时失败：阅读态带上 damaged（与 blocked 分开），
// 不给"编辑"、页头说明；不因检查读到能编辑而恢复，"有更新"重建之后按新内容的结果覆盖。失败的编辑器绝不保存：以可编辑新建的编辑器
// 先看打开自检、再建保存的状态机与调度——失败时释放编辑权、以只读重建、以 damaged 回到阅读（?edit=new 与"编辑"只能先取得编辑权再按它
// 选内容，所以是"先取后放"）。失去编辑权之后的重建失败只上报，不改失去编辑权之后的选项（副本是本页的内容，服务端照常检查）。
import type { ConflictCopyQuery, CreatedDocument, DocumentDetail, OpenCheckReport, SaveContentResponse } from '@nerve-office/contracts'
import type { OpenCheck, SheetEditor } from '../../editor/index.ts'
import type { Autosave, AutosaveEvent, AutosavePage, AutosaveTuning, AutosaveView } from './autosave.ts'
import type { Incompatibility } from './client-format.ts'
import type { EditLease, EditLeaseApi, LeaseAcquisition, LeaseClock, LeaseHolder, LeaseLoss } from './edit-lease.ts'
import type { FetchedEditStatus, LeaseCredentials, LoadedContent } from './editor-api.ts'
import type { CreateModeEditor, EditorSurface } from './editor-slot.ts'
import type { LostCopy } from './lost-copy.ts'
import type { OpenCheckContext } from './open-check-report.ts'
import type { PageVisibility, ReadingCheckResult } from './reading-checks.ts'
import type { CompressSnapshot, SaveCoordinator, SaveRequest, SaveStatus, SaveView } from './save-coordinator.ts'
import { EDIT_LEASE_TTL_SECONDS } from '@nerve-office/contracts'
import { ApiError, isAuthenticationError, isCsrfTokenError, isNotFoundError, isPermissionDeniedError } from '../../shared/api/index.ts'
import { createAutosave } from './autosave.ts'
import { incompatibilityOf } from './client-format.ts'
import { acquireEditLease, leaseHolderOf, leaseLossOf } from './edit-lease.ts'
import { CONTENT_UNCHANGED } from './editor-api.ts'
import { createEditorSlot } from './editor-slot.ts'
import { createLostCopy } from './lost-copy.ts'
import { openCheckReportOf } from './open-check-report.ts'
import { createReadingChecks } from './reading-checks.ts'
import { createSaveCoordinator } from './save-coordinator.ts'

/**
 * 退出编辑时等释放的结果，至多这么久（审查 A7）：释放只是让别人早一点能编辑，不影响正确性——没送到的那一代至多一个有效期
 * （EDIT_LEASE_TTL_SECONDS，90 秒）后自行到期，本页再申请时同一个 clientInstanceId 按重试处理、照样取得。请求挂住（代理不回、
 * 连接卡住）时要等浏览器自己超时，页面一直停在"正在退出编辑…"、交互屏障挡着、没有办法取消；5 秒够一次正常的释放（通常几十毫秒），
 * 到了时限照样退出，阅读页如实说明那一代可能还在（releaseUnconfirmed）
 */
export const EXIT_RELEASE_WAIT_MS = 5_000

/** 本页显示的内容：快照的原文与它的修订号（阅读时是服务端那一版；退出编辑之后是保存确认过的那一版） */
interface ShownContent {
  readonly snapshot: string
  readonly revision: number
}

/** 服务端最近一次说的某一版的"公式待更新"（载入时的详情、阅读时的编辑状态、申请编辑权的回答）：阅读页只认本页显示的那一版的 */
interface FormulasFlag {
  readonly revision: number
  readonly formulasPending: boolean
}

/**
 * 打开自检的失败清单（不空，按种类与资源名排好）：编辑器没有完整载入这份文档的数据，或者编辑器自己没有完整载入（档案不全，
 * contracts 的 isProfileFailure）。M3-P4 设计 §3.11、§3.12
 */
export type OpenCheckFailures = Extract<OpenCheck, { readonly ok: false }>['failures']

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
  /** 服务端有比本页新的版本：available 时提示"有更新，点击刷新"，loading 正在取它、按它重建（这期间不能进入编辑） */
  readonly update: 'none' | 'available' | 'loading'
  /** 这份文档已经读不到了（编辑状态、进入编辑或刷新时得到 404） */
  readonly gone: boolean
  readonly notice: ReadingNotice | undefined
  /**
   * 本页刚退出编辑，没能确认放掉编辑权（释放的结果未知、超过了等待的上限）：那一代可能还在服务端，至多一个有效期后自行到期。
   * 这期间编辑状态里"自己在别处编辑"多半就是本页的那一代（同一个 clientInstanceId，再点"编辑"就能进入），页面按此说明，
   * 不说成另一个标签页（审查 A13）；读到持有者不是自己了随之清掉。有时限：退出之后过了一个有效期，那一代必然已经到期，
   * 之后读到的"自己"一定在别处，随之清掉（复验 C4）
   */
  readonly releaseUnconfirmed: boolean
  /**
   * 本页与服务端不兼容（M3-P3）：本页的版本过旧（申请或编辑时得到 CLIENT_OUTDATED）、文档由更新的版本写过（打开时按详情判断、
   * 或者申请时得到 DOCUMENT_TOO_NEW）。不给"编辑"，页头说明；不因检查读到能编辑而恢复。没有时为 undefined
   */
  readonly blocked: Incompatibility | undefined
  /**
   * 本页显示的这一版带"公式待更新"（M3-P4 设计 §3.5 第 4 条）：上次保存时公式还没算完，显示的公式结果可能不对。载入时取详情的，
   * 之后每 30 秒的编辑状态里修订号就是本页这一版时随之更新；"有更新"重建之后按那一版的（不知道时为假，下一次检查补上）。
   * 页面放进一直在的读屏状态区说明，进入编辑时强制重算
   */
  readonly formulasPending: boolean
  /**
   * 本页显示的这一版没能完整载入（打开自检失败，M3-P4 设计 §3.12）：失败清单。不给"编辑"，页头说明（数据不完整，或者编辑器没有完整载入）；
   * 不因检查读到能编辑而恢复；"有更新"重建之后按新内容的结果覆盖。与 blocked（不兼容）分开：原因与处理都不同。没有时为 undefined
   */
  readonly damaged: OpenCheckFailures | undefined
}

/**
 * 服务端不收本页的这份内容、再试也一样（M3-P3 审查 B3）：
 * - outdated：本页的版本过旧（CLIENT_OUTDATED）——服务端对副本同样拦旧页面（设计 §3.5），要重新加载页面，本页的内容先复制出来；
 * - content：内容本身不合规则（SNAPSHOT_INVALID，规则在错误的详情里）或者超过容量上限（PAYLOAD_TOO_LARGE）——失去编辑权时捕获的内容
 *   不会再变
 */
export type CopyRefusal = 'outdated' | 'content'

/** 另存为副本的进展 */
export type CopyState
  = | { readonly kind: 'idle' }
    | { readonly kind: 'saving' }
  /** 没有成功、可以再试（网络、服务端出错、登录的问题、读不到、请求标识被占用等）：内容一律留着 */
    | { readonly kind: 'failed', readonly error: unknown }
  /** 被拒、再试也一样（refusal）：不再给"另存为副本"，内容照样留着（离开照样提示） */
    | { readonly kind: 'refused', readonly refusal: CopyRefusal, readonly error: ApiError }
    | { readonly kind: 'done', readonly document: DocumentDetail }

/** 按服务端的最新内容重建为阅读（放弃本页的修改、重新加载、另存为副本之后）的进展 */
export type ReloadState
  = | { readonly kind: 'idle' }
    | { readonly kind: 'loading' }
    | { readonly kind: 'failed', readonly error: unknown }

export interface LostMode {
  readonly kind: 'lost'
  readonly loss: LeaseLoss
  /** 本页有服务端没有确认的内容（销毁可编辑的编辑器之前算；核对过结果未知的保存之后随之更新） */
  readonly unsaved: boolean
  /** 还读得到这份文档（不是 404）：有修改时给副本，没有修改时可以重新加载 */
  readonly readable: boolean
  /** 正在核对结果未知的那次保存（原样重发）：核对完才给副本 */
  readonly checking: boolean
  /** 本页的内容没能取出（捕获时 SDK 出错）：编辑器留着（还能复制），不给副本、不自动重建 */
  readonly captureFailed: boolean
  /**
   * 单元格里正在输入的内容提交不了（SDK 提交之后仍在编辑）：捕获、显示的内容与副本里都没有它，算作没有保存（审查 A4）。
   * 别的修改照常在捕获里
   */
  readonly inputLeft: boolean
  /**
   * 以只读重建编辑器失败：页面上没有编辑器（说明编辑器没能重新打开）；捕获的内容还在，副本照常给，离开照常提示（审查 A3）。
   * 另存为副本之后按最新的内容重建失败也是：副本的说明与链接照旧，可以重新加载（复验 C1）
   */
  readonly reopenFailed: boolean
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

export interface EditModeView {
  readonly mode: EditModeState
  /** 编辑时（与退出编辑的过程中）才有：保存的状态 */
  readonly save: SaveView | undefined
  /** 同上：自动保存这一侧的状态（联网、会话、会不会自动重试），页头连同 save 给出保存状态的全集（save-indicator.ts） */
  readonly autosave: AutosaveView | undefined
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
  /** 打开自检失败的上报（M3-P4 设计 §3.13）：204；失败时抛出请求层的错误（这里不看结果、不重试） */
  readonly reportOpenCheck: (documentId: string, report: OpenCheckReport) => Promise<void>
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

export interface EditModeOptions {
  readonly documentId: string
  /** 本页这次加载的标识：编辑租约绑定它，保存也带着它 */
  readonly clientInstanceId: string
  readonly api: EditModeApi
  readonly createEditor: CreateModeEditor
  /** 单调的"现在"与计时器：编辑租约的心跳、阅读时的检查、退出时等释放的上限 */
  readonly clock: LeaseClock
  readonly visibility: PageVisibility
  /** 本页最后一次键盘、鼠标操作的时刻（clock.now 的时间轴上） */
  readonly lastActivity: () => number
  readonly newId: () => string
  /** 现在的墙上时间：另存为副本的标题里的时间（失去编辑权的时刻，页面所在的时区，写到分钟） */
  readonly now: () => Date
  /** 原文档现在的标题：另存为副本的标题以它开头 */
  readonly title: () => string
  readonly session: EditModeSessionHooks
  /** 自动保存（M3-P4）：页面的信号、快照的摘要与测试构建的控制 */
  readonly autosave: EditModeAutosave
  /** 意外的错误：上报（浏览器的 reportError） */
  readonly reportError: (error: unknown) => void
}

/** 自动保存要的页面一侧（编辑器页给出，M3-P4 设计 §3.10） */
export interface EditModeAutosave {
  /** 可见性、联网与会话（confirmedForWrite 的口径）：可见性的变化在 visibilitychange 里同步通知 */
  readonly page: AutosavePage
  /** 快照 UTF-8 字节的摘要（会话内去重，editor-api.ts 的 snapshotDigest） */
  readonly digest: (snapshot: string) => Promise<string>
  /** 测试构建的控制（M3-P4 设计 §3.14）：节奏与暂停；生产不给（固定的默认值） */
  readonly tuning?: AutosaveTuning | undefined
  /** 测试构建的控制：每次捕获与上传的日志 */
  readonly observe?: ((event: AutosaveEvent) => void) | undefined
  /** 测试构建的控制：当前的调度（控制的 flush 调它）；建好时交出，去掉时交出 undefined */
  readonly attach?: ((autosave: Autosave | undefined) => void) | undefined
}

/**
 * 打开的结果：编辑器就绪了（entered：直接进入了编辑；damaged：打开自检失败、只能阅读——?edit=new 这时已经释放了编辑权，地址里的标记
 * 也该去掉，刷新不再"先取后放"一次）；编辑器建不起来；载入失败（直接进入编辑时申请得到读不到、未登录）
 */
export type OpenOutcome
  = | { readonly kind: 'opened', readonly entered: boolean, readonly damaged: boolean }
    | { readonly kind: 'editor-failed', readonly error: unknown }
    | { readonly kind: 'load-failed', readonly error: unknown }

export interface EditMode {
  readonly view: () => EditModeView
  readonly subscribe: (listener: () => void) => () => void
  /**
   * 打开（载入之后）：以只读创建，进入阅读。enterEdit（地址带 ?edit=new、而且能编辑）时直接申请编辑权、以可编辑创建
   * （新建的表格不必先阅读，M3 总设计 §2.1 的细化）；被占用、不能编辑了或请求失败就照常阅读、说明原因（与"编辑"相同，审查 A11），
   * 读不到了（404）、未登录按载入失败。blocked（打开时就看得出与服务端不兼容，M3-P3）：只能阅读，不直接进入编辑。
   * 新建的编辑器打开自检失败（M3-P4）：只能阅读（damaged）；直接进入编辑时已经取得的编辑权随即释放（先取后放），结果的 damaged 为真
   */
  readonly open: (initial: { readonly snapshot: string, readonly revision: number, readonly canEdit: boolean, readonly formulasPending?: boolean }, options: { readonly enterEdit: boolean, readonly blocked?: Incompatibility | undefined }) => Promise<OpenOutcome>
  /** 进入编辑（阅读、能编辑、没有在按新的版本重建时；"编辑"按钮，会话由页面先确认） */
  readonly enter: () => Promise<void>
  /** 退出编辑（"退出编辑"按钮，会话由页面先确认） */
  readonly exit: () => Promise<void>
  /**
   * 立即保存一次（编辑时；按钮与快捷键）：自动保存的立即上传，不去重，在途时排一次。按下的这一刻就提交这一刻开着的单元格编辑、开始等面板
   * （之后才开始的输入不提交，审查 A1），ready（页面的会话确认）为真、而且仍在编辑时才上传；不给 ready 时直接上传
   */
  readonly save: (ready?: () => Promise<boolean>) => Promise<void>
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
  /**
   * 页面关闭（pagehide）：尽力释放编辑权（不等结果）。有保存在途（含终态之后核对的原样重发）时不释放，让租约到期（M3-P4 设计 §3.4）：
   * 服务端处理保存先在子进程里检查快照、再进事务读租约，晚几毫秒发出的释放多半先提交，那次保存就被拒（released）
   */
  readonly releaseOnHide: () => void
  /** 停止计时器，尽力释放编辑权，销毁保存的状态机与编辑器 */
  readonly dispose: () => void
}

/** 进入编辑之前的阅读（没有进入成功时回到它）：不会是正在按新的版本重建的那种（那时不能进入编辑，审查 A1） */
type SettledReading = ReadingMode & { readonly update: 'none' | 'available' }

/** 失去编辑权之后的阅读：被收回、不能编辑了时没有"编辑"（之后随编辑状态更新）；别处在编辑时说明是谁 */
function readingAfter(loss: LeaseLoss, notice: ReadingNotice | undefined): ReadingMode {
  const canEdit = loss.kind !== 'denied' && !(loss.kind === 'lease' && loss.reason === 'revoked')
  return { kind: 'reading', canEdit, holder: loss.kind === 'held' ? loss.holder : undefined, update: 'none', gone: false, notice, releaseUnconfirmed: false, blocked: undefined, formulasPending: false, damaged: undefined }
}

/** 副本的失败是不是"再试也一样"（见 CopyRefusal）：是的话给出是哪一种与那次的错误 */
function copyRefusalOf(error: unknown): { readonly refusal: CopyRefusal, readonly error: ApiError } | undefined {
  if (!(error instanceof ApiError))
    return undefined
  if (incompatibilityOf(error) === 'client-outdated')
    return { refusal: 'outdated', error }
  return error.code === 'SNAPSHOT_INVALID' || error.code === 'PAYLOAD_TOO_LARGE' ? { refusal: 'content', error } : undefined
}

/** 保存的状态里的不兼容（终态）：退出编辑之后的阅读照样带着它 */
function blockedBy(status: SaveStatus | undefined): Incompatibility | undefined {
  if (status === 'outdated')
    return 'client-outdated'
  return status === 'too-new' ? 'document-too-new' : undefined
}

const UTF8 = new TextEncoder()

export function createEditMode(options: EditModeOptions): EditMode {
  const { documentId, api, clock, session: hooks } = options
  const listeners = new Set<() => void>()
  let mode: EditModeState = { kind: 'opening' }
  let lease: EditLease | undefined
  let coordinator: SaveCoordinator | undefined
  let stopWatchingCoordinator: (() => void) | undefined
  /** 自动保存的调度（与保存的状态机同生命周期）与对它的视图的订阅 */
  let autosave: Autosave | undefined
  let stopWatchingAutosave: (() => void) | undefined
  /** 服务端最近一次说的某一版的"公式待更新"（阅读页的说明只认本页显示的那一版，ReadingMode.formulasPending） */
  let latestFlag: FormulasFlag | undefined
  /** 本页显示的内容（阅读时）：进入编辑时与申请得到的修订号比较，"有更新"时作条件读取的基准 */
  let shown: ShownContent = { snapshot: '', revision: 0 }
  /** 保存的状态机建好之前保存的基准（进入编辑时选定的那一份内容的修订号）：续上时比较 */
  let editingBase = 0
  /** 进入编辑之前的阅读：没有进入成功时回到它 */
  let readingBefore: SettledReading = { kind: 'reading', canEdit: false, holder: undefined, update: 'none', gone: false, notice: undefined, releaseUnconfirmed: false, blocked: undefined, formulasPending: false, damaged: undefined }
  /** 失去编辑权之后的那一份（捕获的内容、失去的时刻与副本的请求）：按最新的内容回到阅读之后丢掉 */
  let lostCopy: LostCopy | undefined
  /** 正在新建可编辑的编辑器（进入编辑、直接进入编辑的打开）：这期间得知的失效等编辑器建好、进入编辑之后再处理 */
  let pendingLoss: LeaseLoss | undefined
  /** 同上：这期间续租得知的与服务端不兼容（M3-P3），保存的状态机建好之后交给它 */
  let pendingBlock: Incompatibility | undefined
  /** 本页最近一次退出编辑没能确认放掉的那一代必然已经到期（watchUnconfirmedRelease）：之后的检查读到"自己在编辑"不再是本页那一代 */
  let unconfirmedExpired = false
  /** 取消那一代到期的计时 */
  let cancelUnconfirmedExpiry: (() => void) | undefined
  let generation = 0
  let session: 'active' | 'signed-out' | 'other-user' = 'active'
  let disposed = false
  const slot = createEditorSlot({ createEditor: options.createEditor, onChange: () => notify(), reportError: options.reportError })
  const checks = createReadingChecks({
    clock,
    visibility: options.visibility,
    fetch: async () => api.editStatus(documentId),
    allowed: () => !disposed && mode.kind === 'reading' && session === 'active',
    onResult: applyCheck,
  })
  let current = computeView()

  /** 保存的状态只在编辑与退出编辑的过程中给出：失去编辑权之后保存的状态机还留着（核对结果未知的保存），但它的说明不再成立 */
  function computeView(): EditModeView {
    const saving = mode.kind === 'editing' || mode.kind === 'exiting'
    return { mode, save: saving ? coordinator?.view() : undefined, autosave: saving ? autosave?.view() : undefined, surface: slot.surface() }
  }

  function notify(): void {
    const next = computeView()
    if (next.mode === current.mode && next.save === current.save && next.autosave === current.autosave && next.surface === current.surface)
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
      checks.stop()
    else if (!wasReading)
      checks.checkNow()
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

  /** 服务端说的这一版的"公式待更新"（不知道时为假：下一次检查补上） */
  function formulasPendingOf(revision: number): boolean {
    return latestFlag?.revision === revision && latestFlag.formulasPending
  }

  /** 编辑器建不起来：页面说明"编辑器加载失败"（可以重新加载） */
  function fail(error: unknown): void {
    begin({ kind: 'failed', error })
  }

  /**
   * 新建的编辑器的打开自检（M3-P4 设计 §3.11–§3.13）：交回失败清单，通过时 undefined。每一次新建都在新建它的那条路径上调这里一次，
   * 所以每次创建的结果至多上报一次。会话不是本人时不发（这一次就不报了）；不看结果、不重试（上报只作诊断，不改任何状态）
   */
  function openCheckOf(created: SheetEditor, context: OpenCheckContext): OpenCheckFailures | undefined {
    const check = created.openCheck
    if (check.ok)
      return undefined
    const report = session === 'active' ? openCheckReportOf(check, context) : undefined
    if (report !== undefined)
      api.reportOpenCheck(documentId, report).catch(() => undefined)
    return check.failures
  }

  /** 接上只读的编辑器（撤掉屏障），进入阅读（随即检查一次） */
  function enterReading(created: SheetEditor, content: ShownContent, reading: ReadingMode): void {
    shown = content
    slot.attach(created)
    begin(reading)
  }

  // ---- 阅读时的检查（US-M3-05） ----

  /** 最新的那一次检查的结果：阅读时持有者、能不能编辑与"有更新"随之更新；读不到了说明；未登录交给页面确认会话 */
  function applyCheck(result: ReadingCheckResult): void {
    if (mode.kind !== 'reading')
      return
    const reading = mode
    // 正在按新的版本重建时不动 update（重建完了以新的修订号为准，审查 A1）
    const loading = reading.update === 'loading'
    if (result.kind === 'status') {
      const { status, serverTime } = result.fetched
      const holder = status.editor === null ? undefined : leaseHolderOf(status.editor, serverTime)
      latestFlag = { revision: status.revision, formulasPending: status.formulasPending }
      setMode({
        ...reading,
        // 只认本页显示的那一版的："有更新"时服务端的标记说的是更新的那一版
        formulasPending: status.revision === shown.revision ? status.formulasPending : reading.formulasPending,
        canEdit: status.canEdit,
        holder,
        update: loading ? 'loading' : (status.revision > shown.revision ? 'available' : 'none'),
        gone: false,
        // 进入编辑时的"不能编辑了"在又能编辑之后不再成立
        notice: reading.notice?.kind === 'denied' && status.canEdit ? undefined : reading.notice,
        // 持有者不再是自己：本页那一代已经不在了；那一代必然已经到期之后读到的自己也不是它（复验 C4）
        releaseUnconfirmed: reading.releaseUnconfirmed && holder?.sameUser === true && !unconfirmedExpired,
      })
    }
    else if (isNotFoundError(result.error)) {
      // 读不到了（删除、移走、失去访问）：说明，没有"编辑"与"有更新"；之后照常检查，恢复访问之后随之恢复
      setMode({ ...reading, gone: true, canEdit: false, holder: undefined, update: loading ? 'loading' : 'none' })
    }
    else if (isAuthenticationError(result.error)) {
      hooks.readProblem(result.error)
    }
    // 别的失败（网络、服务端出错）照常下一次再试
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
   * 失效了按保存失败交回；说不准时按那次的错误交回，下一次心跳或保存时再判断。
   * 与服务端不兼容（M3-P3）：本页写不进去了——停止续租、放掉手里那一代，错误照常交回（保存的状态机据此转入终态）
   */
  async function sendSave(held: EditLease, request: SaveRequest, body: Uint8Array<ArrayBuffer>): Promise<SaveContentResponse> {
    for (let resent = false; ; resent = true) {
      const credentials = held.credentials()
      try {
        return await api.save(documentId, request, body, credentials)
      }
      catch (error) {
        if (incompatibilityOf(error) !== undefined) {
          void held.release()
          throw error
        }
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

  /** 去掉自动保存的调度（在途的上传由保存的状态机收尾）：失去编辑权开始时、去掉保存的状态机时 */
  function disposeAutosave(): void {
    if (autosave === undefined)
      return
    stopWatchingAutosave?.()
    stopWatchingAutosave = undefined
    autosave.dispose()
    autosave = undefined
    options.autosave.attach?.(undefined)
  }

  function disposeCoordinator(): void {
    disposeAutosave()
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
      onIncompatible: incompatible,
    })
  }

  /**
   * 续租得知与服务端不兼容（M3-P3）：编辑租约已经停下、放掉了那一代。保存的状态机转入终态（页头说明需要刷新或不能保存）；
   * 正在新建可编辑的编辑器时记下，建好之后再交给它
   */
  function incompatible(kind: Incompatibility): void {
    if (disposed)
      return
    if (coordinator === undefined)
      pendingBlock = kind
    else
      coordinator.block(kind)
  }

  /** 编辑权没用上（进入编辑没有成功）：尽力释放，不等 */
  function dropLease(): void {
    void lease?.release()
    lease = undefined
  }

  /**
   * 退出编辑释放之后（复验 C4）：没能确认放掉时开始计时——本页不再续租，那一代的有效期从最后一次续租算，至多 EDIT_LEASE_TTL_SECONDS
   * 就到期。到了这个时刻立即读一次编辑状态（在途的那一次作废），按到期之后的回答清掉 releaseUnconfirmed：不在这里直接清掉，免得
   * 先拿到期之前读到的持有者说成"另一个标签页"，读屏随即播报一句过时的话。确认放掉了、或者又退出了一次时，之前的计时作废
   */
  function watchUnconfirmedRelease(released: boolean): void {
    cancelUnconfirmedExpiry?.()
    cancelUnconfirmedExpiry = undefined
    unconfirmedExpired = false
    if (released)
      return
    cancelUnconfirmedExpiry = clock.schedule(() => {
      cancelUnconfirmedExpiry = undefined
      unconfirmedExpired = true
      if (!disposed && mode.kind === 'reading' && mode.releaseUnconfirmed)
        checks.checkNow()
    }, EDIT_LEASE_TTL_SECONDS * 1000)
  }

  /** 释放手里的编辑权，至多等 EXIT_RELEASE_WAIT_MS：服务端确认了为 true，结果未知、到了时限为 false（照样往下走） */
  async function releaseWithin(held: EditLease): Promise<boolean> {
    let cancel: (() => void) | undefined
    const deadline = new Promise<false>((resolve) => {
      cancel = clock.schedule(() => resolve(false), EXIT_RELEASE_WAIT_MS)
    })
    try {
      return await Promise.race([held.release(), deadline])
    }
    finally {
      cancel?.()
    }
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
    else if (mode.kind === 'entering' && slot.editor() !== undefined) {
      lease = undefined
      begin({ ...readingBefore, notice: { kind: 'enter-lost', loss } })
    }
    else if (mode.kind === 'entering' || mode.kind === 'opening') {
      pendingLoss = loss
    }
  }

  /** 申请编辑权、取内容的请求失败时阅读里的说明：不能编辑了、读不到了、与服务端不兼容（M3-P3）、会话的问题与别的失败 */
  function readingAfterFailure(error: unknown): SettledReading {
    const blocked = incompatibilityOf(error)
    if (blocked !== undefined)
      return { ...readingBefore, blocked, notice: undefined }
    if (isPermissionDeniedError(error))
      return { ...readingBefore, canEdit: false, notice: { kind: 'denied', error } }
    if (isNotFoundError(error))
      return { ...readingBefore, gone: true, canEdit: false, holder: undefined, update: 'none', notice: undefined }
    if (isAuthenticationError(error) || isCsrfTokenError(error))
      hooks.writeProblem(error)
    return { ...readingBefore, notice: { kind: 'enter-failed', error } }
  }

  /**
   * 没能以可编辑的编辑器进入（以编辑方式重建失败，或者新建的编辑器打开自检失败，M3-P4 设计 §3.12）：编辑权没用上——释放它；以只读重建
   * 选定的那一份内容、回到阅读（reading 按只读的编辑器的打开自检给出阅读的样子）。期间续租得知的与服务端不兼容随之带进阅读。
   * 只读的也建不起来就是 failed
   */
  async function backToReading(token: number, content: ShownContent, reading: (damaged: OpenCheckFailures | undefined) => ReadingMode): Promise<'not-entered'> {
    pendingLoss = undefined
    const blocked = pendingBlock
    pendingBlock = undefined
    dropLease()
    const fallback = await slot.replace('read', content.snapshot)
    if (!still(token))
      return 'not-entered'
    if (fallback === undefined) {
      fail(new Error('以编辑方式重建编辑器失败，回到阅读时也没能建好'))
      return 'not-entered'
    }
    const damaged = openCheckOf(fallback, { access: 'read', trigger: 'enter', revision: content.revision })
    const next = reading(damaged)
    enterReading(fallback, content, blocked === undefined ? next : { ...next, blocked })
    return 'not-entered'
  }

  /**
   * 取得了编辑权之后：选定内容（申请得到的修订号等于本页的就用本页的，否则按条件读取取服务端的）、以可编辑重建（带"公式待更新"时
   * 强制全量重算，M3-P4 设计 §3.5）、看过打开自检，再建好保存的状态机与自动保存的调度、接上编辑器。读取失败时已经释放编辑权，交回错误
   * （调用方按它说明）；重建失败、打开自检失败时（失败的编辑器绝不保存：保存的状态机根本不建）释放编辑权、以只读重建选定的那一份内容、
   * 回到阅读并说明（backToReading）
   */
  async function startEditing(token: number, held: EditLease, acquired: { readonly revision: number, readonly formulasPending: boolean }): Promise<'entered' | 'not-entered' | { readonly error: unknown }> {
    const { revision, formulasPending } = acquired
    lease = held
    editingBase = revision
    // 申请的回答是服务端最近一次说的这一版的"公式待更新"：没能进入、回到阅读时按它说明
    latestFlag = { revision, formulasPending }
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
    // 申请时服务端说这份文档"公式待更新"（选定的内容就是申请时的那一版）：强制全量重算，收齐之后由自动保存补存（服务端随之清掉标记）
    const created = await slot.replace('edit', content.snapshot, { recalculate: formulasPending })
    if (!still(token))
      return 'not-entered'
    const formulasShown = formulasPendingOf(content.revision)
    if (created === undefined) {
      // 只读的也没完整载入时不说"可以再试"（没有"编辑"）：页头说明数据不完整
      return backToReading(token, content, damaged => ({ ...readingBefore, update: 'none', notice: damaged === undefined ? { kind: 'editor-failed' } : undefined, formulasPending: formulasShown, damaged }))
    }
    // 打开自检失败（M3-P4 设计 §3.12）：这个编辑器绝不保存——不建保存的状态机与调度，释放编辑权、以只读重建、以 damaged 进入阅读。
    // 只读的那一个照常自检、照常上报；它竟然通过了（与可编辑的不一致）也按可编辑时的结果阻止编辑，不来回"先取后放"
    const failures = openCheckOf(created, { access: 'edit', trigger: 'enter', revision: content.revision })
    if (failures !== undefined)
      return backToReading(token, content, damaged => ({ ...readingBefore, update: 'none', notice: undefined, formulasPending: formulasShown, damaged: damaged ?? failures }))
    shown = content
    // 先建保存的状态机，再建自动保存的调度，再接上编辑器（撤掉屏障）：放开之后的每一处修改都有人接着。80% 的提示在第一次保存之前按
    // 载入的内容算（M3-P3）。"公式待更新"两边以同一个初值起步：页头说公式结果尚未保存、离开会提示，收齐之后补存
    const saver = createSaveCoordinator({
      editor: created,
      compress: api.compress,
      send: async (request, body) => sendSave(held, request, body),
      baseRevision: content.revision,
      clientInstanceId: options.clientInstanceId,
      newRequestId: options.newId,
      onUnauthenticated: hooks.saveUnauthenticated,
      onSessionStale: hooks.saveStale,
      reportError: options.reportError,
      initialSnapshotBytes: UTF8.encode(content.snapshot).byteLength,
      initialFormulasPending: formulasPending,
    })
    coordinator = saver
    if (pendingBlock !== undefined)
      saver.block(pendingBlock)
    pendingBlock = undefined
    stopWatchingCoordinator = saver.subscribe(notify)
    const scheduler = createAutosave({
      editor: created,
      page: options.autosave.page,
      uploader: saver,
      clock,
      digest: options.autosave.digest,
      initialFormulasPending: formulasPending,
      tuning: options.autosave.tuning,
      observe: options.autosave.observe,
      reportError: options.reportError,
    })
    autosave = scheduler
    stopWatchingAutosave = scheduler.subscribe(notify)
    options.autosave.attach?.(scheduler)
    slot.attach(created)
    setMode({ kind: 'editing' })
    syncSaving()
    const loss = pendingLoss
    pendingLoss = undefined
    if (loss !== undefined)
      void lose(loss)
    return 'entered'
  }

  /**
   * ?edit=new 的打开：直接申请、以可编辑创建。进入了、编辑器建不起来、载入失败、页面卸载时交回打开的结果；
   * 没有进入、要照常以只读打开时交回 undefined（readingBefore 已经带上原因）
   */
  async function enterOnOpen(token: number): Promise<OpenOutcome | undefined> {
    let acquisition: LeaseAcquisition
    try {
      acquisition = await acquire()
    }
    catch (error) {
      return still(token) ? notEnteredOnOpen(error) : { kind: 'opened', entered: false, damaged: false }
    }
    if (!still(token)) {
      if (acquisition.kind === 'acquired')
        void acquisition.lease.release()
      return { kind: 'opened', entered: false, damaged: false }
    }
    if (acquisition.kind === 'held') {
      readingBefore = { ...readingBefore, holder: acquisition.holder }
      return undefined
    }
    const started = await startEditing(token, acquisition.lease, acquisition)
    if (started === 'entered')
      return { kind: 'opened', entered: true, damaged: false }
    if (typeof started === 'object')
      return notEnteredOnOpen(started.error)
    if (mode.kind === 'failed')
      return { kind: 'editor-failed', error: mode.error }
    // 打开自检失败（先取后放）：已经释放编辑权、以只读回到阅读
    return { kind: 'opened', entered: false, damaged: mode.kind === 'reading' && mode.damaged !== undefined }
  }

  /**
   * ?edit=new 没能进入：读不到了（404）、未登录与读取元数据、内容失败相同（页面说明内容不存在、转到登录页）；别的（403、网络、
   * 服务端出错、令牌失效）内容已经读到、文档本身没有问题——照常以只读打开，说明与"编辑"时相同（审查 A11）
   */
  function notEnteredOnOpen(error: unknown): OpenOutcome | undefined {
    if (isNotFoundError(error) || isAuthenticationError(error))
      return { kind: 'load-failed', error }
    readingBefore = readingAfterFailure(error)
    return undefined
  }

  // ---- 失去编辑权 ----

  /**
   * 失去编辑权（§3.4）：停止保存 → 提交正在编辑的单元格、捕获 → 等在途的保存 → 算出有没有没保存的（销毁可编辑的编辑器之前）→
   * 重建为只读、显示本页的内容（失败时留在这里，说明编辑器没能重新打开）→ 说明，按需核对结果未知的保存
   */
  async function lose(loss: LeaseLoss): Promise<void> {
    const token = begin({ kind: 'losing', loss })
    lease = undefined
    // 自动保存立即停下（在途的那一次由保存的状态机收尾）：捕获本页的内容时不再起一次上传
    disposeAutosave()
    // 副本的标题里的时间是失去编辑权的这一刻，不是点"另存为副本"的那一刻
    const lostAt = options.now()
    const saver = coordinator
    const page = slot.editor()
    syncSaving()
    let snapshot: string | undefined
    let inputLeft = false
    // 副本的"公式待更新"（M3-P3 设计 §3.8）：捕获时公式还没收齐就带上标记（这里不等，按此刻的状态）；查不出时保守地带上
    let formulasPending = true
    try {
      // 面板里防抖中的改动先写进模型（批注浮层、数据验证面板，M3-P4 设计 §3.4），副本里才有它
      await page?.settlePanels()
      // 提交不了（SDK 提交之后仍在编辑）：这次输入不在捕获里，照实说明（审查 A4）
      if (page?.isCellEditing() === true)
        inputLeft = !(await page.commitCellEditing())
      formulasPending = page === undefined || (await page.settleFormulas(0)) !== 'settled'
      snapshot = page?.capture()
    }
    catch (error) {
      options.reportError(error)
    }
    if (!still(token))
      return
    const readable = loss.kind !== 'not-found'
    const lostMode: LostMode = { kind: 'lost', loss, unsaved: true, readable, checking: false, captureFailed: false, inputLeft, reopenFailed: false, copy: { kind: 'idle' }, reload: { kind: 'idle' } }
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
    // 销毁可编辑的编辑器之前算：销毁之后它正在编辑的单元格一律算没有（审查 A4）
    const unsaved = inputLeft || (saver?.hasUnsavedWork() ?? false)
    lostCopy = createLostCopy({ documentId, snapshot, lostAt, formulasPending, title: options.title, newId: options.newId, compress: api.compress, conflictCopy: api.conflictCopy })
    const created = await slot.replace('read', snapshot)
    if (!still(token))
      return
    if (created !== undefined) {
      // 打开自检失败只上报（M3-P4 设计 §3.12）：显示的是本页自己捕获的内容，副本照常给（服务端照常检查），不改失去编辑权之后的选项
      openCheckOf(created, { access: 'read', trigger: 'lost', revision: saver?.baseRevision() ?? editingBase })
      slot.attach(created)
    }
    // 结果未知的保存：还读得到时先原样重发它，核对它其实提交了没有（读不到了时核对不了：重放也要求能访问）
    const checkFirst = readable && saver?.hasUnknownOutcome() === true
    const checkToken = begin({ ...lostMode, unsaved, checking: checkFirst, reopenFailed: created === undefined })
    if (!checkFirst || saver === undefined)
      return
    await saver.replayUnknownOutcome()
    if (still(checkToken) && mode.kind === 'lost')
      setMode({ ...mode, checking: false, unsaved: mode.inputLeft || saver.hasUnsavedWork() })
  }

  /**
   * 按服务端的最新内容重建为阅读（放弃本页的修改、没有修改时重新加载、另存为副本之后）。放弃时读不到了：显示"内容不存在"；
   * 别的失败留在失去编辑权、说明原因、可以再试（另存为副本之后也是：副本已经建好，说明照旧给出）。
   * 重建失败：已经另存为副本时同样留在失去编辑权——副本的说明与链接照旧，编辑器没能重新打开，可以重新加载（复验 C1：转入 failed 的话
   * 整页只剩"编辑器加载失败"，副本已经建好、用户却不知道它在哪里，刷新之后看到的是原文档，多半以为修改丢了）；没有副本（放弃、
   * 没有修改时的重新加载）本页的内容本来就不要了，按编辑器加载失败说明
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
        slot.clear()
        lostCopy = undefined
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
    const created = await slot.replace('read', content.snapshot)
    if (!still(token))
      return
    if (created === undefined) {
      const error = new Error('按最新的内容重建编辑器失败')
      if (copied === undefined)
        fail(error)
      else
        begin({ ...from, reopenFailed: true, reload: { kind: 'failed', error } })
      return
    }
    disposeCoordinator()
    lostCopy = undefined
    const damaged = openCheckOf(created, { access: 'read', trigger: 'reload', revision: content.revision })
    enterReading(created, content, { ...readingAfter(from.loss, copied === undefined ? undefined : { kind: 'copied', document: copied }), formulasPending: formulasPendingOf(content.revision), damaged })
  }

  // ---- 对外 ----

  return {
    view: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    open: async (initial, { enterEdit, blocked }) => {
      shown = { snapshot: initial.snapshot, revision: initial.revision }
      const formulasPending = initial.formulasPending === true
      latestFlag = { revision: initial.revision, formulasPending }
      readingBefore = { kind: 'reading', canEdit: initial.canEdit, holder: undefined, update: 'none', gone: false, notice: undefined, releaseUnconfirmed: false, blocked, formulasPending, damaged: undefined }
      const token = generation
      if (enterEdit && initial.canEdit && blocked === undefined) {
        const outcome = await enterOnOpen(token)
        if (outcome !== undefined)
          return outcome
      }
      const created = await slot.replace('read', shown.snapshot)
      if (!still(token))
        return { kind: 'opened', entered: false, damaged: false }
      if (created === undefined) {
        const error = new Error('编辑器加载失败')
        fail(error)
        return { kind: 'editor-failed', error }
      }
      const damaged = openCheckOf(created, { access: 'read', trigger: 'open', revision: shown.revision })
      enterReading(created, shown, { ...readingBefore, damaged })
      return { kind: 'opened', entered: false, damaged: damaged !== undefined }
    },

    enter: async () => {
      // 正在按新的版本取内容、重建（update 为 loading）时不进入：两次重建会叠在一起，而回到阅读时也说不清显示的是哪一版（审查 A1）。
      // 阅读时一定有接上的编辑器，没有就是还在换。打开自检失败的阅读不进入（M3-P4 设计 §3.12）
      if (mode.kind !== 'reading' || !mode.canEdit || mode.gone || mode.blocked !== undefined || mode.damaged !== undefined || mode.update === 'loading' || slot.editor() === undefined || disposed)
        return
      readingBefore = { ...mode, update: mode.update, notice: undefined }
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
        // 被占用：占着的不是本页（本页那一代还在时同一个 clientInstanceId 照样取得）
        begin({ ...readingBefore, holder: acquisition.holder, releaseUnconfirmed: false })
        return
      }
      const started = await startEditing(token, acquisition.lease, acquisition)
      if (typeof started === 'object' && still(token))
        begin(readingAfterFailure(started.error))
    },

    exit: async () => {
      const saver = coordinator
      const scheduler = autosave
      const held = lease
      const page = slot.editor()
      if (mode.kind !== 'editing' || saver === undefined || scheduler === undefined || held === undefined || page === undefined)
        return
      const token = begin({ kind: 'exiting' })
      // 开始退出就挂起自动保存的调度（定时的捕获与上传、切到后台的上传，M3-P4 设计 §3.4）：退出用的那一次是立即上传
      scheduler.suspend()
      /** 留在编辑：恢复调度（立即再看），说明由保存的状态给出 */
      const stay = (): void => {
        scheduler.resume()
        begin({ kind: 'editing' })
      }
      // 面板里防抖中的改动先写进模型（批注浮层、数据验证面板，M3-P4 设计 §3.4）：之前没有别的修改时，它们是"有没有没存的"的全部
      await page.settlePanels()
      if (!still(token))
        return
      // 有没存的就立即上传一次（提交单元格、等公式；内容与确认过的相同时不发），在途的那一次先有结果
      if (saver.hasUnsavedWork()) {
        await scheduler.flush('exit')
        if (!still(token))
          return
      }
      await saver.settled()
      if (!still(token))
        return
      // 没有全部存上（保存失败、版本冲突、提交不了正在编辑的单元格、公式结果还没收齐）就留在编辑
      if (saver.hasUnsavedWork()) {
        stay()
        return
      }
      let snapshot: string
      try {
        snapshot = page.capture()
      }
      catch (error) {
        options.reportError(error)
        if (still(token))
          stay()
        return
      }
      // 释放：等它的结果，至多 EXIT_RELEASE_WAIT_MS（结果未知、到了时限也照样退出：那一代至多 90 秒内自行到期）
      const released = await releaseWithin(held)
      if (!still(token))
        return
      lease = undefined
      watchUnconfirmedRelease(released)
      const revision = saver.baseRevision()
      // 与服务端不兼容之后（M3-P3）退出：之后的阅读照样不给"编辑"、照样说明
      const blocked = blockedBy(saver.view().status)
      const created = await slot.replace('read', snapshot)
      if (!still(token))
        return
      // 保存的状态机留到换好编辑器才去掉：退出的整个过程页头的"保存""正在退出编辑…"都在（审查 A2），这时它说的是已保存
      disposeCoordinator()
      if (created === undefined) {
        fail(new Error('退出编辑时以只读重建编辑器失败'))
        return
      }
      // 退出时都已存上（含公式的结果）：这一版不带"公式待更新"——补存的内容与上一版相同时修订号不变（服务端只清标记），
      // 之前记下的这一版的标记随之作废
      latestFlag = { revision, formulasPending: false }
      // 刚存下的内容自己读不回来（打开自检失败）：照样以 damaged 阅读、上报
      const damaged = openCheckOf(created, { access: 'read', trigger: 'exit', revision })
      enterReading(created, { snapshot, revision }, { kind: 'reading', canEdit: true, holder: undefined, update: 'none', gone: false, notice: undefined, releaseUnconfirmed: !released, blocked, formulasPending: formulasPendingOf(revision), damaged })
    },

    save: async (ready) => {
      if (mode.kind !== 'editing' || autosave === undefined)
        return
      // 等会话确认的期间开始了退出、失去了编辑权：不再上传（退出自己存；失去编辑权时调度已经去掉）
      const stillEditing = (): boolean => mode.kind === 'editing'
      await autosave.flush('save-button', { ready: async () => (ready === undefined || await ready()) && stillEditing() })
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
      // 这期间只有检查会改阅读的状态（持有者、能不能编辑）：收尾都用当时的，不用开始时的（审查 A1、A9）
      if (!still(token) || mode.kind !== 'reading')
        return
      if (fetched === undefined) {
        if (isNotFoundError(failure)) {
          begin({ ...mode, update: 'none', gone: true, canEdit: false, holder: undefined })
          return
        }
        if (isAuthenticationError(failure))
          hooks.readProblem(failure)
        begin({ ...mode, update: 'available', notice: { kind: 'refresh-failed', error: failure } })
        return
      }
      if (fetched === CONTENT_UNCHANGED) {
        begin({ ...mode, update: 'none' })
        return
      }
      const created = await slot.replace('read', fetched.snapshot)
      if (!still(token) || mode.kind !== 'reading')
        return
      if (created === undefined) {
        fail(new Error('按新的版本重建编辑器失败'))
        return
      }
      // 打开自检按新内容的结果覆盖（M3-P4 设计 §3.12）：之前坏、新版好时恢复"编辑"
      const damaged = openCheckOf(created, { access: 'read', trigger: 'refresh', revision: fetched.revision })
      enterReading(created, fetched, { ...mode, update: 'none', notice: undefined, formulasPending: formulasPendingOf(fetched.revision), damaged })
    },

    saveCopy: async () => {
      if (mode.kind !== 'lost' || !mode.readable || !mode.unsaved || mode.checking || mode.captureFailed
        || mode.copy.kind === 'saving' || mode.copy.kind === 'done' || mode.copy.kind === 'refused' || mode.reload.kind === 'loading' || lostCopy === undefined) {
        return
      }
      const copy = lostCopy
      const token = begin({ ...mode, copy: { kind: 'saving' } })
      let created: CreatedDocument
      try {
        created = await copy.save()
      }
      catch (error) {
        // 内容一律留着。再试也一样的（本页过旧、内容不合规则或太大，审查 B3）不再给副本，页面说明先把内容复制出来；
        // 别的可以再试（读不到时也是：可能只是取锁之前被移到了别的空间，再试会成功）
        if (isAuthenticationError(error) || isCsrfTokenError(error))
          hooks.writeProblem(error)
        if (still(token) && mode.kind === 'lost') {
          const refused = copyRefusalOf(error)
          begin({ ...mode, copy: refused === undefined ? { kind: 'failed', error } : { kind: 'refused', ...refused } })
        }
        return
      }
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
        // 退出编辑的过程中同样按保存的状态机：保存完、捕获之后（释放、重建）本页的内容都已存上，不再提示（审查 A7）
        case 'editing':
        case 'exiting':
          return coordinator?.hasUnsavedWork() ?? false
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
        checks.stop()
        return
      }
      // 从未登录或换了人回到本人：之前"登录已过期""请求已失效"这类保存失败的说明不再成立（复验 RB2）
      if (previous !== 'active') {
        coordinator?.dismissSessionProblem()
        if (mode.kind === 'reading')
          checks.checkNow()
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
      if (coordinator?.busy() === true)
        return
      void lease?.release()
    },

    dispose: () => {
      if (disposed)
        return
      disposed = true
      generation += 1
      checks.dispose()
      cancelUnconfirmedExpiry?.()
      cancelUnconfirmedExpiry = undefined
      void lease?.release()
      lease = undefined
      disposeCoordinator()
      listeners.clear()
      slot.clear()
    },
  }
}
