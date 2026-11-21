// 编辑器页（P4 设计 §3.7）：载入、会话与页头的编排。阅读与编辑、编辑权与保存交给 edit-mode.ts（M3-P2 设计 §3.4）；
// 界面（editor-chrome.tsx）只订阅这里的状态。编辑器在 React 之外创建：一页一份文档，模式切换一律重建（M3-P2 设计 §3.1）。
// 打开即阅读：载入之后以只读创建；地址带 ?edit=new（新建表格之后的跳转）而且能编辑时直接进入编辑，进入之后去掉这个参数
// （打开自检失败、只能阅读时同样去掉，M3-P4 设计 §3.12）。
// 交互屏障：载入期间、进入与退出编辑、失去编辑权的过程中，以及每次新建编辑器时，页头之外的输入一律拦下（interaction-barrier.ts）。
// 自动保存（M3-P4 设计 §3.10）：页面把可见性、联网与"会话是本人、令牌不是已知失效"（confirmedForWrite 的口径）交给编辑模式里的调度——
// 可见性在 visibilitychange 里同步通知（切到后台的捕获与上传不靠计时器），confirmedForWrite 的每次变化都通知（确认开始与结束、会话、
// 确认失败的原因、令牌失效）；确认会话失败（网络等）之后，恢复联网、回到前台时立即再确认，另按退避定时再确认（审查 A6：否则人一直在登录中、
// 自动保存却一直暂停）；页面关闭（pagehide）时有保存在途不释放编辑权（edit-mode.ts 的 releaseOnHide）；按保存在保存中照样做
// （在途时排一次），按下的这一刻就提交开着的单元格编辑，会话确认之后才上传（审查 A1）。阅读页的"公式待更新"取载入时的详情（与内容是同一版时）。
// 页头的文档详情正在重新取时给出进行中（DEF-045）。
// 交接规则（M3-P5）：本页的键盘、鼠标操作由组装处给出（edit-lease.ts 的 trackActivity：只认可信事件、零位移的移动不算——心跳的空闲与
// 空闲释放都按它）；这份文档在同一个浏览器里的锁与交接频道（same-browser.ts）、刷新时在途的保存的记号（pending-save-marker.ts）按文档
// 交给编辑模式，频道随页面卸载关掉。"在此编辑"（本人接管，设计 §3.7）与"编辑"一样先确认会话；交接频道上只理会同一个人的请求，本页的用户
// 取自载入时确认的会话。请求编辑（设计 §3.6）："请求编辑""取消请求"与持有者提示里的"交出""继续编辑"都是写的操作，与"编辑"一样先确认会话；
// 能不能强制接管取自载入时的详情（之后随编辑状态更新）。"强制接管"（设计 §3.8）是写的操作：页头先确认（确认框关掉之后才交到这里），这里与"编辑"
// 一样先确认会话。异常中断的说明里的"知道了"只改本页。测试构建的观察钩子（设计 §3.13）由组装处给出、交给编辑模式（生产不给）。
//
// 按类型装配（M6-P1 S8b，S8 spec §2）：从表格编辑器搬进共用编辑会话层，与文档类型无关。页面收一张装配表（类型 → EditorPageAssembly），
// 载入详情之后按详情里的类型选：类型有装配、档案等于装配的档案、格式版本在平台的列表里，三条都成立才选中，否则照旧“格式不受支持”。
// 选中时调用装配的 assemble：交回页面扩展与编辑模式的工厂（两者共用装配的闭包，扩展经它拿到有类型的编辑模式，这里只看到通用的 EditMode）。
// 页面扩展的挂点都在原来调用表格代码的位置，先后不变（spec §2.4、§2.9）：环境变了（写资格变了、update 里算视图之前、四个会话钩子里身份代次
// 加一之后）、7 个入口的第一句（挡住动作）、屏障的条件、pagehide 与卸载的第一件；选中之前（以及格式不受支持时）都不调，挡住按假算。
// 页面交给扩展的一面（EditorPageHost）是动作目标里页面的那一半与写的门槛（表格的 CSV 用它）。视图照抄编辑模式视图里扩展的部分（表格是
// formulaRecovery），编辑模式还没建时没有这一项。编辑器的工厂由装配给出，页面以 bindEditor 包上自己的绑定（容器、页面的界面、图片的读取许可
// 与三个回调，键与原来相同）。页面上报的档案（clientFormatOf）取选中的装配的：编辑权与请求编辑的请求按它取，编辑模式（草稿、打开自检的上报）
// 收到它；恢复的可读判定载入之后只用它，404 之后用装配表里全部的（草稿记录里有档案、没有类型）。
import type { DocumentAccessVia, DocumentDetail, DocumentSpace, DocumentType, SaveContentResponse, SessionResponse } from '@nerve-office/contracts'
import type { PageClientFormat, ReadableFormats } from '../../shared/api/client-format.ts'
import type { ApiError } from '../../shared/api/index.ts'
import type { ConnectionView } from '../../shared/lib/connection-state.ts'
import type { PageLocation } from '../../shared/lib/page-location.ts'
import type { SessionChannel } from '../../shared/lib/session-channel.ts'
import type { DocumentRecovery, RecoveryAccessFacts, RecoveryDiscard, RecoveryView } from '../../shared/local-drafts/document-recovery.ts'
import type { DraftReplayRequest } from '../../shared/local-drafts/recovery-decision.ts'
import type { RecoveryReader } from '../../shared/local-drafts/recovery-reader.ts'
import type { LeaseClock } from '../../shared/outbox/clock.ts'
import type { DraftSessionPermit } from '../../shared/outbox/session-fence.ts'
import type { AutosavePage, AutosaveView } from './autosave.ts'
import type { EditLeaseApi } from './edit-lease.ts'
import type { EditMode, EditModeApi, EditModeAutosave, EditModeBaseView, EditModeOptions, EditModeState, EditModeView } from './edit-mode.ts'
import type { EditRequestApi } from './edit-request.ts'
import type { EditingSessionOptions, LocalSaveView } from './editing-session.ts'
import type { LoadedContent } from './editor-api.ts'
import type { HandoverTrace } from './handover-trace.ts'
import type { EditorImageAccessController } from './image-access.ts'
import type { IssuedRequestMarker } from './issued-request.ts'
import type { PendingSaveMarker } from './pending-save-marker.ts'
import type { PageVisibility } from './reading-checks.ts'
import type { SameBrowser } from './same-browser.ts'
import type { SaveView } from './save-coordinator.ts'
import { PLATFORM_FORMAT_VERSIONS, UNKNOWN_DOCUMENT_TYPE } from '@nerve-office/contracts'
import { documentIsNewer } from '../../shared/api/client-format.ts'
import { disabledSessionUserId, isAuthenticationError, isCsrfTokenError, isMissingResource, setApiSession, setCsrfToken } from '../../shared/api/index.ts'
import { loginPath } from '../../shared/lib/login-path.ts'
import { createDocumentRecovery } from '../../shared/local-drafts/document-recovery.ts'
import { createRecoveryReader } from '../../shared/local-drafts/recovery-reader.ts'
import { draftSessionPermitOf } from '../../shared/local-drafts/session-activation.ts'
import { subscribeLocalSession } from '../../shared/local-drafts/session-events.ts'
import { DEFAULT_AUTOSAVE_LIMITS, retryDelay } from './autosave.ts'
import { createEditorImageAccess } from './image-access.ts'
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
  readonly canViewHistory: boolean
  readonly userId: string
}

/** 载入的结果：就绪、内容不存在或无权访问、格式不认识、请求失败、编辑器加载失败（之后的重建失败也是它） */
export type EditorPageLoad
  = | { readonly kind: 'loading' }
    | EditorPageReady
    | { readonly kind: 'not-found' }
    | { readonly kind: 'unsupported' }
    | { readonly kind: 'failed', readonly error: unknown }
    /** historyDocumentId：失败时已知能看历史，失败页给出“从历史恢复”的入口（M5R-M-06，D-07） */
    | { readonly kind: 'editor-failed', readonly error: unknown, readonly historyDocumentId?: string }

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
 * 编辑器的图片输入操作的状态（会话层的约束，S8 spec §2.5）：状态的类型由装配给出（表格是适配层的 ImageInputState，表格装配处的类型检查核对），
 * 页面只看“失败，而且原因是没有权限”
 */
export interface ImageOperationState {
  readonly kind: string
  readonly reason?: string
}

/** 编辑模式视图里扩展的部分（去掉通用的五项；表格是 formulaRecovery） */
export type EditModeExtraView<Extra extends object> = Omit<EditModeView<string, Extra>, keyof EditModeBaseView<string>>

/** 页面视图里与类型无关的各项；ImageState 是装配给出的图片输入操作的状态 */
export interface EditorPageBaseView<ImageState extends ImageOperationState> {
  readonly imageProblem?: boolean
  readonly imageOperation?: ImageState | undefined
  readonly recovery?: RecoveryView | undefined
  readonly localSave?: LocalSaveView | undefined
  readonly connection?: ConnectionView | undefined
  readonly load: EditorPageLoad
  /** 阅读还是编辑、编辑权怎样了（载入之后才有） */
  readonly mode: EditModeState | undefined
  /** 编辑时（与退出编辑的过程中）才有：保存的状态 */
  readonly save: SaveView | undefined
  /** 同上：自动保存这一侧的状态（联网、会话、会不会自动重试），页头连同 save 给出保存状态的全集（save-indicator.ts） */
  readonly autosave: AutosaveView | undefined
  readonly session: EditorPageSession
  /** 本页账户的实际停用事实；重新确认新登录后清除，不代表本机清理已完成。 */
  readonly sessionEndedReason?: 'account_disabled' | undefined
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
  /** 正在重新取文档详情（DEF-045：没能刷新的说明里"重试"说正在重试） */
  readonly detailRefreshing: boolean
  /**
   * 编辑器容器的状态（与 data-editor-state 相同）：loading 是载入或换编辑器期间（交互屏障挂着），ready 是渲染完成，steady 是
   * 渲染完成之后 3 秒，failed 是没有编辑器。测试构建的页面自检按它等到 steady（selftest-hook.ts）
   */
  readonly surface: EditorSurfaceState
}

/**
 * 页面的视图（S8 spec §2.5）：通用的各项，并上编辑模式视图里扩展的部分（Extra 是扩展并进编辑模式视图的；编辑模式还没建时没有这一项，
 * 按键比较时与原来的 undefined 等价）
 */
export type EditorPageView<Extra extends object = object, ImageState extends ImageOperationState = ImageOperationState> = EditorPageBaseView<ImageState> & Partial<EditModeExtraView<Extra>>

export interface EditorPageApi extends Omit<EditModeApi, 'editLease' | 'editRequest'> {
  /** 原 gzip 与原请求的无租约核对；缺少此能力时保留未知，不能改走 save。 */
  readonly replay?: ((documentId: string, request: DraftReplayRequest, gzip: Uint8Array<ArrayBuffer>) => Promise<SaveContentResponse>) | undefined
  readonly session: () => Promise<SessionResponse>
  readonly document: (documentId: string) => Promise<DocumentDetail>
  /**
   * 编辑权的请求（申请、续租、释放、交出、谢绝），按页面上报的档案取（S8 spec §2.6）：申请与续租的请求体带它。页面在选中装配、建编辑模式时
   * 以装配的档案取一次，编辑模式收到的接口不变
   */
  readonly editLease: (format: PageClientFormat) => EditLeaseApi
  /** 请求编辑的请求（发出、续期、取消），同上：发出的请求体带档案 */
  readonly editRequest: (format: PageClientFormat) => EditRequestApi
}

/** 同一连接状态提供浏览器信号与请求事实；online 只唤醒调度，编辑会话独立核对上传许可。 */
export interface PageNetwork {
  readonly connection?: EditingSessionOptions['connection']
  readonly online: () => boolean
  /** 联网与否变了；返回退订的函数 */
  readonly onChange: (listener: () => void) => () => void
}

/**
 * 本页的键盘、鼠标操作（组装处给出 edit-lease.ts 的 trackActivity：窗口的捕获阶段，只认可信事件、零位移的移动不算，M3-P5 设计 §3.9）：
 * 有操作时调用 listener；返回退订的函数。订阅要在交互屏障之前挂上（载入期间被拦下的输入也算有操作）
 */
export interface PageActivity {
  readonly subscribe: (listener: () => void) => () => void
}

/** 测试构建的自动保存控制（M3-P4 设计 §3.14）交给编辑模式的部分：节奏与暂停、日志、当前的调度 */
export type AutosaveControlHooks = Pick<EditModeAutosave, 'tuning' | 'observe' | 'attach'>

/** 地址里"新建之后直接编辑"的标记（?edit=new）：进入编辑之后去掉，刷新不再自动进入 */
export interface EditIntent {
  readonly requested: boolean
  readonly clear: () => void
}

/**
 * 页面绑定给编辑器工厂的（P12，键与原来相同）：容器、页面自己的界面（页头：组合输入与面板防抖的输入目标在页头里的不算文档的输入，
 * M3-P4 设计 §3.6）、图片的读取许可与三个回调。类型由会话层自己定义，表格装配处的类型检查核对与适配层的创建参数同形
 */
export interface EditorPageBindings<ImageState extends ImageOperationState> {
  readonly container: HTMLElement
  readonly pageUi: Node
  readonly imageAccess?: EditorImageAccessController
  readonly onImageFailure: (error: unknown) => void
  readonly onImageOperation: (state: ImageState) => void
  readonly onImageOperationFailure: (error: unknown) => void
}

/** 给这一类文档的编辑器工厂包上页面的绑定（每次创建时绑定一次）：装配把自己的工厂交给它，得到编辑模式要的工厂 */
export type EditorBinder<ImageState extends ImageOperationState> = <Input extends object, Editor>(create: (input: Input & EditorPageBindings<ImageState>) => Promise<Editor>) => (input: Input) => Promise<Editor>

/**
 * 页面交给扩展的一面（S8 spec §2.4）：动作目标里页面的那一半（表格的 CSV 目标）、写的门槛、导入之前的会话确认与导入要的事实。
 * 都在调用时取
 */
export interface EditorPageHost {
  /** 地址里的文档 id（新建表格之后的导入核对意图） */
  readonly documentId: string | undefined
  /**
   * 动作目标里页面的那一半：未登录、会话确认在途或上一次确认失败时交回 undefined；否则交回一个谓词——记下此刻的身份代次与会话，
   * 依次查没有卸载、不在离开、没有隐藏，载入完成、会话是本人，没有待确认的未登录、令牌不是已知失效，身份代次没变、会话的用户与令牌没变
   */
  readonly actionGate: () => (() => boolean) | undefined
  /** 写的门槛：能连上服务端，而且不必先确认就能写（会话是本人、没有确认在途、上一次确认没有失败、令牌不是已知失效） */
  readonly writeReady: () => boolean
  /** 导入之前：能连上服务端时先确认一次会话 */
  readonly confirmBeforeWrite: () => Promise<void>
  /** 页头的标题（导出的文件名等） */
  readonly title: () => string
  /** 本页确认过的会话（新建表格之后的导入核对意图） */
  readonly pageSession: () => SessionResponse | undefined
  /** 没有卸载，而且会话是本人 */
  readonly sessionActive: () => boolean
}

/**
 * 页面扩展的挂点（S8 spec §2.4）：页面在原来调用表格代码的位置调用它。没有扩展时（载入之前、格式不受支持）都不调，挡住按假算——
 * 与编辑模式还没建时相同
 */
export interface EditorPageExtension {
  /** 页面的环境变了：写资格变了（在通知自动保存之后）、update 里算视图之前、四个会话钩子里身份代次加一之后 */
  readonly environmentChanged: () => void
  /** 挡住动作：7 个入口（进入编辑、在此编辑、强制接管、请求编辑、交出、继续编辑、退出编辑）的第一句，在页面自己的判断之前 */
  readonly blocksActions: () => boolean
  /** 挂上交互屏障（与切换中、正在新建同在一处判断） */
  readonly blocksInput: () => boolean
  /** 页面隐藏：pagehide 的第一件（记下已隐藏之后）；选中时页面已经隐藏也调 */
  readonly hide: () => void
  /** 卸载的第一件（记下已卸载之后） */
  readonly dispose: () => void
}

/** 页面交给编辑模式的工厂的选项：编辑模式与类型无关的选项（不含编辑器的工厂），另加包上页面绑定的 bindEditor */
export type EditorPageModeOptions<ImageState extends ImageOperationState> = Omit<EditModeOptions<unknown, unknown, unknown>, 'createEditor'> & {
  readonly bindEditor: EditorBinder<ImageState>
}

/** 选中装配时交回的：页面扩展（挂点并上交给使用方的成员 Extension）与编辑模式的工厂，两者共用装配的闭包 */
export interface AssembledEditorPage<Extension extends object, Extra extends object, ImageState extends ImageOperationState> {
  readonly extension: EditorPageExtension & Extension
  readonly createMode: (options: EditorPageModeOptions<ImageState>) => EditMode<string, Extra>
}

/**
 * 一类文档的装配（S8 spec §2.3）：这类文档的页面档案（clientFormatOf）与选中时的组装。编辑器的工厂在装配之内（表格的由组装处给出），
 * 编辑器、视图状态与创建选项的类型都不出装配：页面看到的类型参数只有交给使用方的成员、编辑模式视图里扩展的部分与图片操作的状态
 */
export interface EditorPageAssembly<Extension extends object, Extra extends object, ImageState extends ImageOperationState> {
  readonly format: PageClientFormat
  /** 选中时调用（只调一次）：交回页面扩展与编辑模式的工厂 */
  readonly assemble: (host: EditorPageHost) => AssembledEditorPage<Extension, Extra, ImageState>
}

/** 装配表：本页能打开的类型各一项（组装处写成 satisfies Record<OpenableDocumentType, …>） */
export type EditorPageAssemblies<Extension extends object, Extra extends object, ImageState extends ImageOperationState> = Partial<Record<DocumentType, EditorPageAssembly<Extension, Extra, ImageState>>>

export interface EditorPageOptions<Extension extends object, Extra extends object, ImageState extends ImageOperationState> {
  /** 独立 Reader 的测试接缝，不共享编辑会话的密钥所有权。 */
  readonly recoveryReader?: (() => RecoveryReader) | undefined
  /** 持久宿主/密钥的测试接缝；生产不传。部署开关始终来自实际会话响应。 */
  readonly localDrafts?: Omit<NonNullable<EditingSessionOptions['localDrafts']>, 'enabled'> | undefined
  /** 地址里的文档 id；地址不是编辑器页的写法时为 undefined，按不存在处理 */
  readonly documentId: string | undefined
  /** Univer 挂载的容器；页面的状态写在它的 data-editor-state 上（loading、ready、steady、failed），E2E 按它等待 */
  readonly surface: HTMLElement
  /** 页头：交互屏障挂着时只有它可以交互（interaction-barrier.ts） */
  readonly chrome: HTMLElement
  readonly api: EditorPageApi
  /**
   * 装配表（M6-P1 设计 §3.4，S8 spec §2.3）：载入详情之后按类型选；没有这一类的装配、档案或格式版本不对的进入“格式不受支持”，不创建编辑器
   */
  readonly assemblies: EditorPageAssemblies<Extension, Extra, ImageState>
  readonly page: PageLocation
  readonly sessionChannel: SessionChannel
  /** 单调的"现在"与计时器：编辑租约的心跳、阅读时的检查 */
  readonly clock: LeaseClock
  /** 页面的可见性：隐藏时暂停阅读时的检查；切到后台时自动保存立即上传（监听在 visibilitychange 里同步调用） */
  readonly visibility: PageVisibility
  /** 联网与否（自动保存） */
  readonly network: PageNetwork
  /** 本页的键盘、鼠标操作（心跳上报的空闲、空闲释放） */
  readonly activity: PageActivity
  /** 这份文档在同一个浏览器里的锁与交接频道（M3-P5 设计 §3.1、§3.7）：载入之后按文档建一次，卸载时关掉 */
  readonly sameBrowser: (documentId: string) => SameBrowser
  /** 这份文档的"刷新时在途的保存"的记号（M3-P5 设计 §3.7 的 R1） */
  readonly pendingSave: (userId: string, documentId: string) => PendingSaveMarker
  /** 这份文档在这一页发出过的请求编辑的记号（M3-P5 审查 B2，按标签页、刷新之后还在） */
  readonly issuedRequest: (documentId: string) => IssuedRequestMarker
  /** 测试构建的自动保存控制（start.tsx 只在测试构建里给出）；生产为 undefined */
  readonly autosaveControl?: AutosaveControlHooks | undefined
  /** 测试构建的交接观察钩子（M3-P5 设计 §3.13，start.tsx 只在测试构建里给出）；生产为 undefined */
  readonly handoverTrace?: HandoverTrace | undefined
  readonly editIntent: EditIntent
  /** 当前的地址（路径与查询）：转到登录页时带上，登录之后回到这里 */
  readonly currentPath: () => string
  readonly newId: () => string
  /** 现在的墙上时间（另存为副本的标题） */
  readonly now: () => Date
  /** 意外的错误：上报（浏览器的 reportError） */
  readonly reportError: (error: unknown) => void
}

export interface EditorPage<Extension extends object = object, Extra extends object = object, ImageState extends ImageOperationState = ImageOperationState> {
  /** 选中的装配交给使用方的成员（表格是 CSV、新建表格之后的导入、工作表名与公式恢复的重试）：选中之前为 undefined */
  readonly extension: () => Extension | undefined
  readonly retryRecovery: () => Promise<void>
  readonly copyRecovery: () => Promise<void>
  readonly beginDiscardRecovery: () => RecoveryDiscard | undefined
  readonly discardRecovery: (intent: RecoveryDiscard) => Promise<void>
  readonly retryRecoveryCleanup: () => Promise<void>
  readonly acknowledgeRecovery: (at: number) => Promise<void>
  readonly view: () => EditorPageView<Extra, ImageState>
  readonly subscribe: (listener: () => void) => () => void
  readonly load: () => Promise<void>
  readonly save: () => Promise<void>
  /** "编辑"：会话是本人时申请编辑权，重建为可编辑 */
  readonly enterEditing: () => Promise<void>
  /**
   * "在此编辑"（M3-P5 设计 §3.7）：会话是本人时本人接管自己在别的标签页或设备上的编辑权（本浏览器的标签页先保存再交出）；那边没能交出之后再按
   * 就是"仍在此编辑"
   */
  readonly takeOverHere: () => Promise<void>
  /** "在此编辑"那边没能交出之后选"取消" */
  readonly cancelTakeOver: () => void
  /** "强制接管"（M3-P5 设计 §3.8；页头已经确认过）：会话是本人时以强制接管申请编辑权，重建为可编辑 */
  readonly forceTakeOver: () => Promise<void>
  /** 异常中断的说明里的"知道了"（M3-P5 设计 §3.11）：说明消失 */
  readonly dismissInterruption: () => void
  /** "请求编辑"（M3-P5 设计 §3.6）：会话是本人时发出，之后等待、编辑权交给本页时自动进入编辑 */
  readonly requestEditing: () => Promise<void>
  /** "取消请求"：会话是本人时取消 */
  readonly cancelRequest: () => Promise<void>
  /** 持有者提示里的"交出"：会话是本人时先保存再交出，回到阅读 */
  readonly handOver: () => Promise<void>
  /** 持有者提示里的"继续编辑"：会话是本人时谢绝这个请求，提示消失 */
  readonly keepEditing: () => Promise<void>
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

/** 平台的格式版本（按数组包含判断，不是等于单值） */
const KNOWN_FORMAT_VERSIONS: readonly number[] = PLATFORM_FORMAT_VERSIONS

/**
 * 这份文档交给哪一项装配（S8 spec §2.3）：本页能打开的类型、档案与格式版本；别的一律不进入编辑，也不改写（计划书 §8.7）。
 * 三条都成立才选中——详情的类型有装配（响应里没见过的类型没有）、档案等于装配的档案、格式版本在平台的列表里
 */
function assemblyFor<Assembly extends { readonly format: PageClientFormat }>(document: DocumentDetail, assemblies: Partial<Record<DocumentType, Assembly>>): Assembly | undefined {
  const assembly = document.type === UNKNOWN_DOCUMENT_TYPE ? undefined : assemblies[document.type]
  if (assembly === undefined || document.profile !== assembly.format.profile || !KNOWN_FORMAT_VERSIONS.includes(document.formatVersion))
    return undefined
  return assembly
}

/** 装配表里全部的档案（404 之后的可读判定，S8 spec §2.7）：表是空的时为 undefined */
function formatsOf(assemblies: Partial<Record<DocumentType, { readonly format: PageClientFormat }>>): ReadableFormats | undefined {
  const [first, ...rest] = Object.values(assemblies).flatMap(assembly => assembly === undefined ? [] : [assembly.format])
  return first === undefined ? undefined : [first, ...rest]
}

/** 编辑模式视图里扩展的部分（S8 spec §2.5）：去掉通用的五项；编辑模式还没建时没有 */
function extraViewOf<Extra extends object>(view: EditModeView<string, Extra> | undefined): Partial<EditModeExtraView<Extra>> {
  if (view === undefined)
    return {}
  const { localSave, mode, save, autosave, surface, ...extra } = view
  return extra
}

/** 视图按键比较（next 的自有键）：有一项不同就算变了 */
function viewChanged<View extends object>(next: View, current: View): boolean {
  for (const key in next) {
    if (next[key] !== current[key])
      return true
  }
  return false
}

/** 页头的信息里随文档详情更新的部分 */
type EditorHeading = Omit<EditorPageReady, 'kind'>

function headingOf(document: DocumentDetail, userId: string): EditorHeading {
  return { documentId: document.id, title: document.title, space: document.space, accessVia: document.accessVia, canShare: document.permissions.canShare, canViewHistory: document.permissions.canViewHistory, userId }
}

/** 这些状态里编辑器在换（或正要换）：交互屏障挂着 */
function switching(mode: EditModeState): boolean {
  return mode.kind === 'opening' || mode.kind === 'entering' || mode.kind === 'exiting' || mode.kind === 'losing'
}

export function createEditorPage<Extension extends object, Extra extends object, ImageState extends ImageOperationState>(options: EditorPageOptions<Extension, Extra, ImageState>): EditorPage<Extension, Extra, ImageState> {
  const { documentId, surface, api, page, sessionChannel, clock } = options
  const listeners = new Set<() => void>()
  let load: EditorPageLoad = { kind: 'loading' }
  let session: EditorPageSession = 'active'
  let userId: string | undefined
  let localDraftsEnabled = false
  let localPermit: DraftSessionPermit | undefined
  /** 无许可的同源确认之后仍可识别迟到 stopped；绝不交给本机 reader/writer。 */
  let unconfirmedLocalSource: DraftSessionPermit | undefined
  let imageAccess: EditorImageAccessController | undefined
  let pageSession: SessionResponse | undefined
  /**
   * 身份代次（原来 CSV 的 csvIdentityEpoch，S8 spec §2.4）：会话的用户或令牌变了、会话的状态变了、四个会话钩子里加一；
   * 动作目标（actionGate 交回的谓词）记下它，变了就作废
   */
  let identityEpoch = 0
  let confirmedImageSession: SessionResponse | undefined
  let imageReadable = false
  let imageCanEdit: boolean | undefined
  let imageCanTakeOver: boolean | undefined
  /** 详情和阅读检查共享撤权代次，较早发出的成功响应不能重新授权。 */
  let imagePermissionEpoch = 0
  let imageInstance = 0
  let imageProblem = false
  let imageOperation: ImageState | undefined
  let pageHidden = false
  /** 本页这次加载的标识（P1 设计 §3.2）：编辑租约绑定它，保存也带着它（认出"自己追自己"），两处是同一个 */
  const clientInstanceId = options.newId()
  /** 阅读与编辑（载入之后才有）：选中的装配建的，这里只看到通用的编辑模式 */
  let mode: EditMode<string, Extra> | undefined
  /** 选中的装配的页面扩展（选中时建，S8 spec §2.2）：选中之前与格式不受支持时没有，挂点都不调 */
  let extension: (EditorPageExtension & Extension) | undefined
  let recovery: DocumentRecovery | undefined
  let earlyUnreadableRound: number | undefined
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
  /** 与普通广播/错误的 checkAgain 分开；真实新许可可以覆盖这一次停写复核。 */
  let pendingLocalStop: DraftSessionPermit | undefined
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
  let sessionEndedReason: EditorPageBaseView<ImageState>['sessionEndedReason']
  /**
   * 确认会话失败（sessionProblem，网络等）之后的再确认（审查 A6）：确认有结果之前自动保存暂停，人其实多半一直在登录中——恢复联网、
   * 回到前台时立即再确认，另按自动保存的退避（2、4……秒，至多 60 秒）定时再确认。确认有了结果（成功、未登录、换了人）就停
   */
  let cancelRecheck: (() => void) | undefined
  let recheckAttempts = 0
  let confirmingSession = false
  /** 在途的重新取页头文档详情的次数（DEF-045：大于 0 时"重试"说正在重试） */
  let detailRefreshes = 0
  let detailRound = 0
  /** 自动保存要的页面信号（可见性、联网、confirmedForWrite）变了：通知编辑模式里的调度 */
  const pageSignalListeners = new Set<() => void>()
  /** 上一次通知时的 confirmedForWrite()：变了才通知 */
  let writable = true
  const cleanups: (() => void)[] = []
  cleanups.push(subscribeLocalSession((event) => {
    const source = localPermit ?? unconfirmedLocalSource
    if (disposed || event.kind !== 'stopped' || source?.userId !== event.previous.userId || source.generation !== event.previous.generation)
      return
    if (event.cleanup?.cause === 'account_disabled')
      sessionEndedReason = 'account_disabled'
    localPermit = undefined
    unconfirmedLocalSource = undefined
    pendingLocalStop = event.previous
    acceptPageSession(undefined)
    imagePermissionEpoch += 1
    imageAccess?.suspend()
    recovery?.suspend()
    // 沿已有代次变化路径暂停捕获、关闭本机宿主和释放密钥；服务器状态仍由真实会话请求确认。
    mode?.setSession(session)
    update()
    // 取票前完成的停写可由在途确认覆盖；旧票失效及确认后晚到停写仍须补核。
    void recheckSession(true)
  }))
  /** 交互屏障：撤掉它的函数 */
  let releaseBarrier: (() => void) | undefined
  /** 编辑器容器的状态（写在容器的 data-editor-state 上） */
  let surfaceState: EditorSurfaceState = 'loading'
  let current = computeView()
  /** 页面交给扩展的一面（S8 spec §2.4）：选中装配时交给它 */
  const host: EditorPageHost = {
    documentId,
    actionGate,
    writeReady: () => serverAvailable() && confirmedForWrite(),
    // 导入之前（原来 CSV 的 prepareImport）：能连上服务端时先确认一次会话
    confirmBeforeWrite: async () => {
      if (serverAvailable())
        await confirmForSave(false)
    },
    title: () => heading?.title ?? '',
    pageSession: () => pageSession,
    sessionActive: () => !disposed && session === 'active',
  }

  function acceptPageSession(next: SessionResponse | undefined): void {
    if (pageSession?.user.id !== next?.user.id || pageSession?.csrfToken !== next?.csrfToken)
      identityEpoch += 1
    pageSession = next
  }

  /**
   * 动作目标里页面的那一半（S8 spec §2.4，原来 CSV 目标的页面一侧）：未登录、会话确认在途或上一次确认失败时没有；否则记下此刻的身份代次与会话，
   * 交回“这个目标还算数”的页面一侧的判断
   */
  function actionGate(): (() => boolean) | undefined {
    const signedIn = pageSession
    if (signedIn === undefined || checkInFlight !== undefined || sessionProblem !== undefined)
      return undefined
    const epoch = identityEpoch
    return (): boolean => !disposed && !leaving && !pageHidden && load.kind === 'ready'
      && session === 'active' && !unauthenticatedPending && staleAfter === undefined
      && epoch === identityEpoch && pageSession?.user.id === signedIn.user.id && pageSession.csrfToken === signedIn.csrfToken
  }

  /** 视图：通用的各项，并上编辑模式视图里扩展的部分（S8 spec §2.5） */
  function computeView(): EditorPageView<Extra, ImageState> {
    const modeView = mode?.view()
    return { ...extraViewOf(modeView), load, imageProblem, imageOperation, recovery: recovery?.view(), localSave: modeView?.localSave, connection: options.network.connection?.view(), mode: modeView?.mode, save: modeView?.save, autosave: modeView?.autosave, session, sessionEndedReason, sessionProblem, confirmingSession, detailProblem, detailRefreshing: detailRefreshes > 0, surface: surfaceState }
  }

  function confirmImages(): void {
    if (disposed || leaving || pageHidden || session !== 'active' || !imageReadable || pageSession === undefined) {
      imageAccess?.suspend()
      return
    }
    if (imageAccess?.current()?.csrfToken !== pageSession.csrfToken)
      imagePermissionEpoch += 1
    if (confirmedImageSession?.csrfToken !== pageSession.csrfToken)
      imageProblem = false
    confirmedImageSession = pageSession
    imageAccess?.confirm(pageSession)
  }

  function refreshImages(): void {
    const active = imageAccess?.current() !== undefined
    // 明确重试/真实权限变化先退休旧读取轮次，迟到旧失败不能污染恢复后的实例。
    imageAccess?.resetReadFailures()
    confirmImages()
    // 从暂停恢复时 confirm 已发一次通知；重复确认本人不主动重读。
    if (imageAccess?.current() !== undefined) {
      imageProblem = false
      if (active)
        imageAccess.refresh()
    }
    update()
  }

  function imagePermissions(readable: boolean, canEdit?: boolean, canTakeOver?: boolean, issuedEpoch?: number): void {
    if (issuedEpoch !== undefined && issuedEpoch !== imagePermissionEpoch)
      return
    const changed = imageReadable !== readable || imageCanEdit !== canEdit || imageCanTakeOver !== canTakeOver
    imageReadable = readable
    imageCanEdit = canEdit
    imageCanTakeOver = canTakeOver
    if (changed) {
      imagePermissionEpoch += 1
      refreshImages()
    }
  }

  /** 页面信号变了：在调用者的同步段里通知（可见性在 visibilitychange 里，切到后台的上传不靠计时器） */
  function signalPage(): void {
    for (const listener of [...pageSignalListeners]) {
      try {
        listener()
      }
      catch (error) {
        options.reportError(error)
      }
    }
  }

  /** confirmedForWrite() 变了就通知（确认开始与结束、会话、确认失败的原因、令牌失效）：自动保存在它为假时不发 */
  function syncWritable(): void {
    const next = confirmedForWrite()
    if (next === writable)
      return
    writable = next
    if (!next)
      recovery?.suspend()
    signalPage()
    extension?.environmentChanged()
  }

  /** 写资格 → 扩展的环境（表格的 CSV 的监听者先收到） → 算视图 → 比较 → 通知页面的监听者（S8 spec §2.9 的 P2） */
  function update(): void {
    syncWritable()
    extension?.environmentChanged()
    const next = computeView()
    if (!viewChanged(next, current))
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
    imagePermissionEpoch += 1
    imageReadable = false
    imageAccess?.suspend()
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
    // 不可读立即清图；恢复必须来自新请求，不能用旧 reading 视图重新授权。
    if ((view.mode.kind === 'reading' && view.mode.gone)
      || (view.mode.kind === 'lost' && !view.mode.readable)
      || (view.mode.kind === 'losing' && view.mode.loss.kind === 'not-found')
      || view.mode.kind === 'unavailable') {
      imagePermissions(false)
    }
    if (view.mode.kind === 'failed') {
      if (load.kind !== 'editor-failed')
        finish({ kind: 'editor-failed', error: view.mode.error, ...(heading?.canViewHistory === true ? { historyDocumentId: heading.documentId } : {}) })
      return
    }
    if (view.mode.kind === 'unavailable') {
      if (load.kind !== 'not-found')
        finish({ kind: 'not-found' })
      return
    }
    // 扩展挂屏障（表格：公式恢复挡住输入）：与切换中、正在新建同在一处判断，读的是编辑模式此刻的视图（S8 spec §2.4、§2.9 的 P5）
    if (switching(view.mode) || view.surface === 'creating' || extension?.blocksInput() === true)
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
    imageAccess?.suspend()
    setCsrfToken(undefined)
    page.replace(loginPath(options.currentPath(), disabledSessionUserId(error) !== undefined ? 'account_disabled_confirmed' : error.code === 'SESSION_EXPIRED' ? 'expired' : 'required'))
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
    if (next !== 'signed-out')
      sessionEndedReason = undefined
    if (session !== next) {
      imagePermissionEpoch += 1
      identityEpoch += 1
    }
    session = next
    if (next !== 'active') {
      confirmedImageSession = undefined
      imageAccess?.resetReadFailures()
    }
    confirmImages()
    if (next !== 'active') {
      localPermit = undefined
      unconfirmedLocalSource = undefined
      recovery?.suspend()
    }
    mode?.setSession(next)
    update()
  }

  /** 编辑权与另存为副本的请求得到未登录或令牌失效：向服务端确认现在是谁（不显示"正在确认"：不是用户按了保存） */
  function writeProblem(error: ApiError): void {
    identityEpoch += 1
    extension?.environmentChanged()
    if (userId !== undefined && disabledSessionUserId(error) === userId)
      sessionEndedReason = 'account_disabled'
    if (isAuthenticationError(error))
      unauthenticatedPending = true
    else
      staleAfter = checksStarted
    syncWritable()
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
  async function recheckSession(localStop = false): Promise<void> {
    if (leaving || disposed)
      return
    if (userId === undefined) {
      checkWhenLoaded = true
      return
    }
    if (checkInFlight !== undefined) {
      if (!localStop)
        checkAgain = true
      return checkInFlight
    }
    const run = async (): Promise<void> => {
      try {
        for (;;) {
          checkAgain = false
          const stopAtStart = pendingLocalStop
          await checkSessionOnce()
          const stopped = pendingLocalStop
          // 必须看 resumeLease 完成后的当前许可，不能用其开始前的响应吞掉更晚的停写。
          const needsLocalCheck = stopped !== undefined && stopped !== stopAtStart && session === 'active'
            && sessionProblem === undefined && (localPermit === undefined || localPermit.generation === stopped.generation)
          pendingLocalStop = undefined
          if ((!checkAgain && !needsLocalCheck) || leaving || disposed)
            break
        }
      }
      finally {
        checkInFlight = undefined
        syncWritable()
        // 与保存有关的确认结束：会话的结果已经更新，这时才显示会话类的保存失败（复验 TB1）
        if (confirmingSession) {
          confirmingSession = false
          update()
        }
        recheckIfUnconfirmed()
      }
    }
    checkInFlight = run()
    syncWritable()
    return checkInFlight
  }

  /** 一轮确认结束之后：还是没能确认（网络等）就按退避再排一次（审查 A6）；有了结果就停、退避清零 */
  function recheckIfUnconfirmed(): void {
    cancelRecheck?.()
    cancelRecheck = undefined
    if (sessionProblem === undefined || leaving || disposed) {
      recheckAttempts = 0
      return
    }
    recheckAttempts += 1
    cancelRecheck = clock.schedule(() => {
      cancelRecheck = undefined
      void recheckSession()
    }, retryDelay(recheckAttempts, DEFAULT_AUTOSAVE_LIMITS))
  }

  /** 恢复联网、回到前台：上一次确认会话失败了就立即再确认（审查 A6） */
  function recheckOnReturn(back: boolean): void {
    if (back && sessionProblem !== undefined && !leaving && !disposed)
      void recheckSession()
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
      if (userId !== undefined && disabledSessionUserId(error) === userId)
        sessionEndedReason = 'account_disabled'
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
      setApiSession(confirmed)
      const confirmedPermit = draftSessionPermitOf(confirmed)
      unconfirmedLocalSource = confirmedPermit === undefined && pageSession?.user.id === confirmed.user.id && pageSession.csrfToken === confirmed.csrfToken
        ? localPermit ?? unconfirmedLocalSource
        : undefined
      acceptPageSession(confirmed)
      localDraftsEnabled = confirmed.features.localDraftsEnabled
      localPermit = confirmedPermit
      enterSession('active')
      // 编辑权绑定登录（P1 设计 §3.4.1）：登录可能换过（重新登录、换令牌），恢复续租并立即核对一次——失效时随即说明、停止保存。
      // 确认在它有了结果之后才算结束：按保存时等的是这一步，不带着已经失效的编辑权去保存。例外：续租连着第二次起被判会话不对（服务端一直拒绝、
      // 确认却照常是本人）时只按心跳排下一次，立即兑现（ADR-018 的补充，复验 C1）——保存时服务端照样核对编辑权，失效了会被拒、经续上再判断
      await mode?.resumeLease()
    }
    else {
      // 另一个人：新会话的令牌不交给这个页面，停止保存
      setCsrfToken(undefined)
      enterSession('other-user')
    }
  }

  /** 当前连接只限制主动服务端操作，不参与本机捕获的会话许可。 */
  function serverAvailable(): boolean {
    return !disposed && (options.network.connection?.view().available ?? options.network.online())
  }

  /**
   * 要写的操作（保存、进入与退出编辑）之前：确认会话进行中（别的标签页的消息、保存得到未登录或 CSRF 失效触发的）就等它结束，按确认的结果决定
   * （复验 RB1）；暂停或停止保存时、上一次确认失败时（令牌可能没有换成，复验 TB1）先向服务端确认一次：本页的用户可能已经在别处重新登录，
   * 广播的消息没有送到。令牌已知失效时一定先确认（复验 VB1）。返回能不能接着做：会话是本人、页面还在、令牌不是已知失效的（复验 UB1）
   */
  async function readyToWrite(): Promise<boolean> {
    if (!serverAvailable())
      return false
    if (!confirmedForWrite())
      await confirmForSave(false)
    return session === 'active' && serverAvailable() && staleAfter === undefined
  }

  /** 不必先向服务端确认就能写：没有确认在途、会话是本人、上一次确认没有失败、令牌不是已知失效的 */
  function confirmedForWrite(): boolean {
    return checkInFlight === undefined && session === 'active' && sessionProblem === undefined && staleAfter === undefined
  }

  /** 自动保存要的页面一侧（M3-P4 设计 §3.10） */
  const autosavePage: AutosavePage = {
    visible: () => !options.visibility.hidden(),
    online: () => options.network.online(),
    sessionWritable: confirmedForWrite,
    onChange: (listener) => {
      pageSignalListeners.add(listener)
      return () => pageSignalListeners.delete(listener)
    },
  }

  /** formats：恢复的可读判定用的档案（载入之后是选中的装配的那一个，404 之后是装配表里全部的，S8 spec §2.6、§2.7） */
  function prepareRecovery(id: string, user: string, formats: ReadableFormats): void {
    const key = { documentId: id, userId: user }
    const still = (): boolean => !disposed && !leaving && userId === user && confirmedForWrite()
    const sessionFailure = (error: unknown): void => {
      if (still() && (isAuthenticationError(error) || isCsrfTokenError(error)))
        writeProblem(error)
    }
    const facts = async (): Promise<RecoveryAccessFacts> => {
      const unknown: RecoveryAccessFacts = { access: 'unknown', online: serverAvailable(), current: undefined }
      if (!still())
        return unknown
      if (earlyUnreadableRound !== undefined) {
        const round = earlyUnreadableRound
        earlyUnreadableRound = undefined
        return round === checksStarted ? { access: 'unreadable', online: true, current: undefined } : unknown
      }
      if (!serverAvailable())
        return { access: 'editable', online: false, current: undefined }
      try {
        const fetched = await api.editStatus(id)
        if (!still())
          return unknown
        const status = fetched.status
        return { access: status.canEdit ? 'editable' : 'read-only', online: true, current: { revision: status.revision, source: undefined, occupied: status.editor !== null } }
      }
      catch (error) {
        if (!still())
          return unknown
        if (isAuthenticationError(error) || isCsrfTokenError(error)) {
          sessionFailure(error)
          return unknown
        }
        if (isMissingResource(error))
          return { access: 'unreadable', online: true, current: undefined }
        return { access: 'editable', online: false, current: undefined }
      }
    }
    recovery = createDocumentRecovery({
      key,
      pageFormats: formats,
      writtenBy: clientInstanceId,
      clock,
      now: () => options.now().getTime(),
      still,
      facts,
      reader: options.recoveryReader ?? (() => createRecoveryReader({ permit: localPermit, key, clock, still, host: options.localDrafts?.host, onSessionProblem: sessionFailure })),
      replay: async (request, gzip) => {
        if (api.replay === undefined)
          throw new Error('当前页面无法核对原保存请求')
        return api.replay(id, request, gzip)
      },
      refreshCloud: async () => mode?.refresh(true),
      conflictCopy: api.conflictCopy,
      title: () => heading?.title ?? '',
      newId: options.newId,
      onSessionProblem: sessionFailure,
      reportError: options.reportError,
    })
    cleanups.push(recovery.subscribe(update))
  }

  async function recoveryAction(work: (current: DocumentRecovery) => Promise<void>, reading = true): Promise<void> {
    const owned = recovery
    if (owned === undefined || !serverAvailable() || (!confirmedForWrite() && !(await readyToWrite())) || !confirmedForWrite())
      return
    const state = mode?.view().mode.kind
    if (recovery !== owned || (reading && state !== undefined && state !== 'reading'))
      return
    await work(owned)
  }

  /**
   * 给装配的编辑器工厂包上页面的绑定（S8 spec §2.5、§2.9 的 P12；原来是这里交给编辑模式的 createEditor）：每次创建换一个图片实例、清掉上一次的
   * 图片操作提示；容器、页面的界面、图片的读取许可与三个回调由这里给出，回调只认这一个实例
   */
  function bindEditor<Input extends object, Editor>(create: (input: Input & EditorPageBindings<ImageState>) => Promise<Editor>): (input: Input) => Promise<Editor> {
    return async (editorOptions) => {
      const instance = ++imageInstance
      imageOperation = undefined
      const currentImageInstance = (): boolean => !disposed && !pageHidden && instance === imageInstance
      const confirmImageOperationSession = async (): Promise<void> => {
        await recheckSession()
        if (!currentImageInstance())
          return
        // 合并确认要看最后一轮；前轮成功不能掩盖接续轮断网。
        if (sessionProblem !== undefined) {
          acceptPageSession(undefined)
          imagePermissionEpoch += 1
          imageAccess?.suspend()
        }
      }
      return create({
        ...editorOptions,
        container: surface,
        pageUi: options.chrome,
        ...(imageAccess === undefined ? {} : { imageAccess }),
        onImageFailure: (error) => {
          if (disposed || pageHidden || instance !== imageInstance)
            return
          imageProblem = true
          update()
          if (isAuthenticationError(error) && checkInFlight === undefined)
            void recheckSession()
        },
        onImageOperation: (state) => {
          if (!currentImageInstance())
            return
          imageOperation = state
          update()
          // 用户动作仍可合并正在进行的停写补核；确认不会自动重放剪贴板。
          if (state.kind === 'failed' && state.reason === 'permission' && pageSession === undefined)
            void confirmImageOperationSession()
        },
        onImageOperationFailure: (error) => {
          if (!currentImageInstance())
            return
          if ((isAuthenticationError(error) || isCsrfTokenError(error)) && checkInFlight === undefined)
            void confirmImageOperationSession()
        },
      })
    }
  }

  /** 以选中的装配建编辑模式：format 是装配的档案（编辑权与请求编辑的请求按它取，编辑模式收到它） */
  function createMode(id: string, user: string, assembled: AssembledEditorPage<Extension, Extra, ImageState>, format: PageClientFormat): EditMode<string, Extra> {
    const sameBrowser = options.sameBrowser(id)
    cleanups.push(() => sameBrowser.close())
    const created = assembled.createMode({
      documentId: id,
      clientInstanceId,
      userId: user,
      format,
      localDrafts: { ...options.localDrafts, enabled: () => localDraftsEnabled, permit: () => localPermit },
      recovery,
      connection: options.network.connection,
      // 编辑权与请求编辑的请求按装配的档案取（S8 spec §2.6）；编辑模式收到的接口不变
      api: { ...api, editLease: api.editLease(format), editRequest: api.editRequest(format) },
      onImagePermissions: imagePermissions,
      imagePermissionEpoch: () => imagePermissionEpoch,
      bindEditor,
      clock,
      visibility: options.visibility,
      lastActivity: () => lastActivity,
      newId: options.newId,
      now: options.now,
      title: () => heading?.title ?? '',
      session: {
        // 保存得到未登录：先向服务端确认（回包可能是本人在别处重新登录之前发出的那次保存的，不能据此清掉新的令牌，复验 RB7）
        saveUnauthenticated: (error) => {
          identityEpoch += 1
          extension?.environmentChanged()
          if (userId !== undefined && disabledSessionUserId(error) === userId)
            sessionEndedReason = 'account_disabled'
          unauthenticatedPending = true
          void confirmForSave(true)
        },
        saveStale: () => {
          identityEpoch += 1
          extension?.environmentChanged()
          staleAfter = checksStarted
          syncWritable()
          void confirmForSave(true)
        },
        writeProblem,
        readProblem: (error) => {
          identityEpoch += 1
          extension?.environmentChanged()
          if (userId !== undefined && disabledSessionUserId(error) === userId)
            sessionEndedReason = 'account_disabled'
          void recheckSession()
        },
      },
      autosave: { page: autosavePage, ...options.autosaveControl },
      sameBrowser,
      pendingSave: options.pendingSave(user, id),
      issuedRequest: options.issuedRequest(id),
      reportError: options.reportError,
      trace: options.handoverTrace,
    })
    cleanups.push(created.subscribe(modeChanged))
    return created
  }

  return {
    extension: () => extension,
    retryRecovery: async () => recoveryAction(async current => current.discover()),
    copyRecovery: async () => recoveryAction(async current => current.copy()),
    beginDiscardRecovery: () => confirmedForWrite() && (mode === undefined || mode.view().mode.kind === 'reading') ? recovery?.beginDiscard() : undefined,
    discardRecovery: async intent => recoveryAction(async current => current.discard(intent)),
    retryRecoveryCleanup: async () => recoveryAction(async current => current.retryCleanup(), false),
    acknowledgeRecovery: async at => recoveryAction(async current => current.acknowledge(at), false),
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
      // 本页的键盘、鼠标操作（捕获阶段）：心跳据此上报多久没有操作，空闲释放据此计时。挂在交互屏障之前，载入期间被拦下的输入也算有操作。
      // 页面隐藏、关闭时尽力释放编辑权（keepalive，结果不管）
      const pageWindow = options.chrome.ownerDocument.defaultView ?? window
      cleanups.push(options.activity.subscribe(() => {
        lastActivity = clock.now()
        mode?.noteActivity()
      }))
      // 关闭时有保存在途不释放（edit-mode.ts 的 releaseOnHide，M3-P4 设计 §3.4）
      const onPageHide = (): void => {
        pageHidden = true
        extension?.hide()
        imageAccess?.suspend()
        recovery?.suspend()
        mode?.releaseOnHide()
      }
      pageWindow.addEventListener('pagehide', onPageHide)
      cleanups.push(() => pageWindow.removeEventListener('pagehide', onPageHide))
      // 自动保存的页面信号：可见性（同步通知）与联网；恢复联网、回到前台时上一次确认会话失败了就再确认（审查 A6）
      let browserOnline = options.network.online()
      cleanups.push(options.visibility.onChange(signalPage), options.network.onChange(() => {
        signalPage()
        update()
        const next = options.network.online()
        const returned = next && !browserOnline
        browserOnline = next
        if (returned)
          refreshImages()
        // 共享连接也发布请求失败；它不是浏览器恢复在线，不能让会话确认自己触发下一轮。
        recheckOnReturn(returned)
      }))
      cleanups.push(
        options.visibility.onChange(() => recheckOnReturn(!options.visibility.hidden())),
      )
      setSurface('loading')
      cleanups.push(sessionChannel.subscribe(() => void recheckSession()))
      let signedIn: SessionResponse
      let document: DocumentDetail
      let content: LoadedContent
      let readRound: number | undefined
      try {
        // 先确认会话（拿到 CSRF 令牌），再并行读取元数据与内容（P4 设计 §3.7.1）
        signedIn = await api.session()
        if (disposed)
          return
        setApiSession(signedIn)
        userId = signedIn.user.id
        acceptPageSession(signedIn)
        imageAccess = createEditorImageAccess(userId)
        localDraftsEnabled = signedIn.features.localDraftsEnabled
        localPermit = draftSessionPermitOf(signedIn)
        // 确认会话的回包之前别的标签页登录或退出了：消息当时没法处理，现在补确认一次
        if (checkWhenLoaded)
          void recheckSession()
        readRound = checksStarted
        ;[document, content] = await Promise.all([api.document(documentId), api.content(documentId)])
      }
      catch (error) {
        if (!disposed) {
          // 404 之后的可读判定用装配表里全部的档案（S8 spec §2.7：草稿记录里有档案、没有类型）。第一次判定与档案无关（读不到就删），
          // 清理失败之后的重试改问编辑状态，才走格式判断
          const formats = formatsOf(options.assemblies)
          if (isMissingResource(error) && userId !== undefined && readRound === checksStarted && confirmedForWrite() && formats !== undefined) {
            prepareRecovery(documentId, userId, formats)
            earlyUnreadableRound = readRound
            try {
              await recovery?.discover()
            }
            finally {
              earlyUnreadableRound = undefined
            }
          }
          if (!disposed)
            loadFailed(error)
        }
        return
      }
      if (disposed)
        return
      const assembly = assemblyFor(document, options.assemblies)
      if (assembly === undefined) {
        finish({ kind: 'unsupported' })
        return
      }
      // 选中装配，建页面扩展（S8 spec §2.2）。载入期间页面已经隐藏（那时还没有扩展）：建好之后立即 hide，与原来 pagehide 时就销毁的结果相同
      const assembled = assembly.assemble(host)
      extension = assembled.extension
      if (pageHidden)
        extension.hide()
      heading = headingOf(document, signedIn.user.id)
      imagePermissions(true, document.permissions.canEdit, document.permissions.canTakeOver)
      const canEdit = document.permissions.canEdit
      // 新于本页的内容只能阅读。
      const blocked = documentIsNewer(document) ? 'document-too-new' : undefined
      // 载入之后的可读判定只用选中的装配的档案：用全集的话，文字文档页会把同一文档 id 下表格档案的草稿当成可读（S8 spec §2.6）
      prepareRecovery(documentId, signedIn.user.id, [assembly.format])
      const opened = createMode(documentId, signedIn.user.id, assembled, assembly.format)
      mode = opened
      // 载入期间别的标签页换了人或者退出了：按确认的结果开始（不是本人时不续租、不检查）
      opened.setSession(session)
      // 阅读页的"公式待更新"（M3-P4 设计 §3.5 第 4 条）：详情说的是它那一版的，与载入的内容是同一版时才用（并行读取之间有人保存过时下一次检查补上）
      const formulasPending = document.formulasPending && document.revision === content.revision
      const outcome = await opened.open({ snapshot: content.snapshot, revision: content.revision, canEdit, formulasPending, canTakeOver: document.permissions.canTakeOver }, { enterEdit: options.editIntent.requested && canEdit && serverAvailable() && confirmedForWrite(), blocked })
      if (disposed)
        return
      if (outcome.kind === 'load-failed') {
        loadFailed(outcome.error)
        return
      }
      if (outcome.kind === 'editor-failed')
        return
      // 刚由自己新建的表格进入了编辑：去掉地址里的标记，刷新不再自动进入。打开自检失败（只能阅读，M3-P4 设计 §3.12）时同样去掉：
      // 编辑权已经放掉，刷新不再"先取后放"一次
      if (options.editIntent.requested && (outcome.entered || outcome.damaged))
        options.editIntent.clear()
      load = { kind: 'ready', ...heading }
      modeChanged()
      if (mode.view().mode.kind === 'reading')
        void recovery?.discover()
    },
    save: async () => {
      const view = mode?.view()
      if (view?.mode.kind !== 'editing' || view.save === undefined)
        return
      // 版本冲突之后再按：不做任何事（P4 设计 §3.7.2）。保存中照样做：在途的结束之后立即再存一次（M3-P4 设计 §3.4、§3.9）
      if (view.save.status === 'conflict')
        return
      // 按下的这一刻就提交这一刻开着的单元格编辑（审查 A1：要等会话确认时也不例外，确认期间才开始的输入不提交），会话确认之后才上传
      await mode?.save(readyToWrite)
    },
    enterEditing: async () => {
      if (extension?.blocksActions() === true)
        return
      if (!serverAvailable())
        return
      if (mode?.view().mode.kind !== 'reading')
        return
      // 进入编辑要申请编辑权（写的操作）：与保存、退出编辑同一个会话确认——没有人登录、换了人、令牌已知失效时不申请，
      // 免得先得到一次"没能进入编辑"（审查 A10）。不必确认时在点下去的这一刻就开始（"正在进入编辑"与交互屏障随之就有）
      const prepare = recovery?.beginRestore()
      if (!confirmedForWrite() && !(await readyToWrite()))
        return
      await mode.enter(prepare)
    },
    takeOverHere: async () => {
      if (extension?.blocksActions() === true)
        return
      if (!serverAvailable())
        return
      if (mode?.view().mode.kind !== 'reading')
        return
      // 本人接管要申请编辑权（写的操作）：与"编辑"同一个会话确认
      const prepare = recovery?.beginRestore()
      if (!confirmedForWrite() && !(await readyToWrite()))
        return
      await mode.takeOver(prepare)
    },
    cancelTakeOver: () => mode?.cancelTakeOver(),
    forceTakeOver: async () => {
      if (extension?.blocksActions() === true)
        return
      if (!serverAvailable())
        return
      if (mode?.view().mode.kind !== 'reading')
        return
      // 强制接管要申请编辑权（写的操作）：与"编辑"同一个会话确认
      const prepare = recovery?.beginRestore()
      if (!confirmedForWrite() && !(await readyToWrite()))
        return
      await mode.forceTakeOver(prepare)
    },
    dismissInterruption: () => mode?.dismissInterruption(),
    requestEditing: async () => {
      if (extension?.blocksActions() === true)
        return
      if (!serverAvailable())
        return
      if (mode?.view().mode.kind !== 'reading')
        return
      // 发出请求是写的操作：与"编辑"同一个会话确认
      if (!confirmedForWrite() && !(await readyToWrite()))
        return
      await mode.requestEdit()
    },
    cancelRequest: async () => {
      if (!serverAvailable())
        return
      if (mode?.view().mode.kind !== 'reading')
        return
      if (!confirmedForWrite() && !(await readyToWrite()))
        return
      await mode.cancelRequest()
    },
    handOver: async () => {
      if (extension?.blocksActions() === true)
        return
      if (!serverAvailable())
        return
      if (mode?.view().mode.kind !== 'editing')
        return
      // 交出要先保存、带着令牌交出：与退出编辑同一个会话确认（换了人、令牌已知失效时不发，留在编辑）
      if (await readyToWrite())
        await mode.handOver()
    },
    keepEditing: async () => {
      if (extension?.blocksActions() === true)
        return
      if (!serverAvailable())
        return
      if (mode?.view().mode.kind !== 'editing')
        return
      if (await readyToWrite())
        await mode.decline()
    },
    exitEditing: async () => {
      if (extension?.blocksActions() === true)
        return
      if (!serverAvailable())
        return
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
      if (!serverAvailable())
        return
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
      const round = ++detailRound
      let permissionsEpoch = imagePermissionEpoch
      detailRefreshes += 1
      update()
      let document: DocumentDetail
      try {
        // 停写补核尚未完成时，明确重试合并确认并检查最终身份；失败源只由明确重试清除。
        if (pageSession === undefined) {
          await recheckSession()
          if (disposed || heading === undefined || round !== detailRound || session !== 'active' || sessionProblem !== undefined || pageSession === undefined) {
            detailRefreshes -= 1
            update()
            return
          }
          permissionsEpoch = imagePermissionEpoch
        }
        document = await api.document(documentId)
      }
      catch (error) {
        detailRefreshes -= 1
        if (disposed || heading === undefined)
          return
        // 较新的许可只阻止旧成功重新授权；实际拒绝仍须清图，不能被并发成功掩盖。
        if (round !== detailRound) {
          update()
          return
        }
        // 看不到了（已经删除、移走，或者自己被移出、授权被取消）：不再能分享。未登录交给会话的确认（页头随之说明）；
        // 别的失败：页头留着之前的信息，说明没能刷新、可以重试（DEF-040，与列表的"没能刷新"同一个说法）
        if (isMissingResource(error)) {
          imagePermissions(false)
          heading = { ...heading, canShare: false, canViewHistory: false }
          detailProblem = undefined
        }
        else if (isAuthenticationError(error)) {
          update()
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
      detailRefreshes -= 1
      if (disposed || heading === undefined)
        return
      if (round !== detailRound || permissionsEpoch !== imagePermissionEpoch) {
        update()
        return
      }
      heading = headingOf(document, heading.userId)
      detailProblem = undefined
      // 先更新详情事实，状态机随后的同一权限通知不重复刷新。
      imagePermissionEpoch += 1
      imageReadable = true
      imageCanEdit = document.permissions.canEdit
      imageCanTakeOver = document.permissions.canTakeOver
      mode?.updateCanEdit(document.permissions.canEdit)
      refreshImages()
      if (load.kind === 'ready')
        load = { kind: 'ready', ...heading }
      update()
    },
    recheckSession,
    dispose: () => {
      disposed = true
      extension?.dispose()
      imageAccess?.dispose()
      recovery?.dispose()
      cancelRecheck?.()
      cancelRecheck = undefined
      releaseBarrier?.()
      releaseBarrier = undefined
      for (const cleanup of cleanups.splice(0))
        cleanup()
      mode?.dispose()
      listeners.clear()
      pageSignalListeners.clear()
    },
  }
}
