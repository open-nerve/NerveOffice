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
// - exiting：离开编辑（leaveEditing，带原因，M3-P5 设计 §3.10）——先保存（保存失败就留在编辑），捕获，释放编辑权（等它的结果，
//   至多 EXIT_RELEASE_WAIT_MS；结果未知、到了时限也照样退出），重建为只读。原因：exit 是"退出编辑"（公式没收齐也留在编辑）；
//   idle 是空闲释放（US-M3-07）、handover-tab 是交给本浏览器的另一个标签页（US-M3-08）、handover-request 是交给请求编辑的人（US-M3-06），
//   这三种公式没收齐也离开、带"公式待更新"；
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
// 交接规则（M3-P5 设计 §3.1、§3.9）：
// - 先服务端、后本机锁：服务端批准之后（进入编辑、?edit=new 直接进入）拿这份文档的本机锁（same-browser.ts）——锁空着就拿，被本浏览器的
//   别的标签页占着就抢（服务端批给了本页，那一页的租约必然已经失效）；离开编辑（退出、空闲释放、失去编辑权、没能进入、卸载、页面关闭）
//   一律放锁。锁被抢的一方不再问服务端、不续上（租约 abandon），立即转为失去编辑权（taken-over、this-browser），有没保存的修改照旧
//   给副本与放弃；
// - 离开编辑一律先挡住输入再保存：begin(exiting) 的那一刻页面挂上交互屏障，然后挂起调度、等面板、flush（P4：提交哪一次单元格编辑
//   在调用的那一刻定）；
// - 空闲释放（idle-watch.ts）：编辑时 max(最后一次操作, 进入编辑的时刻) 起 10 分钟没有操作——会话可写、联网时（不主动向服务端确认会话）
//   先保存再释放、以只读重建，阅读里说明；没存上就留在编辑，过一个心跳周期再看（再也存不上的不再试，服务端 12 分钟兜底）。
//   释放开始的那一刻就停止续上（租约 holdRecovery），没释放成再恢复；
// - 页面关闭（pagehide）时保存忙或者结果未知（WebKit 在导航一开始就取消在途的请求）：不释放（P4），另在 localStorage 记下这份文档有一次
//   保存可能还在服务端处理（pending-save-marker.ts，新的标签页本人接管之前等它）。
//
// 本人接管（M3-P5 设计 §3.7，US-M3-08）：
// - 阅读时持有者是自己（别的标签页或设备）：看这份文档的本机锁在本浏览器里有没有人持有（selfHolder：this-browser 是本浏览器的另一个
//   标签页，elsewhere 是另一台设备、浏览器，也可能是刚关闭、刷新过的页面），页头的按钮换成"在此编辑"。点"编辑"之后才得知被自己占着
//   时同样换成"在此编辑"；锁被本浏览器占着时不按 SAME_USER_RETRIES 再试（那几次是给刷新时晚到的释放的）；
// - "在此编辑"（takeOver，阅读里带进展 takeover）：编排在 tab-handover.ts（takeOverHere：看锁在哪里、请本浏览器的标签页先保存再交出、等刷新之前
//   在途的保存，再决定怎样申请），这里开始这一件事（阅读里带上进展、作废之前的）、按进展更新阅读、申请并以可编辑重建；"取消"撤下还挂着的等待；
// - 交接请求的回应在 tab-handover.ts（answerTabs）：编辑时它同步回 ack，再经回调让这里离开编辑（handover-tab：屏障 → 挂起 → 等面板 →
//   flush('handover') → 存上就放弃这一代（停心跳、不释放：那边以本人接管换代，槽从来不空，审查 B4）→ 放锁 → done → 以只读重建 → 阅读，
//   说明已交给本浏览器的另一个标签页；没存上发 failed、留在编辑）；离开编辑有了结果时经它告诉回应过 ack 的请求；
// - 跨设备被接管：续租或保存得到 taken_over（forced 为假）→ 不续上，失去编辑权（taken-over、elsewhere），副本照常。
//
// 强制接管（M3-P5 设计 §3.8，US-M3-09）：
// - 空间管理员（个人空间是所有者；canTakeOver）在阅读时、别人在编辑时"请求编辑"旁边另有"强制接管"（与请求编辑、"在此编辑"互斥）：页面先确认
//   （确认框关掉、焦点交还之后才开始，结果的说明因此都写在那之后）、再确认会话，然后以 takeover: 'force' 申请并进入编辑（进入的状态带 forced，
//   页头的"强制接管"留着、说正在接管）；不能了（403：不再是空间管理员、只能查看、空间已归档）说明原因、不再给"强制接管"（随后的检查按编辑状态
//   更新"编辑"）；编辑权刚交给了别人、还在保留期内（EDIT_LEASE_RESERVED）说明留给了谁、留到何时、这期间不能强制接管；别的失败说没能强制接管；
// - 被接管的一方：续租或保存得到 taken_over、forced 为真 → 不续上，失去编辑权（forced）；失去编辑权时读一次编辑状态（那边已经取得了新的一代），
//   正在编辑的是别人就是接管的人，补进说明（读到之前、没读到时只说空间管理员强制接管了编辑）。副本与放弃照旧。
//
// 异常中断的提醒（M3-P5 设计 §3.5、§3.11，US-M3-10）：
// - 用户发起的申请（"编辑""在此编辑""强制接管"、请求被批准之后的自动进入、?edit=new）的响应带着上一位编辑者异常中断的提醒时，进入编辑之后
//   编辑的状态带着它（页头下面一条不打断的说明与"知道了"，读屏状态区播一次），"知道了"之后、离开编辑、失去编辑权时去掉；续上（edit-lease.ts 的
//   recover）的申请不交回提醒，从不显示；说的是本页自己那一代（服务端给的 samePage）的，edit-lease.ts 同样不交回；
// - 阅读时编辑状态里有提醒（没人在编辑时服务端才给）而且是别人的那一代：阅读的状态带着它（读屏状态区里说明，阅读页不必等点"编辑"）。自己的那一代
//   不在阅读时说：本页退出时释放没送到、那一代到期的，服务端照样算异常中断，而本页的修改其实都已存上，编辑状态又不知道是哪个页面——点"编辑"之后
//   申请的回答带着 samePage，是本页自己的就不说，是别的标签页、设备上的才说。
//
// 测试构建的观察钩子（M3-P5 设计 §3.13，handover-trace.ts）：申请与结果、进入编辑、离开编辑、锁被抢、"在此编辑"与交接的各步、请求编辑的续期与进入，
// 各报一条（options.trace；生产不给）。
//
// 请求编辑与交出（M3-P5 设计 §3.6，US-M3-06）：
// - 请求方（阅读时，持有者是别人）：请求的发出、等待、续期、取消与空闲取消在 edit-request.ts，进展放进阅读的状态（request）；编辑权交给了本页
//   （或者空着）、页面看得见时以普通申请进入编辑（与"编辑"同一个入口，空闲释放从进入的那一刻重新算）；正在编辑的是自己时改走"在此编辑"；
//   别的结束（谢绝、别人先请求了、编辑权刚交给了别人、请求不在了、空闲取消、没能请求）放进阅读的说明。与"在此编辑"互斥：一个在进行时另一个不开始。
//   编辑状态里有本人的请求而本页没在等时：这一页发出过它（刷新之前发出、刷新时撤回没送到）就恢复等待；本人在别的页面、设备上发出的不恢复，阅读里
//   说一句（审查 B2：不然这一页关掉、空闲就把那边正在等的请求撤掉）。申请得到 EDIT_LEASE_RESERVED（编辑权刚交给了别人）时说明交给了谁、留到何时；
// - 持有者（编辑时）：心跳带来的待回应的请求、2 分钟的计时、谢绝与交出的结果在 holder-requests.ts，在等的请求与说明放进编辑与离开编辑的状态
//   （页头下面的提示）。本页空闲满 2 分钟（请求到达时已经满了，或者提示在的时候到了）就自动交出（会话可写、联网时）。"交出"与自动交出是
//   leaveEditing('handover-request')：屏障 → 挂起 → 等面板 → flush('handover') → 存上了（公式没收齐也可以）就交出（POST …/handover，至多
//   EXIT_RELEASE_WAIT_MS）→ 停止续租（服务端已经结束这一代）→ 放锁 → 以只读重建 → 阅读，说明交给了谁；没存上、交不出（没有结果）就留在编辑、
//   说明原因，请求照旧在；请求已经不在（EDIT_REQUEST_GONE）就留在编辑、说明请求方取消了；这一代已经因为别的原因失效时按失去编辑权。
//   "继续编辑"：谢绝（带令牌），提示消失；
// - 退出编辑、空闲释放与页面关闭时有待回应的请求：用交出代替释放（交不出时退出与空闲释放照常释放；关页时 keepalive，保存忙或者结果未知时
//   照 P4 不释放、也不交出）。
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
import type { ConflictCopyQuery, CreatedDocument, DocumentDetail, EditInterruption, OpenCheckReport, PendingEditRequest, SaveContentResponse, UserSummary } from '@nerve-office/contracts'
import type { OpenCheck, SheetEditor } from '../../editor/index.ts'
import type { Autosave, AutosaveEvent, AutosavePage, AutosaveTuning, AutosaveView, FlushResult } from './autosave.ts'
import type { Incompatibility } from './client-format.ts'
import type { AcquireIntent, EditLease, EditLeaseApi, LeaseAcquisition, LeaseClock, LeaseHolder, LeaseLoss } from './edit-lease.ts'
import type { EditRequestApi, EditRequestEnd, EditRequestProgress } from './edit-request.ts'
import type { FetchedEditStatus, LeaseCredentials, LoadedContent } from './editor-api.ts'
import type { CreateModeEditor, EditorSurface } from './editor-slot.ts'
import type { AcquireTrigger, HandoverTrace, HandoverTraceEvent } from './handover-trace.ts'
import type { EditingNotice, IncomingRequest } from './holder-requests.ts'
import type { IdleWatch } from './idle-watch.ts'
import type { IssuedRequestMarker } from './issued-request.ts'
import type { LostCopy } from './lost-copy.ts'
import type { OpenCheckContext } from './open-check-report.ts'
import type { PendingSaveMarker } from './pending-save-marker.ts'
import type { PageVisibility, ReadingCheckResult } from './reading-checks.ts'
import type { HandoverFailure, HeldLock, SameBrowser } from './same-browser.ts'
import type { CompressSnapshot, SaveCoordinator, SaveRequest, SaveStatus, SaveView } from './save-coordinator.ts'
import type { TabAnswerPhase, TakeoverProgress } from './tab-handover.ts'
import { EDIT_IDLE_RELEASE_SECONDS, EDIT_LEASE_HEARTBEAT_SECONDS, EDIT_LEASE_TTL_SECONDS, editLeaseReservedDetailsSchema } from '@nerve-office/contracts'
import { ApiError, isAuthenticationError, isCsrfTokenError, isNotFoundError, isPermissionDeniedError } from '../../shared/api/index.ts'
import { createAutosave } from './autosave.ts'
import { incompatibilityOf } from './client-format.ts'
import { acquireEditLease, leaseHolderOf, leaseLossOf, within } from './edit-lease.ts'
import { createEditRequests } from './edit-request.ts'
import { CONTENT_UNCHANGED } from './editor-api.ts'
import { createEditorSlot } from './editor-slot.ts'
import { createHolderRequests } from './holder-requests.ts'
import { createIdleWatch } from './idle-watch.ts'
import { createLostCopy } from './lost-copy.ts'
import { openCheckReportOf } from './open-check-report.ts'
import { createReadingChecks } from './reading-checks.ts'
import { createSaveCoordinator } from './save-coordinator.ts'
import { answerTabs, handoverFailureOf, takeOverHere } from './tab-handover.ts'

/** 状态里带着的：持有者这一侧的请求与说明（编辑、离开编辑，holder-requests.ts）；"在此编辑"的进展（阅读，tab-handover.ts） */
export type { EditingNotice, IncomingRequest, TakeoverProgress }

/**
 * 退出编辑时等释放的结果，至多这么久（审查 A7）：释放只是让别人早一点能编辑，不影响正确性——没送到的那一代至多一个有效期
 * （EDIT_LEASE_TTL_SECONDS，90 秒）后自行到期，本页再申请时同一个 clientInstanceId 按重试处理、照样取得。请求挂住（代理不回、
 * 连接卡住）时要等浏览器自己超时，页面一直停在"正在退出编辑…"、交互屏障挡着、没有办法取消；5 秒够一次正常的释放（通常几十毫秒），
 * 到了时限照样退出，阅读页如实说明那一代可能还在（releaseUnconfirmed）
 */
export const EXIT_RELEASE_WAIT_MS = 5_000

/** 空闲释放的阈值（US-M3-07）：10 分钟没有键盘、鼠标操作 */
const IDLE_RELEASE_MS = EDIT_IDLE_RELEASE_SECONDS * 1000

/** 空闲释放这一轮没成（没存上、会话不对、没联网）之后，隔多久再看：一个心跳周期（M3-P5 设计 §3.9）。自动交出没成时同样（holder-requests.ts） */
export const IDLE_RECHECK_MS = EDIT_LEASE_HEARTBEAT_SECONDS * 1000

/** 离开编辑的各种原因的名字（以只读重建失败时的错误说明里用） */
const LEAVE_LABELS: Readonly<Record<LeaveCause, string>> = {
  'exit': '退出编辑',
  'idle': '空闲释放',
  'handover-request': '交给请求编辑的人',
  'handover-tab': '交给本浏览器的另一个标签页',
}

/**
 * 离开编辑之后阅读里的说明：退出没有（人自己按的），空闲释放与交给本浏览器的另一个标签页说明为什么回到了阅读。交给了请求编辑的人（含退出、
 * 空闲释放时有请求在等、用交出代替了释放）另说交给了谁（handed-over，见 leaveEditing）：handover-request 走到回到阅读这一步时一定交出了
 */
const LEAVE_NOTICES: Readonly<Record<LeaveCause, ReadingNotice | undefined>> = {
  'exit': undefined,
  'idle': { kind: 'idle-released' },
  'handover-request': undefined,
  'handover-tab': { kind: 'handed-over-tab' },
}

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
 * 阅读时的一次检查读到的：编辑状态，以及持有者是自己时那个页面在不在本浏览器（M3-P5 设计 §3.7）；发出时请求编辑的进展的版本（M3-P5 设计 §3.6：
 * 变过了的话，读到的"有本人的请求"可能已经过时）
 */
interface CheckedStatus {
  readonly fetched: FetchedEditStatus
  readonly selfHolder: SelfHolder | undefined
  readonly requestVersion: number
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
  /** 空闲释放（US-M3-07）：10 分钟没有操作，已保存并释放编辑权 */
    | { readonly kind: 'idle-released' }
  /** 本浏览器的另一个标签页要"在此编辑"（US-M3-08）：本页已保存、交出了编辑权 */
    | { readonly kind: 'handed-over-tab' }
  /** 交给了请求编辑的人（US-M3-06）：交给了谁；auto 是空闲满 2 分钟自动交出的（空闲释放时有请求在等、用交出代替释放的也是） */
    | { readonly kind: 'handed-over', readonly to: UserSummary, readonly auto: boolean }
  /**
   * 编辑权刚交给了别人、还在保留期内（M3-P5 设计 §3.6：申请得到 EDIT_LEASE_RESERVED，请求得到 reservedForOther）：留给了谁、留到何时
   * （服务端的时刻，只格式化、不与浏览器的时钟比较）。forced：是强制接管时得到的（保留期内强制接管同样被挡，§3.8）
   */
    | { readonly kind: 'reserved', readonly reservedFor: UserSummary, readonly reservedUntil: string, readonly forced?: boolean }
  /** 强制接管时不能了（403：不再是空间管理员、只能查看、空间已归档等，M3-P5 设计 §3.8）：error 带服务端的原因；不再给"强制接管" */
    | { readonly kind: 'force-denied', readonly error: ApiError }
  /** 强制接管没有成功（网络、服务端出错、登录的问题等）：可以再试 */
    | { readonly kind: 'force-failed', readonly error: unknown }
  /** 请求编辑结束了（US-M3-06）：持有者选了"继续编辑"（谁） */
    | { readonly kind: 'request-declined', readonly holder: UserSummary }
  /** 同上：别人先请求了（谁），本页的请求没有发出 */
    | { readonly kind: 'request-occupied', readonly requester: UserSummary }
  /** 同上：请求已经不在了（换了一代、过期、被别人的新请求替换），可以重新请求 */
    | { readonly kind: 'request-gone' }
  /** 同上：等待中本页空闲满 10 分钟，取消了 */
    | { readonly kind: 'request-idle' }
  /** 没能请求编辑：不能编辑了（403，error 带服务端的原因） */
    | { readonly kind: 'request-denied', readonly error: ApiError }
  /** 没能请求编辑（网络、服务端出错、登录的问题等）：可以再试 */
    | { readonly kind: 'request-failed', readonly error: unknown }

/**
 * 持有者是自己时那个页面在哪里（M3-P5 设计 §3.7，按本机锁在本浏览器里有没有人持有）：this-browser 是本浏览器的另一个标签页；elsewhere 是
 * 另一台设备、浏览器（或配置文件、无痕窗口），也可能是刚关闭、刷新过的页面（锁随页面放开了，编辑权还在服务端）
 */
export type SelfHolder = 'this-browser' | 'elsewhere'

export interface ReadingMode {
  readonly kind: 'reading'
  /** 现在能不能编辑（打开时取详情的，之后随编辑状态更新）：不能时没有"编辑" */
  readonly canEdit: boolean
  /** 正在编辑的人（编辑状态给出，或者申请时被占用）；没有人在编辑时为 undefined */
  readonly holder: LeaseHolder | undefined
  /** 持有者是自己时那个页面在哪里（M3-P5 设计 §3.7）：持有者不是自己（或者不知道是谁）时为 undefined */
  readonly selfHolder: SelfHolder | undefined
  /** "在此编辑"的进展（M3-P5 设计 §3.7）：没有在接手时为 undefined */
  readonly takeover: TakeoverProgress | undefined
  /** 请求编辑的进展（M3-P5 设计 §3.6，edit-request.ts）：没有请求时为 undefined。与"在此编辑"互斥 */
  readonly request: EditRequestProgress | undefined
  /**
   * 编辑状态里有本人在别的页面、设备上发出、正在等回应的请求，而不是这一页发出的（M3-P5 审查 B2，issued-request.ts）：读屏状态区里说一句；这一页不续期、
   * 不撤回、不空闲取消、不自动进入。本页有请求时（这一页再点"请求编辑"就成为发出过的页面）为假
   */
  readonly requestedElsewhere: boolean
  /**
   * 能不能强制接管（空间管理员、个人空间的所有者，M3-P5 设计 §3.8）：打开时取详情的，之后随编辑状态更新。持有者谢绝了请求时，不能强制接管的人
   * 另说可以请空间管理员强制接管
   */
  readonly canTakeOver: boolean
  /**
   * 上一位编辑者（别人）的那一代异常中断、还在 30 分钟以内（M3-P5 设计 §3.5：编辑状态里没人在编辑时服务端给出，阅读页不必等点"编辑"）：
   * 读屏状态区里说明。自己的那一代不在阅读时说（见文件头），没有时为 undefined
   */
  readonly interruption: EditInterruption | undefined
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

/**
 * 离开编辑的原因（M3-P5 设计 §3.10，页头按它说）：exit 是"退出编辑"；idle 是空闲释放（US-M3-07）；handover-request 是交给请求编辑的人
 * （S7）；handover-tab 是交给本浏览器的另一个标签页（US-M3-08）。退出要求公式收齐，其余可以带"公式待更新"离开
 */
export type LeaveCause = 'exit' | 'idle' | 'handover-request' | 'handover-tab'

export type EditModeState
  = | { readonly kind: 'opening' }
    | ReadingMode
  /** forced：这一次是强制接管（M3-P5 设计 §3.8：页头的"强制接管"留着、说正在接管） */
    | { readonly kind: 'entering', readonly forced?: boolean }
  /**
   * request：持有者这一侧在等回应的请求编辑（页头下面的提示），没有时为 undefined；notice：编辑时的说明；interruption：进入编辑时申请带回的
   * 上一位编辑者异常中断的提醒（M3-P5 设计 §3.5，"知道了"之后为 undefined）
   */
    | { readonly kind: 'editing', readonly request?: IncomingRequest | undefined, readonly notice?: EditingNotice | undefined, readonly interruption?: EditInterruption | undefined }
  /** request：开始离开时在等回应的请求编辑（提示留着、按钮不可用，焦点不丢）；interruption：同编辑时（离开结束才消失） */
    | { readonly kind: 'exiting', readonly cause: LeaveCause, readonly request?: IncomingRequest | undefined, readonly interruption?: EditInterruption | undefined }
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
  /** 请求编辑：请求方的发出、续期与取消（M3-P5 设计 §3.6） */
  readonly editRequest: EditRequestApi
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
  /** 本页这次加载的标识：编辑租约绑定它，保存也带着它；交接频道的消息里是本页的标识 */
  readonly clientInstanceId: string
  /** 本页的用户（载入时确认的）：交接频道的请求带上它，回应时只理会同一个人的（M3-P5 设计 §3.7） */
  readonly userId: string
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
  /**
   * 自动保存（M3-P4）：页面的信号、快照的摘要与测试构建的控制。页面的信号里的"会话可写"（confirmedForWrite 的口径）与联网
   * 也是空闲释放的门槛：不由用户发起的写，不主动向服务端确认会话（M3-P5 设计 §3.9）
   */
  readonly autosave: EditModeAutosave
  /** 同一个浏览器里的标签页（same-browser.ts）：这份文档的本机锁（编辑时持有，M3-P5 设计 §3.1） */
  readonly sameBrowser: SameBrowser
  /** 刷新时在途的保存的记号（pending-save-marker.ts）：页面关闭时保存忙就记下（M3-P5 设计 §3.7 的 R1） */
  readonly pendingSave: PendingSaveMarker
  /** 这一页发出过的请求编辑的记号（issued-request.ts，按标签页）：只有发出过它的那一页恢复等待（M3-P5 审查 B2） */
  readonly issuedRequest: IssuedRequestMarker
  /** 意外的错误：上报（浏览器的 reportError） */
  readonly reportError: (error: unknown) => void
  /** 测试构建的观察钩子（M3-P5 设计 §3.13，handover-trace.ts）：交接的各步；生产不给 */
  readonly trace?: HandoverTrace | undefined
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
  readonly open: (initial: { readonly snapshot: string, readonly revision: number, readonly canEdit: boolean, readonly formulasPending?: boolean, readonly canTakeOver?: boolean }, options: { readonly enterEdit: boolean, readonly blocked?: Incompatibility | undefined }) => Promise<OpenOutcome>
  /** 进入编辑（阅读、能编辑、没有在按新的版本重建、没有在接手、没有请求时；"编辑"按钮，会话由页面先确认） */
  readonly enter: () => Promise<void>
  /**
   * "请求编辑"（M3-P5 设计 §3.6，US-M3-06；会话由页面先确认）：阅读、能编辑、没有在按新的版本重建、没有在接手、没有请求时发出；之后的等待、
   * 进入编辑与说明见文件头
   */
  readonly requestEdit: () => Promise<void>
  /** "取消请求"（等待中；会话由页面先确认） */
  readonly cancelRequest: () => Promise<void>
  /** 提示里的"交出"（编辑、有请求在等时；会话由页面先确认）：离开编辑的 handover-request */
  readonly handOver: () => Promise<void>
  /** 提示里的"继续编辑"（编辑、有请求在等时；会话由页面先确认）：谢绝，提示消失 */
  readonly decline: () => Promise<void>
  /**
   * "在此编辑"（M3-P5 设计 §3.7，US-M3-08；会话由页面先确认）：本人接管自己在别的标签页或设备上的编辑权。阅读、能编辑、没有在按新的版本重建、
   * 没有在接手时；那边没能交出（takeover 是 failed）时再按就是"仍在此编辑"——本人接管并抢锁，不再请它交出
   */
  readonly takeOver: () => Promise<void>
  /** "在此编辑"那边没能交出之后选"取消"（接手的过程中也可以）：不再接手，回到阅读 */
  readonly cancelTakeOver: () => void
  /**
   * "强制接管"（M3-P5 设计 §3.8，US-M3-09；确认与会话由页面先做）：阅读、能编辑、能强制接管、没有在按新的版本重建、没有在接手、没有请求、
   * 正在编辑的不是自己时，以 takeover: 'force' 申请并进入编辑（见文件头）
   */
  readonly forceTakeOver: () => Promise<void>
  /** 异常中断的说明里的"知道了"（编辑、离开编辑的过程中）：说明消失 */
  readonly dismissInterruption: () => void
  /** 退出编辑（"退出编辑"按钮，会话由页面先确认）：离开编辑的 exit（公式没收齐就留在编辑） */
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
  /**
   * 页面确认会话是本人之后：恢复续租并立即续租一次（登录可能换过）；这一次有了结果之后兑现。连着的会话类失败的第二次起只按心跳排下一次、
   * 立即兑现（edit-lease.ts 的 resume：那时服务端一直拒绝，立即核对也只会再被拒）
   */
  readonly resumeLease: () => Promise<void>
  /** 页头的文档详情刷新了：能不能编辑随之更新（阅读时） */
  readonly updateCanEdit: (canEdit: boolean) => void
  /** 本页有键盘、鼠标操作 */
  readonly noteActivity: () => void
  /**
   * 页面关闭（pagehide）：放下本机锁，尽力释放编辑权（不等结果）。有保存在途（含终态之后核对的原样重发）时不释放，让租约到期（M3-P4 设计 §3.4）：
   * 服务端处理保存先在子进程里检查快照、再进事务读租约，晚几毫秒发出的释放多半先提交，那次保存就被拒（released）——这时另在 localStorage
   * 记下这份文档有一次保存可能还在处理（M3-P5 设计 §3.7 的 R1）。有待回应的请求编辑时用交出代替释放；本页在请求编辑时尽力取消请求（M3-P5 设计 §3.6）
   */
  readonly releaseOnHide: () => void
  /** 停止计时器，尽力释放编辑权，销毁保存的状态机与编辑器 */
  readonly dispose: () => void
}

/** 进入编辑之前的阅读（没有进入成功时回到它）：不会是正在按新的版本重建的那种（那时不能进入编辑，审查 A1） */
type SettledReading = ReadingMode & { readonly update: 'none' | 'available' }

/** 失去编辑权之后的阅读：被收回、不能编辑了时没有"编辑"（之后随编辑状态更新）；别处在编辑时说明是谁。canTakeOver 是最近一次知道的 */
function readingAfter(loss: LeaseLoss, notice: ReadingNotice | undefined, canTakeOver: boolean): ReadingMode {
  const canEdit = loss.kind !== 'denied' && !(loss.kind === 'lease' && loss.reason === 'revoked')
  return { kind: 'reading', canEdit, holder: loss.kind === 'held' ? loss.holder : undefined, selfHolder: undefined, takeover: undefined, request: undefined, requestedElsewhere: false, canTakeOver, interruption: undefined, update: 'none', gone: false, notice, releaseUnconfirmed: false, blocked: undefined, formulasPending: false, damaged: undefined }
}

/**
 * 申请得到 EDIT_LEASE_RESERVED（编辑权刚交给了别人、还在保留期内）时的说明；详情认不出时为 undefined（照别的失败说明）。forced：是强制接管时得到的
 */
function reservedNoticeOf(error: unknown, forced: boolean): ReadingNotice | undefined {
  if (!(error instanceof ApiError) || error.code !== 'EDIT_LEASE_RESERVED')
    return undefined
  const details = editLeaseReservedDetailsSchema.safeParse(error.details)
  if (!details.success)
    return undefined
  return { kind: 'reserved', reservedFor: details.data.reservedFor, reservedUntil: details.data.reservedUntil, ...(forced ? { forced } : {}) }
}

/** 错误的错误码（观察钩子里的写法）：不是服务端的错误（网络等）时为 null */
function codeOf(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null
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

/** 保存的状态机在终态（版本冲突、与服务端不兼容）：再也存不上，空闲释放不再试（服务端 12 分钟兜底，M3-P5 设计 §3.9） */
function saveEnded(status: SaveStatus): boolean {
  return status === 'conflict' || blockedBy(status) !== undefined
}

/** 收到交接请求时本页在做什么（tab-handover.ts 按它回应）：进入、编辑、离开编辑以外的状态里本页不持有本机锁 */
function tabPhaseOf(mode: EditModeState): TabAnswerPhase {
  switch (mode.kind) {
    case 'editing':
    case 'exiting':
    case 'opening':
    case 'entering':
      return mode.kind
    case 'reading':
    case 'losing':
    case 'lost':
    case 'failed':
    case 'unavailable':
      return 'none'
  }
}

/**
 * 空闲释放能不能放下编辑权（M3-P5 设计 §3.9）：本页的修改都已由服务端确认（公式没收齐也可以）；立即上传轮到时会话已经变差、
 * 没有发（skipped 的 session，M3-P4 交接单）算没存上
 */
function storedForRelease(saver: SaveCoordinator, flushed: FlushResult | undefined): boolean {
  const skipped = flushed?.outcome?.kind === 'skipped' && flushed.outcome.reason === 'session'
  return !saver.view().unsavedEdits && !skipped
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
  let readingBefore: SettledReading = { kind: 'reading', canEdit: false, holder: undefined, selfHolder: undefined, takeover: undefined, request: undefined, requestedElsewhere: false, canTakeOver: false, interruption: undefined, update: 'none', gone: false, notice: undefined, releaseUnconfirmed: false, blocked: undefined, formulasPending: false, damaged: undefined }
  /** 最近一次知道的"能不能强制接管"（打开时的详情、阅读时的编辑状态）：离开编辑、失去编辑权之后回到阅读时带上 */
  let canTakeOver = false
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
  /** 本机锁（M3-P5 设计 §3.1）：服务端批准之后直到离开编辑持有，和 lease 一起拿、一起放 */
  let lock: HeldLock | undefined
  /** 空闲释放的计时（编辑时才有） */
  let idle: IdleWatch | undefined
  /** 进行中的"在此编辑"的等待（请那边交出、等刷新之前的保存）：取消、卸载、又开始一次时撤销 */
  let takeoverAbort: AbortController | undefined
  /** 进入编辑时申请带回的上一位编辑者异常中断的提醒（M3-P5 设计 §3.5）：编辑、离开编辑的过程中显示，"知道了"、离开编辑、失去编辑权时去掉 */
  let interruption: EditInterruption | undefined
  /** 进入编辑的时刻（clock.now 的时间轴上）：空闲释放与自动交出都从它与最后一次操作中较晚的那个算起 */
  let editingSince = 0
  let generation = 0
  let session: 'active' | 'signed-out' | 'other-user' = 'active'
  let disposed = false
  const slot = createEditorSlot({ createEditor: options.createEditor, onChange: () => notify(), reportError: options.reportError })
  /** 测试构建的观察钩子（M3-P5 设计 §3.13）：没有时什么也不记；观察者出错不影响交接（上报） */
  const observer = options.trace
  const traced: HandoverTrace | undefined = observer === undefined
    ? undefined
    : (event) => {
        try {
          observer(event)
        }
        catch (error) {
          options.reportError(error)
        }
      }
  function trace(event: HandoverTraceEvent): void {
    traced?.(event)
  }
  /**
   * 持有者这一侧的请求编辑（M3-P5 设计 §3.6，holder-requests.ts）：在等的请求与说明放进编辑、离开编辑的状态；空闲满 2 分钟时经这里离开编辑
   * （handover-request，auto）
   */
  const holder = createHolderRequests({
    documentId,
    api: api.editLease,
    clock,
    visibility: options.visibility,
    lastActivity: options.lastActivity,
    editingSince: () => editingSince,
    editing: () => mode.kind === 'editing',
    writable: writableUnprompted,
    handOver: () => void leaveEditing('handover-request', true),
    onChange: syncEditing,
    onSessionProblem: hooks.writeProblem,
  })
  /** 请求方这一侧（M3-P5 设计 §3.6）：进展放进阅读的状态，结束的说明、进入编辑交给这里 */
  const requests = createEditRequests({
    documentId,
    api: api.editRequest,
    clock,
    visibility: options.visibility,
    lastActivity: options.lastActivity,
    onSessionProblem: hooks.writeProblem,
    onProgress: requestProgressed,
    enter: enterGranted,
    onEnd: requestEnded,
    issued: options.issuedRequest,
    trace: traced,
  })
  const checks = createReadingChecks<CheckedStatus>({
    clock,
    visibility: options.visibility,
    // 持有者是自己时同一次检查里看本机锁在不在本浏览器（M3-P5 设计 §3.7）：读屏状态区的说法随结果一次换好。记下发出时请求的进展的版本：
    // 回来时变过了就不按它恢复等待（M3-P5 设计 §3.6）
    fetch: async () => {
      const requestVersion = requests.version()
      const fetched = await api.editStatus(documentId)
      return { fetched, selfHolder: fetched.status.editor?.sameUser === true ? await locate() : undefined, requestVersion }
    },
    allowed: () => !disposed && mode.kind === 'reading' && session === 'active',
    onResult: applyCheck,
  })
  /**
   * 本浏览器里别的标签页的交接请求（M3-P5 设计 §3.7，tab-handover.ts）：只理会同一个人的、本页确实还持有本机锁时的；编辑时回了 ack 就经这里
   * 离开编辑（handover-tab）
   */
  const tabs = answerTabs({
    browser: options.sameBrowser,
    clientInstanceId: options.clientInstanceId,
    userId: options.userId,
    clock,
    holdsLock: () => lock !== undefined,
    phase: () => tabPhaseOf(mode),
    leave: () => void leaveEditing('handover-tab'),
    trace: traced,
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

  /** 编辑器建不起来：页面说明"编辑器加载失败"（可以重新加载）。请求编辑随之撤回（这一页进入不了编辑了） */
  function fail(error: unknown): void {
    begin({ kind: 'failed', error })
    requests.withdraw()
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
  function applyCheck(result: ReadingCheckResult<CheckedStatus>): void {
    if (mode.kind !== 'reading')
      return
    const reading = mode
    // 正在按新的版本重建时不动 update（重建完了以新的修订号为准，审查 A1）
    const loading = reading.update === 'loading'
    if (result.kind === 'status') {
      const { fetched: { status, serverTime }, selfHolder, requestVersion } = result.fetched
      const holder = status.editor === null ? undefined : leaseHolderOf(status.editor, serverTime)
      latestFlag = { revision: status.revision, formulasPending: status.formulasPending }
      canTakeOver = status.canTakeOver
      // 编辑状态里本人的请求（待回应的，或者已经交给了本人的保留）是谁发出的（M3-P5 审查 B2）：只在本页没有请求、检查发出之后请求的进展没变过
      // （例如刚取消）时认——本页有请求时就是它自己的
      const owner = requestVersion === requests.version() && requests.progress() === undefined
        ? requests.whose({ requestedAt: status.request?.mine === true ? status.request.requestedAt : undefined, reserved: status.reservation?.mine === true })
        : 'none'
      setMode({
        ...reading,
        // 只认本页显示的那一版的："有更新"时服务端的标记说的是更新的那一版
        formulasPending: status.revision === shown.revision ? status.formulasPending : reading.formulasPending,
        canEdit: status.canEdit,
        canTakeOver: status.canTakeOver,
        holder,
        selfHolder: holder?.sameUser === true ? selfHolder : undefined,
        // 上一位编辑者异常中断（M3-P5 设计 §3.5）：只说别人的那一代（见文件头）
        interruption: status.interruption !== null && !status.interruption.sameUser ? status.interruption : undefined,
        update: loading ? 'loading' : (status.revision > shown.revision ? 'available' : 'none'),
        gone: false,
        // 进入编辑、请求编辑时的"不能编辑了"在又能编辑之后不再成立；强制接管时的"不能了"在又能强制接管之后不再成立
        notice: ((reading.notice?.kind === 'denied' || reading.notice?.kind === 'request-denied') && status.canEdit) || (reading.notice?.kind === 'force-denied' && status.canTakeOver) ? undefined : reading.notice,
        // 持有者不再是自己：本页那一代已经不在了；那一代必然已经到期之后读到的自己也不是它（复验 C4）
        releaseUnconfirmed: reading.releaseUnconfirmed && holder?.sameUser === true && !unconfirmedExpired,
        // 本人在别的页面、设备上发出、正在等的请求（不是这一页发出的）：说一句，不恢复（审查 B2）
        requestedElsewhere: owner === 'elsewhere',
      })
      // 这一页发出过的请求而本页没在等（刷新之前发出、刷新时撤回没送到）：恢复等待（M3-P5 设计 §3.6）。"在此编辑"进行中、不能进入编辑的阅读不恢复
      if (owner === 'here' && status.canEdit && mode.kind === 'reading' && mode.takeover === undefined && mode.blocked === undefined && mode.damaged === undefined)
        requests.resume(status.editor?.holder)
    }
    else if (isNotFoundError(result.error)) {
      // 读不到了（删除、移走、失去访问）：说明，没有"编辑"与"有更新"；之后照常检查，恢复访问之后随之恢复
      setMode({ ...reading, gone: true, canEdit: false, holder: undefined, interruption: undefined, update: loading ? 'loading' : 'none' })
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

  /**
   * 申请编辑权（edit-lease.ts）。intent 另给接管方式与"被自己占着要不要再试"；不给后者时：被占用而且是自己、本机锁在本浏览器里没人持有，
   * 先再试几次（刷新时旧页面的释放晚到）；锁被本浏览器的标签页持有就不再试——那是一个还在编辑的标签页，页面换成"在此编辑"（M3-P5 设计 §3.7）
   */
  async function acquire(intent: AcquireIntent = {}): Promise<LeaseAcquisition> {
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
      onRequest: requestArrived,
    }, { retrySameUser: async () => !(await options.sameBrowser.heldHere()), ...intent })
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

  /** 编辑权没用上（进入编辑没有成功）：尽力释放，不等；放下本机锁 */
  function dropLease(): void {
    void lease?.release()
    lease = undefined
    dropLock()
  }

  // ---- 本机锁与空闲释放（M3-P5 设计 §3.1、§3.9） ----

  /** 放下本机锁（离开编辑：退出、空闲释放、失去编辑权、没能进入、卸载、页面关闭）：之后被抢不再算 */
  function dropLock(): void {
    const held = lock
    lock = undefined
    held?.release()
  }

  /**
   * 服务端批准之后拿本机锁（先服务端、后本机锁）：锁空着就拿；被本浏览器的别的标签页占着就抢——服务端批给了本页，那一页的租约必然已经
   * 失效（到期、释放），抢它只是让它立即得知。拿到时这一代已经不用了（期间失效、卸载）就随即放掉
   */
  async function holdLock(held: EditLease): Promise<void> {
    const taken = (await options.sameBrowser.tryHold()) ?? (await options.sameBrowser.steal())
    if (disposed || lease !== held) {
      taken.release()
      return
    }
    lock = taken
    void taken.stolen.then(() => lockStolen(taken))
  }

  /**
   * 本机锁被本浏览器的另一个标签页抢走（M3-P5 设计 §3.1 第 2 条、§3.7 第 4 步）：那边取得了服务端批准的新的一代，本页这一代必然已经失效——
   * 不再问服务端、不续上（abandon），直接按失效处理（taken-over、this-browser：编辑、退出编辑时转入失去编辑权，有没保存的修改照旧给副本与
   * 放弃；进入编辑的途中放弃进入）。已经放下的锁被抢不算
   */
  function lockStolen(taken: HeldLock): void {
    if (disposed || lock !== taken)
      return
    lock = undefined
    trace({ kind: 'lock-stolen', at: clock.now() })
    lease?.abandon()
    lost({ kind: 'taken-over', where: 'this-browser' })
  }

  /** 不由用户发起的写的门槛（空闲释放）：会话可写（confirmedForWrite 的口径，不主动向服务端确认）、联网 */
  function writableUnprompted(): boolean {
    return options.autosave.page.sessionWritable() && options.autosave.page.online()
  }

  /** 开始空闲释放的计时（进入编辑的那一刻起算） */
  function watchIdle(): void {
    idle?.dispose()
    idle = createIdleWatch({
      clock,
      visibility: options.visibility,
      lastActivity: options.lastActivity,
      since: editingSince,
      thresholdMs: IDLE_RELEASE_MS,
      onIdle: () => void releaseIdle(),
    })
  }

  function stopWatchingIdle(): void {
    idle?.dispose()
    idle = undefined
  }

  /**
   * 空闲满了 10 分钟（US-M3-07）：先保存再释放、回到阅读（leaveEditing('idle')）。会话不对、没联网时这一轮不释放（释放与保存都要它们；
   * 不主动向服务端确认会话），过一个心跳周期再看；一直不行由服务端 12 分钟兜底
   */
  async function releaseIdle(): Promise<void> {
    if (mode.kind !== 'editing')
      return
    if (!writableUnprompted()) {
      idle?.resume(IDLE_RECHECK_MS)
      return
    }
    await leaveEditing('idle')
  }

  // ---- 请求编辑：持有者这一侧（M3-P5 设计 §3.6，US-M3-06；holder-requests.ts） ----

  /** 编辑时的状态：在等回应的请求、编辑时的说明与异常中断的提醒 */
  function editingState(): EditModeState {
    return { kind: 'editing', request: holder.incoming(), notice: holder.notice(), interruption }
  }

  /** 请求或说明变了：编辑时随之更新（离开编辑的过程中不动：提示留着开始离开时的样子，留在编辑时再按现在的） */
  function syncEditing(): void {
    if (!disposed && mode.kind === 'editing')
      setMode(editingState())
  }

  /** 心跳带来的待回应的请求（没有时为 null）：这一代还在用时交给持有者这一侧（见 holder-requests.ts 的 arrive） */
  function requestArrived(request: PendingEditRequest | null): void {
    if (disposed || lease === undefined)
      return
    holder.arrive(request)
  }

  /**
   * 退出、空闲释放时要交出代替释放的请求：在等回应的那一个（正在谢绝的不算：人刚选了继续编辑）；交给本浏览器的另一个标签页时没有
   * （那边是同一个人，请求随新的一代沿用）
   */
  function offerOnLeaving(cause: LeaveCause): IncomingRequest | undefined {
    return cause === 'handover-tab' ? undefined : holder.offer()
  }

  // ---- 请求编辑：请求方这一侧（M3-P5 设计 §3.6，edit-request.ts） ----

  /** 请求的进展变了：阅读时随之更新（新的请求开始时之前的说明不再成立；本页有请求时不再说本人在别处请求了） */
  function requestProgressed(progress: EditRequestProgress | undefined): void {
    if (disposed || mode.kind !== 'reading' || mode.request === progress)
      return
    setMode({ ...mode, request: progress, notice: progress === undefined ? mode.notice : undefined, requestedElsewhere: progress === undefined && mode.requestedElsewhere })
  }

  /**
   * 编辑权交给了本页（或者空着），页面看得见、会话是本人：以普通申请进入编辑（与"编辑"同一个入口）。正在按新的版本重建、"在此编辑"进行中、
   * 编辑器在换时这一刻进不了（交回 false，重建完了 retry）；不能进入编辑的阅读（不能编辑了、读不到了、与服务端不兼容、数据不完整）请求随之作罢——
   * 尽力取消（清掉留给本页的保留，别人不必等它过期）
   */
  function enterGranted(): boolean {
    if (disposed || mode.kind !== 'reading' || session !== 'active' || mode.update === 'loading' || mode.takeover !== undefined || slot.editor() === undefined)
      return false
    if (!mode.canEdit || mode.gone || mode.blocked !== undefined || mode.damaged !== undefined) {
      void api.editRequest.cancel(documentId).catch(() => undefined)
      setMode({ ...mode, request: undefined })
      return true
    }
    readingBefore = { ...mode, update: mode.update, notice: undefined, request: undefined }
    void acquireAndEnter('granted', {})
    return true
  }

  /** 请求结束了（不是进入编辑）：阅读里说明为什么；正在编辑的是自己时改走"在此编辑" */
  function requestEnded(end: EditRequestEnd): void {
    if (disposed || mode.kind !== 'reading')
      return
    const reading: ReadingMode = { ...mode, request: undefined }
    switch (end.kind) {
      case 'cancelled':
        setMode(reading)
        return
      case 'self':
        setMode({ ...reading, notice: undefined })
        void startTakeover()
        return
      case 'failed':
        setMode(readingAfterRequestFailure(reading, end.error))
        return
      case 'declined':
        setMode({ ...reading, notice: { kind: 'request-declined', holder: end.holder } })
        return
      case 'occupied':
        setMode({ ...reading, notice: { kind: 'request-occupied', requester: end.requester } })
        return
      case 'reserved-for-other':
        setMode({ ...reading, holder: undefined, notice: { kind: 'reserved', reservedFor: end.reservedFor, reservedUntil: end.reservedUntil } })
        return
      case 'gone':
        setMode({ ...reading, notice: { kind: 'request-gone' } })
        return
      case 'idle':
        setMode({ ...reading, notice: { kind: 'request-idle' } })
    }
  }

  /** 没能请求编辑（发出失败，续期得到 403、404）：与申请编辑权的失败同一个口径（不兼容、不能编辑了、读不到了、会话的问题与别的失败） */
  function readingAfterRequestFailure(reading: ReadingMode, error: unknown): ReadingMode {
    const blocked = incompatibilityOf(error)
    if (blocked !== undefined)
      return { ...reading, blocked, notice: undefined }
    if (isPermissionDeniedError(error))
      return { ...reading, canEdit: false, notice: { kind: 'request-denied', error } }
    if (isNotFoundError(error))
      return { ...reading, gone: true, canEdit: false, holder: undefined, notice: undefined }
    if (isAuthenticationError(error) || isCsrfTokenError(error))
      hooks.writeProblem(error)
    return { ...reading, notice: { kind: 'request-failed', error } }
  }

  /**
   * 离开编辑（M3-P5 设计 §3.1 第 3 条、§3.10）：begin(exiting) 的那一刻页面挂上交互屏障（先挡住输入）→ 挂起自动保存的调度（定时的捕获与上传、
   * 切到后台的上传，M3-P4 设计 §3.4）→ 等面板 → 有没存的就立即上传一次（flush：提交单元格、等公式；内容与确认过的相同时不发）→ 等在途 →
   * 看存上了没有 → 捕获 → 释放（≤ EXIT_RELEASE_WAIT_MS）→ 放锁 → 告诉等着接手的标签页（done）→ 以只读重建 → 阅读。
   * - exit："退出编辑"（会话由页面先确认）：没有全部存上（保存失败、版本冲突、提交不了正在编辑的单元格、公式结果还没收齐）就留在编辑；
   * - idle（空闲释放）与 handover-tab（交给本浏览器的另一个标签页，M3-P5 设计 §3.7）不是人按的：flush 时不主动向服务端确认会话（ready 用
   *   writableUnprompted）；修改都存上了就离开，公式没收齐也离开（带"公式待更新"，下一个进入编辑的人强制重算，M3-P4 设计 §3.4）；没存上
   *   （含轮到时会话变差、没有发的 skipped(session)）就留在编辑。离开开始的那一刻就停止续上（holdRecovery），没离开成时恢复。
   *   空闲释放留在编辑之后过一个心跳周期再看——再也存不上的（版本冲突、与服务端不兼容）不再试，服务端 12 分钟兜底；阅读里说明
   *   "10 分钟没有操作，已保存并释放编辑权"。交出给标签页的没存上就告诉它（failed，原因）；存上了不释放、只放弃这一代（那边以本人接管换代，
   *   审查 B4），说明"已交给本浏览器的另一个标签页"。
   * - handover-request（交给请求编辑的人，M3-P5 设计 §3.6；auto 是空闲满 2 分钟自动交出的）同样不是人按的"退出编辑"：存上了就交出开始时在等的
   *   那个请求（代替释放），交出了就停止续租（服务端已经结束这一代）、阅读里说明交给了谁；请求已经不在（请求方取消了）就留在编辑、说明一句；
   *   交不出（没有结果）就留在编辑、提示里说明原因，请求照旧在；这一代已经因为别的原因失效时按失去编辑权（本页的修改都已存上）。
   * 退出、空闲释放时有待回应的请求：同样用交出代替释放，交不出就照常释放（交给本浏览器的另一个标签页时不交给请求方：那边是同一个人，请求随新的一代沿用）。
   * 留在编辑：恢复调度（立即再看），说明由保存的状态给出；期间回应过 ack 的交接请求一律告诉它们没能交出（failed）；请求还在等的，自动交出没成的
   * 过一个心跳周期再看（再也存不上的不再试），别的照截止时刻
   */
  async function leaveEditing(cause: LeaveCause, auto = false): Promise<void> {
    const saver = coordinator
    const scheduler = autosave
    const held = lease
    const page = slot.editor()
    if (mode.kind !== 'editing' || saver === undefined || scheduler === undefined || held === undefined || page === undefined)
      return
    // 交给请求编辑的人：交给开始时在等的那一个（中途换了请求方的，交出时得到"已不在"，留在编辑、换上新的提示）
    const handingTo = cause === 'handover-request' ? holder.incoming() : undefined
    if (cause === 'handover-request' && (handingTo === undefined || handingTo.declining))
      return
    const token = begin({ kind: 'exiting', cause, request: holder.incoming(), interruption })
    trace({ kind: 'leave', at: clock.now(), cause })
    const idleRelease = cause === 'idle'
    // 不是人按的"退出编辑"：不主动确认会话、公式没收齐也离开、离开期间不续上
    const unattended = cause !== 'exit'
    idle?.stop()
    holder.leaving()
    if (unattended)
      held.holdRecovery()
    scheduler.suspend()
    const stay = (reason: HandoverFailure): void => {
      scheduler.resume()
      if (unattended)
        held.allowRecovery()
      begin(editingState())
      trace({ kind: 'left', at: clock.now(), cause, outcome: 'stayed' })
      tabs.finish({ kind: 'failed', reason })
      const ended = saveEnded(saver.view().status)
      if (!idleRelease)
        idle?.resume()
      else if (!ended)
        idle?.resume(IDLE_RECHECK_MS)
      holder.stayed({ automatic: cause === 'handover-request' && auto, ended })
    }
    // 面板里防抖中的改动先写进模型（批注浮层、数据验证面板，M3-P4 设计 §3.4）：之前没有别的修改时，它们是"有没有没存的"的全部
    await page.settlePanels()
    if (!still(token))
      return
    let flushed: FlushResult | undefined
    if (saver.hasUnsavedWork()) {
      flushed = await (unattended ? scheduler.flush(idleRelease ? 'idle-release' : 'handover', { ready: async () => writableUnprompted() }) : scheduler.flush('exit'))
      if (!still(token))
        return
    }
    await saver.settled()
    if (!still(token))
      return
    if (unattended ? !storedForRelease(saver, flushed) : saver.hasUnsavedWork()) {
      stay(handoverFailureOf(saver.view().status, flushed, options.autosave.page.sessionWritable()))
      return
    }
    let snapshot: string
    try {
      snapshot = page.capture()
    }
    catch (error) {
      options.reportError(error)
      if (still(token))
        stay('not-saved')
      return
    }
    // 交出或释放（共用 EXIT_RELEASE_WAIT_MS 的时限）：交给请求编辑的人；退出、空闲释放时有待回应的请求也交出（M3-P5 设计 §3.6）；
    // 交给本浏览器的另一个标签页时不释放（见下）；别的释放——等它的结果，结果未知、到了时限也照样离开（那一代至多 90 秒内自行到期）。
    // 之后放下本机锁
    const until = clock.now() + EXIT_RELEASE_WAIT_MS
    const offer = handingTo ?? offerOnLeaving(cause)
    const outcome = offer === undefined ? undefined : await holder.handOver(held, offer, until)
    if (!still(token))
      return
    let handedTo: UserSummary | undefined
    let released = true
    if (outcome?.kind === 'handed' || outcome?.kind === 'lost') {
      // 交出了，或者这一代已经因为别的原因失效：服务端不再认这一代，停止续租、不再释放
      held.abandon()
      if (outcome.kind === 'lost' && handingTo !== undefined) {
        void lose(outcome.loss)
        return
      }
      handedTo = outcome.kind === 'handed' ? offer?.requester : undefined
    }
    else if (handingTo !== undefined && outcome !== undefined) {
      // 没交出：请求已经不在（请求方取消了），或者没有结果（提示里说明原因）——留在编辑，请求照旧在。修改都已存上：期间回应过 ack 的标签页
      // 得到的原因是没交出去，不是没存上（审查 B11）
      if (outcome.kind === 'gone')
        holder.withdrawn(handingTo)
      else
        holder.failed(handingTo, outcome.error)
      stay('not-handed-over')
      return
    }
    else if (cause === 'handover-tab') {
      // 交给本浏览器的另一个标签页（审查 B4）：不释放，只放弃这一代（停心跳、不发释放）——那边等锁空了（或收到 done）以本人接管申请，服务端在
      // 同一个事务里换代，这一代与新的一代之间槽从来不空：等待中的请求方抢不进"先释放、再申请"之间，请求随新的一代沿用（同一个人）。代价：那边
      // 没跟上（随即被关掉、崩溃）时这一代至多一个有效期（90 秒）后到期，别人看到"异常中断"的提醒
      held.abandon()
    }
    else {
      released = await releaseWithin(held, until)
      if (!still(token))
        return
    }
    lease = undefined
    dropLock()
    // 等着接手的标签页以锁空了为信号（tab-handover.ts、self-takeover.ts），done 是给没有锁可等时的；它随即以本人接管申请
    tabs.finish({ kind: 'done' })
    stopWatchingIdle()
    holder.clear()
    interruption = undefined
    // 没能确认放掉：那一代可能还在（审查 A13）。交给本浏览器的另一个标签页时本来就不释放（released 照旧为真）：那个标签页随即以本人接管结束它，
    // 之后读到的"自己在编辑"就是它，不说成本页刚退出
    const unconfirmed = !released
    watchUnconfirmedRelease(!unconfirmed)
    const revision = saver.baseRevision()
    // 与服务端不兼容之后（M3-P3）离开：之后的阅读照样不给"编辑"、照样说明
    const blocked = blockedBy(saver.view().status)
    // 空闲释放、交出可以带着"公式待更新"离开：这一版的标记就是本页最后一次存上的（服务端记在文档上）
    const formulasLeft = unattended && saver.view().formulasPending
    const created = await slot.replace('read', snapshot)
    if (!still(token))
      return
    // 保存的状态机留到换好编辑器才去掉：离开的整个过程页头的"保存""正在退出编辑…"都在（审查 A2），这时它说的是已保存
    disposeCoordinator()
    if (created === undefined) {
      fail(new Error(`${LEAVE_LABELS[cause]}时以只读重建编辑器失败`))
      return
    }
    // 退出时都已存上（含公式的结果）：这一版不带"公式待更新"——补存的内容与上一版相同时修订号不变（服务端只清标记），
    // 之前记下的这一版的标记随之作废。空闲释放、交出按本页最后一次存上的
    latestFlag = { revision, formulasPending: formulasLeft }
    // 刚存下的内容自己读不回来（打开自检失败）：照样以 damaged 阅读、上报
    const damaged = openCheckOf(created, { access: 'read', trigger: 'exit', revision })
    // 交给了请求编辑的人：说明交给了谁（空闲满 2 分钟自动交出的、空闲释放时用交出代替释放的另说没有操作）
    const notice: ReadingNotice | undefined = handedTo === undefined ? LEAVE_NOTICES[cause] : { kind: 'handed-over', to: handedTo, auto: auto || idleRelease }
    enterReading(created, { snapshot, revision }, { kind: 'reading', canEdit: true, holder: undefined, selfHolder: undefined, takeover: undefined, request: undefined, requestedElsewhere: false, canTakeOver, interruption: undefined, update: 'none', gone: false, notice, releaseUnconfirmed: unconfirmed, blocked, formulasPending: formulasPendingOf(revision), damaged })
    trace({ kind: 'left', at: clock.now(), cause, outcome: 'reading' })
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

  /** 释放手里的编辑权，至多等到 until（离开编辑时的 EXIT_RELEASE_WAIT_MS）：服务端确认了为 true，结果未知、到了时限为 false（照样往下走） */
  async function releaseWithin(held: EditLease, until: number): Promise<boolean> {
    return within(clock, held.release(), until, false)
  }

  /**
   * 编辑权失效（续租或保存得知，续上没有成功）。编辑、退出编辑时转入失去编辑权；进入编辑还在申请、取内容（只读的编辑器还在）时
   * 放弃进入、留在阅读；正在新建可编辑的编辑器时等它建好、进入编辑之后再处理（与 P1 一样：建好之后随即停住）
   */
  function lost(loss: LeaseLoss): void {
    if (disposed)
      return
    if (mode.kind === 'editing' || mode.kind === 'exiting') {
      // 已经交出（交出的回答没收到、下一次心跳或保存才得知，M3-P5 设计 §3.6）：交给的就是还在等的那个请求
      const incoming = holder.incoming()
      void lose(loss.kind === 'handed-over' && loss.to === undefined && incoming !== undefined ? { kind: 'handed-over', to: incoming.requester } : loss)
    }
    else if (mode.kind === 'entering' && slot.editor() !== undefined) {
      lease = undefined
      dropLock()
      begin({ ...readingBefore, notice: { kind: 'enter-lost', loss } })
    }
    else if (mode.kind === 'entering' || mode.kind === 'opening') {
      pendingLoss = loss
    }
  }

  /**
   * 申请编辑权、取内容的请求失败时阅读里的说明：不能编辑了、读不到了、与服务端不兼容（M3-P3）、编辑权刚交给了别人（保留期内，M3-P5）、
   * 会话的问题与别的失败。forced：这一次是强制接管（M3-P5 设计 §3.8）——403 是不能强制接管了（不再给"强制接管"；能不能编辑由随后的检查更新：
   * 服务端先判断能编辑、再判断能强制接管，两种 403 分不出来），别的失败说没能强制接管
   */
  function readingAfterFailure(error: unknown, forced = false): SettledReading {
    const blocked = incompatibilityOf(error)
    if (blocked !== undefined)
      return { ...readingBefore, blocked, notice: undefined }
    if (isPermissionDeniedError(error)) {
      if (!forced)
        return { ...readingBefore, canEdit: false, notice: { kind: 'denied', error } }
      canTakeOver = false
      return { ...readingBefore, canTakeOver: false, notice: { kind: 'force-denied', error } }
    }
    if (isNotFoundError(error))
      return { ...readingBefore, gone: true, canEdit: false, holder: undefined, interruption: undefined, update: 'none', notice: undefined }
    // 编辑权刚交给了别人、还在保留期内（M3-P5 设计 §3.6）：说明交给了谁、留到何时（没人占着）
    const reserved = reservedNoticeOf(error, forced)
    if (reserved !== undefined)
      return { ...readingBefore, holder: undefined, selfHolder: undefined, notice: reserved }
    if (isAuthenticationError(error) || isCsrfTokenError(error))
      hooks.writeProblem(error)
    return { ...readingBefore, notice: forced ? { kind: 'force-failed', error } : { kind: 'enter-failed', error } }
  }

  /**
   * 没能以可编辑的编辑器进入（以编辑方式重建失败，或者新建的编辑器打开自检失败，M3-P4 设计 §3.12）：编辑权没用上——释放它；以只读重建
   * 选定的那一份内容、回到阅读（reading 按只读的编辑器的打开自检给出阅读的样子）。期间续租得知的与服务端不兼容随之带进阅读。
   * 只读的也建不起来就是 failed
   */
  async function backToReading(token: number, content: ShownContent, reading: (damaged: OpenCheckFailures | undefined) => ReadingMode): Promise<'not-entered'> {
    pendingLoss = undefined
    interruption = undefined
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
  async function startEditing(token: number, held: EditLease, acquired: { readonly revision: number, readonly formulasPending: boolean, readonly interruption: EditInterruption | undefined }): Promise<'entered' | 'not-entered' | { readonly error: unknown }> {
    const { revision, formulasPending } = acquired
    lease = held
    editingBase = revision
    // 新的一代：之前的请求、说明不再算（之后的心跳带来的才算）；异常中断的提醒是这一次申请带回的（用户发起的申请才经这里，续上不经过）
    holder.reset()
    interruption = acquired.interruption
    // 申请的回答是服务端最近一次说的这一版的"公式待更新"：没能进入、回到阅读时按它说明
    latestFlag = { revision, formulasPending }
    if (session !== 'active')
      held.pause()
    // 先服务端、后本机锁（M3-P5 设计 §3.1）：被本浏览器的别的标签页占着就抢，那边随即转为失去编辑权
    await holdLock(held)
    if (!still(token))
      return 'not-entered'
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
    // 空闲从进入编辑的这一刻（与之后的最后一次操作中较晚的那个）算起（M3-P5 设计 §3.9）；自动交出也是（§3.6）
    editingSince = clock.now()
    setMode(editingState())
    trace({ kind: 'entered', at: clock.now() })
    watchIdle()
    syncSaving()
    const loss = pendingLoss
    pendingLoss = undefined
    if (loss !== undefined)
      void lose(loss)
    // 进入编辑的过程中心跳就带来了请求：现在按编辑时的规则处理
    else
      holder.entered()
    return 'entered'
  }

  /**
   * ?edit=new 的打开：直接申请、以可编辑创建。进入了、编辑器建不起来、载入失败、页面卸载时交回打开的结果；
   * 没有进入、要照常以只读打开时交回 undefined（readingBefore 已经带上原因）
   */
  async function enterOnOpen(token: number): Promise<OpenOutcome | undefined> {
    let acquisition: LeaseAcquisition
    trace({ kind: 'acquire', at: clock.now(), trigger: 'open', takeover: null })
    try {
      acquisition = await acquire()
    }
    catch (error) {
      trace({ kind: 'acquire-result', at: clock.now(), result: 'failed', interruption: false, code: codeOf(error) })
      return still(token) ? notEnteredOnOpen(error) : { kind: 'opened', entered: false, damaged: false }
    }
    traceAcquired(acquisition)
    if (!still(token)) {
      if (acquisition.kind === 'acquired')
        void acquisition.lease.release()
      return { kind: 'opened', entered: false, damaged: false }
    }
    if (acquisition.kind === 'held') {
      const selfHolder = await selfHolderOf(acquisition.holder)
      if (!still(token))
        return { kind: 'opened', entered: false, damaged: false }
      readingBefore = { ...readingBefore, holder: acquisition.holder, selfHolder }
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

  // ---- 本人接管（M3-P5 设计 §3.7，US-M3-08） ----

  /** 本机锁在本浏览器里有没有人持有：持有者是自己时，那个页面在本浏览器的另一个标签页还是在别处 */
  async function locate(): Promise<SelfHolder> {
    return (await options.sameBrowser.heldHere()) ? 'this-browser' : 'elsewhere'
  }

  /** 持有者是自己时那个页面在哪里；持有者不是自己、不知道是谁时为 undefined */
  async function selfHolderOf(holder: LeaseHolder | undefined): Promise<SelfHolder | undefined> {
    return holder?.sameUser === true ? locate() : undefined
  }

  /** "在此编辑"有了新的进展（这一次接手还在、还在阅读时） */
  function setTakeover(token: number, takeover: TakeoverProgress): void {
    if (still(token) && mode.kind === 'reading')
      setMode({ ...mode, takeover })
  }

  /** 申请的结果报给观察钩子（取得了、被占用；失败另报） */
  function traceAcquired(acquisition: LeaseAcquisition): void {
    trace({ kind: 'acquire-result', at: clock.now(), result: acquisition.kind, interruption: acquisition.kind === 'acquired' && acquisition.interruption !== undefined, code: null })
  }

  /**
   * 申请并进入编辑（"编辑""在此编辑""强制接管"与请求被批准之后的自动进入共用，trigger 是哪一个；调用方先记下 readingBefore）：开始进入（页面挂上
   * 交互屏障；强制接管时进入的状态带 forced）→ 申请 → 取得了就拿锁、以可编辑重建；被占用回到阅读（持有者是自己时看那个页面在不在本浏览器）；
   * 请求失败按原因回到阅读（强制接管另有说法）。交回进入了没有
   */
  async function acquireAndEnter(trigger: AcquireTrigger, intent: AcquireIntent): Promise<boolean> {
    const forced = intent.takeover === 'force'
    const token = begin(forced ? { kind: 'entering', forced } : { kind: 'entering' })
    let acquisition: LeaseAcquisition
    trace({ kind: 'acquire', at: clock.now(), trigger, takeover: intent.takeover ?? null })
    try {
      acquisition = await acquire(intent)
    }
    catch (error) {
      trace({ kind: 'acquire-result', at: clock.now(), result: 'failed', interruption: false, code: codeOf(error) })
      if (still(token))
        begin(readingAfterFailure(error, forced))
      return false
    }
    traceAcquired(acquisition)
    if (!still(token)) {
      if (acquisition.kind === 'acquired')
        void acquisition.lease.release()
      return false
    }
    if (acquisition.kind === 'held') {
      // 被占用：占着的不是本页（本页那一代还在时同一个 clientInstanceId 照样取得）。有人在编辑，之前读到的异常中断的提醒不再成立
      const selfHolder = await selfHolderOf(acquisition.holder)
      if (still(token))
        begin({ ...readingBefore, holder: acquisition.holder, selfHolder, interruption: undefined, releaseUnconfirmed: false })
      return false
    }
    const started = await startEditing(token, acquisition.lease, acquisition)
    if (typeof started === 'object' && still(token))
      begin(readingAfterFailure(started.error, forced))
    return started === 'entered'
  }

  /**
   * "在此编辑"（见文件头）：阅读、能编辑、没有在按新的版本重建、没有请求编辑时；接手进行中不再开始一次，那边没能交出（failed）时再按就是"仍在此编辑"
   * （anyway：本人接管、拿锁时抢，不再请它交出）。这里开始这一件事（阅读里带上进展、作废之前的），编排交给 tab-handover.ts 的 takeOverHere
   */
  async function startTakeover(): Promise<void> {
    if (mode.kind !== 'reading' || !mode.canEdit || mode.gone || mode.blocked !== undefined || mode.damaged !== undefined || mode.update === 'loading' || mode.request !== undefined || slot.editor() === undefined || disposed)
      return
    const anyway = mode.takeover?.kind === 'failed'
    if (mode.takeover !== undefined && !anyway)
      return
    readingBefore = { ...mode, update: mode.update, notice: undefined, takeover: undefined }
    takeoverAbort?.abort()
    const abort = new AbortController()
    takeoverAbort = abort
    const token = begin({ ...readingBefore, takeover: { kind: 'preparing' } })
    try {
      await takeOverHere({
        browser: options.sameBrowser,
        clock,
        documentId,
        clientInstanceId: options.clientInstanceId,
        userId: options.userId,
        newId: options.newId,
        pendingSave: options.pendingSave,
        wallNow: () => options.now().getTime(),
        revision: async () => (await api.editStatus(documentId)).status.revision,
        anyway,
        signal: abort.signal,
        still: () => still(token),
        progress: progress => setTakeover(token, progress),
        // 接手（本人接管）：这一次已经作废、不在阅读时不申请；接手期间的检查可能更新过阅读的样子（持有者、能不能编辑），没能进入时回到现在的
        enter: async () => {
          if (!still(token) || mode.kind !== 'reading')
            return false
          if (mode.update !== 'loading')
            readingBefore = { ...mode, update: mode.update, notice: undefined, takeover: undefined }
          return acquireAndEnter('take-over', { takeover: 'self' })
        },
        trace: traced,
      })
    }
    finally {
      // 结束（进入了、没进入、取消、卸载）：撤下这一次还挂着的等待
      abort.abort()
      if (takeoverAbort === abort)
        takeoverAbort = undefined
    }
  }

  // ---- 失去编辑权 ----

  /**
   * 失去编辑权（§3.4）：停止保存 → 提交正在编辑的单元格、捕获 → 等在途的保存 → 算出有没有没保存的（销毁可编辑的编辑器之前）→
   * 重建为只读、显示本页的内容（失败时留在这里，说明编辑器没能重新打开）→ 说明，按需核对结果未知的保存
   */
  async function lose(loss: LeaseLoss): Promise<void> {
    const token = begin({ kind: 'losing', loss })
    lease = undefined
    dropLock()
    // 离开编辑的途中失去编辑权：等着接手的标签页以锁空了为信号（刚放下），不再另外告诉它们
    tabs.forget()
    stopWatchingIdle()
    // 请求编辑的提示随之消失（这一代不在了，交不出了）；异常中断的提醒同样消失
    holder.clear()
    interruption = undefined
    // 强制接管（M3-P5 设计 §3.8）：接管的人从编辑状态读（这时那边已经取得了新的一代），与捕获、重建同时进行；失去编辑权的说明出来之前读到了就
    // 一起出来，之后才读到就随即补上（说明还是这一次失去编辑权的）
    let shownLoss = loss
    if (loss.kind === 'forced' && loss.by === undefined) {
      void forcedBy().then((by) => {
        if (by === undefined || disposed)
          return
        shownLoss = { kind: 'forced', by }
        if (mode.kind === 'lost' && mode.loss === loss)
          setMode({ ...mode, loss: shownLoss })
      })
    }
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
      begin({ ...lostMode, loss: shownLoss, unsaved: saver?.hasUnsavedWork() ?? false, captureFailed: true })
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
    const checkToken = begin({ ...lostMode, loss: shownLoss, unsaved, checking: checkFirst, reopenFailed: created === undefined })
    if (!checkFirst || saver === undefined)
      return
    await saver.replayUnknownOutcome()
    if (still(checkToken) && mode.kind === 'lost')
      setMode({ ...mode, checking: false, unsaved: mode.inputLeft || saver.hasUnsavedWork() })
  }

  /** 强制接管的人（M3-P5 设计 §3.8）：读一次编辑状态，正在编辑的是别人就是他；读不到、没人在编辑、是自己时为 undefined。从不失败 */
  async function forcedBy(): Promise<UserSummary | undefined> {
    try {
      const { status } = await api.editStatus(documentId)
      return status.editor === null || status.editor.sameUser ? undefined : status.editor.holder
    }
    catch {
      return undefined
    }
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
    const reading = readingAfter(from.loss, copied === undefined ? undefined : { kind: 'copied', document: copied }, canTakeOver)
    // 续上时被自己占着（另一个标签页或设备）：那个页面在不在本浏览器，与阅读时的检查同一个判断（随后的检查照样更新）
    const selfHolder = await selfHolderOf(reading.holder)
    if (!still(token))
      return
    enterReading(created, content, { ...reading, selfHolder, formulasPending: formulasPendingOf(content.revision), damaged })
  }

  /** "有更新，点击刷新"：按条件读取取最新的内容，重建为阅读（保留视图） */
  async function refreshUpdate(): Promise<void> {
    // "在此编辑"进行中不刷新：开始新的一件事会让接手的那一次作废，进展却留在阅读里（等人选"仍在此编辑"或"取消"时可以）
    if (mode.kind !== 'reading' || mode.update !== 'available' || (mode.takeover !== undefined && mode.takeover.kind !== 'failed') || disposed)
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
      canTakeOver = initial.canTakeOver === true
      readingBefore = { kind: 'reading', canEdit: initial.canEdit, holder: undefined, selfHolder: undefined, takeover: undefined, request: undefined, requestedElsewhere: false, canTakeOver, interruption: undefined, update: 'none', gone: false, notice: undefined, releaseUnconfirmed: false, blocked, formulasPending, damaged: undefined }
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
      // 阅读时一定有接上的编辑器，没有就是还在换。打开自检失败的阅读不进入（M3-P4 设计 §3.12）；"在此编辑"进行中（或者等人选）、请求编辑进行中
      // 时不进入（M3-P5）
      if (mode.kind !== 'reading' || !mode.canEdit || mode.gone || mode.blocked !== undefined || mode.damaged !== undefined || mode.update === 'loading' || mode.takeover !== undefined || mode.request !== undefined || slot.editor() === undefined || disposed)
        return
      readingBefore = { ...mode, update: mode.update, notice: undefined }
      // 被自己占着、本机锁在本浏览器里有人持有时不再试，随即换成"在此编辑"（M3-P5 设计 §3.7）
      await acquireAndEnter('enter', {})
    },

    // 与"编辑"同样的前提；接手进行中时不再开始一次，那边没能交出（failed）时再按就是"仍在此编辑"；请求编辑进行中不开始（互斥）
    takeOver: startTakeover,

    requestEdit: async () => {
      // 与"编辑"同样的前提；"在此编辑"进行中、已经有请求时不再发出
      if (mode.kind !== 'reading' || !mode.canEdit || mode.gone || mode.blocked !== undefined || mode.damaged !== undefined || mode.update === 'loading' || mode.takeover !== undefined || mode.request !== undefined || slot.editor() === undefined || disposed)
        return
      await requests.send()
    },

    cancelRequest: async () => {
      if (mode.kind === 'reading' && !disposed)
        await requests.cancel()
    },

    handOver: async () => {
      if (mode.kind === 'editing' && holder.offer() !== undefined)
        await leaveEditing('handover-request')
    },

    decline: async () => {
      const held = lease
      if (mode.kind === 'editing' && held !== undefined)
        await holder.decline(held)
    },

    cancelTakeOver: () => {
      if (mode.kind !== 'reading' || mode.takeover === undefined || disposed)
        return
      takeoverAbort?.abort()
      takeoverAbort = undefined
      begin({ ...mode, takeover: undefined })
    },

    forceTakeOver: async () => {
      // 与"编辑"同样的前提，另要能强制接管；与请求编辑、"在此编辑"互斥；正在编辑的是自己时走"在此编辑"（同一个浏览器里先请那边交出），这里不做
      if (mode.kind !== 'reading' || !mode.canEdit || !mode.canTakeOver || mode.gone || mode.blocked !== undefined || mode.damaged !== undefined || mode.update === 'loading'
        || mode.takeover !== undefined || mode.request !== undefined || mode.holder?.sameUser === true || slot.editor() === undefined || disposed) {
        return
      }
      readingBefore = { ...mode, update: mode.update, notice: undefined }
      await acquireAndEnter('force', { takeover: 'force' })
    },

    dismissInterruption: () => {
      if (interruption === undefined || disposed)
        return
      interruption = undefined
      if (mode.kind === 'editing')
        setMode(editingState())
      else if (mode.kind === 'exiting')
        setMode({ ...mode, interruption: undefined })
    },

    exit: async () => leaveEditing('exit'),

    save: async (ready) => {
      if (mode.kind !== 'editing' || autosave === undefined)
        return
      // 等会话确认的期间开始了退出、失去了编辑权：不再上传（退出自己存；失去编辑权时调度已经去掉）
      const stillEditing = (): boolean => mode.kind === 'editing'
      await autosave.flush('save-button', { ready: async () => (ready === undefined || await ready()) && stillEditing() })
    },

    refresh: async () => {
      await refreshUpdate()
      // 重建期间请求编辑得到了"交给本页"（M3-P5）：这时才进入
      requests.retry()
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
        // 请求方这一侧：会话不是本人时不续期（M3-P5）
        requests.setActive(false)
        lease?.pause()
        checks.stop()
        return
      }
      if (previous !== 'active') {
        // 请求方这一侧：真的从不是本人回到本人时立即续期一次（M3-P5）。页面确认会话照常是本人（一直是本人：续期得到会话类失败之后的确认）时
        // 不让它立即续期——服务端一直拒绝时那只会再被拒、再要确认一次，续期照它自己的节奏（审查 B1，edit-request.ts）
        requests.setActive(true)
        // 从未登录或换了人回到本人：之前"登录已过期""请求已失效"这类保存失败的说明不再成立（复验 RB2）
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
        setMode({ ...mode, canEdit, notice: (mode.notice?.kind === 'denied' || mode.notice?.kind === 'request-denied') && canEdit ? undefined : mode.notice })
    },

    noteActivity: () => lease?.noteActivity(),

    releaseOnHide: () => {
      // 离开页面一律放下本机锁（M3-P5 设计 §3.1）：进往返缓存时浏览器不替页面放（编辑器页恢复时反正整页重新加载）
      dropLock()
      // 本页在请求编辑：尽力取消（keepalive），免得持有者把编辑权交给一个已经关掉的页面（M3-P5 设计 §3.6）
      requests.withdraw()
      // 保存在途或者结果未知：不释放（M3-P4 设计 §3.4），记下这份文档有一次保存可能还在服务端处理，它的基准是本页确认过的最新修订
      // （M3-P5 设计 §3.7 的 R1）。结果未知也算：WebKit 在导航（刷新、离开）一开始就取消在途的请求、之后才派发 pagehide——那时它已经不在途，
      // 而那次保存可能已经送到服务端、还在处理，释放先提交就把它挡掉（S6 实测，S8 真实 Safari 复核确认）。有请求在等时同样不交出
      // （交出同样会挡掉那次保存）。测试构建的观察钩子记下走了哪一支与那一刻保存的样子（page-hide）
      const busy = coordinator?.busy() === true
      const unknown = coordinator?.hasUnknownOutcome() === true
      if (coordinator !== undefined && (busy || unknown)) {
        options.pendingSave.write(coordinator.baseRevision())
        trace({ kind: 'page-hide', at: clock.now(), action: 'kept', busy, unknown })
        return
      }
      // 有待回应的请求编辑：用交出代替释放（keepalive，不看结果；服务端随之结束这一代、留给请求方），这一代随即停止续租
      const held = lease
      const offer = holder.offer()
      if (held !== undefined && offer !== undefined) {
        const { token } = held.credentials()
        held.abandon()
        void api.editLease.handOver(documentId, token, offer.id).catch(() => undefined)
        trace({ kind: 'page-hide', at: clock.now(), action: 'handed-over', busy, unknown })
        return
      }
      trace({ kind: 'page-hide', at: clock.now(), action: held === undefined ? 'idle' : 'released', busy, unknown })
      void held?.release()
    },

    dispose: () => {
      if (disposed)
        return
      disposed = true
      generation += 1
      checks.dispose()
      tabs.dispose()
      takeoverAbort?.abort()
      takeoverAbort = undefined
      cancelUnconfirmedExpiry?.()
      cancelUnconfirmedExpiry = undefined
      stopWatchingIdle()
      holder.dispose()
      requests.dispose()
      void lease?.release()
      lease = undefined
      dropLock()
      disposeCoordinator()
      listeners.clear()
      slot.clear()
    },
  }
}
