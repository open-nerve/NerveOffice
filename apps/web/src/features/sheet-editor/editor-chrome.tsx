// 编辑器页的页头与提示（P4 设计 §3.7.3；M3-P2 设计 §3.4 的表）：返回文档所在的空间（M2-P2 设计 §3.10；只凭授权时回"与我共享"，M2-P5）、
// 标题、分享的入口（M2-P5）、页头的状态（role="status"）与这一刻能做的事：
// - 阅读：只能查看；能编辑时"编辑"；有人在编辑时说明是谁（能不能编辑都说，是自己时说在另一个标签页或设备上）；"有更新，点击刷新"；
// - 进入编辑中、退出编辑中：说明正在做，按钮留着（标为不可用、说正在进入或退出），没有成功时焦点还在它上面；
// - 编辑：保存状态、"保存"、"退出编辑"，保存的各种结果；
// - 失去编辑权：原因；还读得到而且有修改时"另存为副本""放弃本页的修改"（确认），没有修改时"重新加载"，读不到了时只说明。
// 页头的文档详情没能刷新时说明、可以重试（DEF-040，与列表的"没能刷新"同一个做法）。
// M3-P3（设计 §3.10）：本页与服务端不兼容时说明——编辑时保存的状态是"需要刷新"（本页过旧，给"重新加载"）或"不能保存"（文档由更新的版本
// 保存过），阅读时不给"编辑"；快照达到容量的 80% 时在一直在的读屏状态区里给一条不打断的说明；保存被拒（SNAPSHOT_INVALID）按违反的规则说。
// 有焦点的按钮随状态消失时（"编辑"随权限消失、"有更新"载入之后、失去编辑权时的"保存""退出编辑"等），焦点交给一直在的返回链接
// （规范 §2.4，审查 A2）；编辑器没能重新打开时，从销毁的编辑器落到 body 的焦点交给失效说明里的按钮（复验 C2）。
// M3-P4（设计 §3.5、§3.9）：编辑时页头的保存状态是 save-indicator.ts 的全集（已保存到云端、有未保存的修改、保存中、公式结果尚未保存、
// 自动重试中、保存失败、已离线、暂停与终态）；看得见的状态照常变，读屏只播有意义的变化（SaveAnnouncer）——模式的切换照旧都播，编辑时
// 例行的"有未保存的修改 → 保存中… → 已保存到云端"只改看得见的文字。失败的说明在自动重试期间保留（保存的状态机留着上一次的原因）；
// "保存"不随保存中变灰（在途时按下排一次）。阅读时本页显示的这一版"公式待更新"时，在读屏状态区里说明（能编辑的人另说进入编辑之后会重算）。
// 页头的文档详情没能刷新时，"重试"在重新取的过程中说正在重试（DEF-045）。
// M3-P4（设计 §3.12，US-M3-15）：打开自检失败的阅读（damaged）不给"编辑"、页头只能查看，说明按原因与能不能编辑分：编辑器没有完整载入
// （档案不全）时请重新加载页面、给"重新加载"；这份文档的数据没能完整载入时，能编辑的人说已阻止编辑与哪些部分没能载入（提示条，
// role="alert"），查看者只说显示的内容可能不完整（读屏状态区）。随之消失的"编辑"上的焦点交给返回链接（与权限消失同一个做法）。
// M3-P5（设计 §3.10、§3.11）：离开编辑的过程中页头按原因说（退出编辑、10 分钟没有操作正在保存并释放、交出）；只有"退出编辑"的那一种
// 由它的按钮说正在退出（别的不是按了它）。空闲释放、交给本浏览器的另一个标签页之后的说明放进一直在的读屏状态区（不新插入 role="status"）；
// 本人在本浏览器的另一个标签页、另一台设备上接手了编辑时，失效的说明照实说。本人接管（设计 §3.7）：持有者是自己时"编辑"换成"在此编辑"
// （同一个按钮），说明区分本浏览器的另一个标签页与别处；接手进行中按钮留着、说"正在接手…"（不可用、进行中），进展在读屏状态区里说；那边没能
// 交出时同一个按钮换成"仍在此编辑"，旁边加"取消"（点了随之消失，焦点由 useFocusRescue 交给返回链接）。
// 请求编辑（设计 §3.6，US-M3-06）：持有者是别人、自己能编辑时"编辑"换成"请求编辑"，之后同一个按钮说"正在请求…""取消请求""正在取消…"
// （进行中不可用、标为进行中）；等待中、结束之后（谢绝、别人已在请求、编辑权刚交给了别人、失效、空闲取消、交给了请求方）的说明都在读屏状态区里，
// 没能请求编辑在提示条里；本人在别的页面、设备上发出、正在等的请求（不是这一页发出的，审查 B2）同样在读屏状态区里说一句。持有者这一侧：有人请求时页头下面一个带标题的分组（role="group"），"交出""继续编辑"与一行静态说明——不是对话框、
// 不是 alert，出现时不移动焦点；读屏的那一句放进一直在的读屏状态区（只有这一句时视觉隐藏：分组里已经写着），请求方取消之后那里说明一句。
// 离开编辑的过程中分组留着、按钮不可用（焦点不丢），回到阅读之后随之消失（useFocusRescue 交给返回链接）。
// 强制接管（设计 §3.8，US-M3-09）：阅读时、别人在编辑时、能强制接管时"请求编辑"旁边另有"强制接管"（与请求编辑、"在此编辑"互斥）；点了先确认
// （ConfirmDialog，destructive），确认框关掉、焦点交还给"强制接管"之后才开始——进入编辑与没成功时的说明都写在那之后（规范 §2.4）；进入编辑的过程中
// 同一个按钮留着、说正在接管（不可用、进行中），没成功时焦点还在它上面，它随权限消失时交给返回链接。被接管的人：失去编辑权的说明说空间管理员
// （个人空间是文档的所有者）强制接管了编辑，读到了接管的人就带上人名。
// 异常中断的提醒（设计 §3.5、§3.11，US-M3-10）：进入编辑之后页头下面一条不打断的说明（不是 alert、不新插入 role="status"）与"知道了"，同一句话
// 在一直在的读屏状态区里播一次（只有它与请求的那一句时视觉隐藏），离开编辑时消失；时刻是服务端的，按页面的时区写成 HH:mm，可能已经不是今天时
// 带日期。阅读时别人的那一代异常中断的提醒在读屏状态区里。
// 焦点（规范 §2.4，M3-P5 的通查）：每次重建（进入编辑、离开编辑、空闲释放、交出、失去编辑权）都由新建的编辑器把焦点放进它的输入框（SDK 初始化时做，
// edit-mode.spec 的 US-M3-01 钉着），页头里随之消失的按钮不必另接；不重建就消失的（"知道了"、"继续编辑"之后的提示、"在此编辑"的"取消"、
// 随权限消失的"强制接管"）由 useFocusRescue 交给返回链接。
// 编辑器本身挂在页头之外的容器里（editor.html 的 #sheet-editor），不归 React 管。
import type { EditInterruption, SnapshotRule } from '@nerve-office/contracts'
import type { ReactNode, RefObject } from 'react'
import type { Phrase as PhraseParts } from '../../shared/i18n/index.ts'
import type { PendingConfirmation } from '../confirmation/index.ts'
import type { Incompatibility } from './client-format.ts'
import type { LeaseHolder, LeaseLoss } from './edit-lease.ts'
import type { CopyState, EditingNotice, IncomingRequest, LeaveCause, LostMode, OpenCheckFailures, ReadingMode, ReadingNotice, TakeoverProgress } from './edit-mode.ts'
import type { EditRequestProgress } from './edit-request.ts'
import type { EditorPage, EditorPageLoad, EditorPageReady, EditorPageSession, EditorPageView } from './editor-page.ts'
import type { SaveProblem, SaveView } from './save-coordinator.ts'
import type { SaveIndicator } from './save-indicator.ts'
import { documentPagePath, EDIT_INTERRUPTION_NOTICE_SECONDS, isProfileFailure, SNAPSHOT_MAX_RAW_BYTES, SNAPSHOT_WARN_RAW_BYTES, snapshotInvalidDetailsSchema } from '@nerve-office/contracts'
import { QueryClientProvider } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { ApiError, describeError, isAuthenticationError, isCsrfTokenError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'
import { formatClockTime, formatRecentClockTime } from '../../shared/lib/format.ts'
import { LOGIN_PATH } from '../../shared/lib/login-path.ts'
import { HOME_PATH, SHARED_PATH, spacePath } from '../../shared/lib/space-paths.ts'
import { focusIsLost } from '../../shared/lib/use-focus-hand-off.ts'
import { useFocusRescue } from '../../shared/lib/use-focus-rescue.ts'
import { Alert, AlertDescription, Button, buttonVariants, PersonName, Phrase } from '../../shared/ui/index.ts'
import { DetailRefreshProblem } from '../../shared/ui/refresh-problem.tsx'
import { StatusRegion } from '../../shared/ui/status-region.tsx'
import { ConfirmDialog } from '../confirmation/index.ts'
import { editorQueryClient } from './editor-query-client.ts'
import { ANNOUNCEMENT_MS, announcementKey, saveIndicator } from './save-indicator.ts'
import { EditorShareEntry } from './share-entry.tsx'

/**
 * 返回的去处（M2-P2 设计 §3.10，M2-P5 设计 §3.5）：
 * - 只凭单独授权打开的（accessVia 为 grant）：回"与我共享"——看不到它所在空间的目录结构，也就不显示所在位置；
 * - 个人空间：回到首页（"我的空间"：在个人空间里有角色的只有所有者自己）；
 * - 团队空间：回到它的空间页，显示它的名称。
 * 个人空间存的名称一律不显示（规范 §2.4，详情里也不给）。还没加载好（或者加载失败）时回到首页
 */
function backLinkOf(ready: EditorPageReady | undefined): { readonly href: string, readonly label: string } {
  if (ready === undefined)
    return { href: HOME_PATH, label: editorMessages.back }
  if (ready.accessVia === 'grant')
    return { href: SHARED_PATH, label: messages.spaces.sharedWithMe }
  if (ready.space.type === 'personal')
    return { href: HOME_PATH, label: editorMessages.back }
  return { href: spacePath(ready.space.id), label: ready.space.name }
}

/**
 * 登录已过期、令牌失效这类失败：会话不是 active 时由会话的提示说明，不再重复（复验 RB2）；
 * 向服务端确认会话进行中先不显示，等确认有了结果（复验 TB1）
 */
function isSessionProblem(problem: SaveProblem): boolean {
  return problem.kind === 'request' && (isAuthenticationError(problem.error) || isCsrfTokenError(problem.error))
}

/** SNAPSHOT_INVALID 的详情里违反的规则（宽松解析，认不出时为 undefined：照"格式不正确"说） */
function snapshotRuleOf(error: ApiError): SnapshotRule | undefined {
  const details = snapshotInvalidDetailsSchema.safeParse(error.details ?? {})
  return details.success ? details.data.rule : undefined
}

/** sessionProblem：最近一次确认会话失败的原因 */
function problemMessage(problem: SaveProblem, sessionProblem: unknown): { text: string, requestId?: string, destructive: boolean } {
  if (problem.kind === 'cell-editing')
    return { text: editorMessages.finishCellEditing, destructive: false }
  if (problem.kind === 'too-large' || (problem.error instanceof ApiError && problem.error.code === 'PAYLOAD_TOO_LARGE'))
    return { text: editorMessages.tooLarge, destructive: true }
  // 会话是本人时的令牌失效与未登录（例如迟到的回包）：确认之后令牌已按服务端确认的会话换过，再保存一次即可；
  // 确认失败时令牌没有换成，说明原因（再按保存会先确认，复验 TB1）。不能让用户刷新（刷新会丢掉本页的修改，复验 SB1）
  if (isSessionProblem(problem) && problem.kind === 'request' && problem.error instanceof ApiError) {
    if (sessionProblem === undefined)
      return { text: editorMessages.saveFailed(editorMessages.retrySave), requestId: problem.error.requestId, destructive: true }
    const reason = describeError(sessionProblem)
    return { text: editorMessages.saveFailed(editorMessages.sessionCheckFailed(reason.message)), requestId: reason.requestId, destructive: true }
  }
  // 快照被服务端拒绝（M3-P3）：按违反的规则说（链接、图片、资源、过于复杂……），不认识的规则照"格式不正确"说
  if (problem.error instanceof ApiError && problem.error.code === 'SNAPSHOT_INVALID')
    return { text: editorMessages.saveFailed(editorMessages.snapshotInvalid(snapshotRuleOf(problem.error))), requestId: problem.error.requestId, destructive: true }
  // 400（请求不合法）是这次请求本身的问题，按错误码说明（M2-P6 复核第二批 G-5）
  const error = describeError(problem.error)
  return { text: editorMessages.saveFailed(error.message), requestId: error.requestId, destructive: true }
}

/** 编辑时页头的保存状态（设计 §3.9）：保存的状态机连同自动保存这一侧的状态 */
function indicatorOf(view: EditorPageView, save: SaveView): SaveIndicator {
  return saveIndicator(save, view.autosave)
}

/**
 * 自动保存暂停的原因（审查 A6）：会话不是本人（没有人登录、换了人）——登录回来之后自动保存；本人在登录中，只是在向服务端确认
 * （checking）或者上一次确认失败了（unconfirmed：网络等，页面恢复联网、回到前台与定时都会再确认）——不能说"登录回来之后"
 */
type PausedReason = 'session' | 'checking' | 'unconfirmed'

function pausedReasonOf(view: EditorPageView): PausedReason {
  if (view.session !== 'active')
    return 'session'
  return view.sessionProblem === undefined ? 'checking' : 'unconfirmed'
}

/** 编辑时页头的保存状态的说法：暂停按原因说 */
function saveStateText(view: EditorPageView, save: SaveView): string {
  const indicator = indicatorOf(view, save)
  if (indicator !== 'paused')
    return editorMessages.saveState[indicator]
  switch (pausedReasonOf(view)) {
    case 'session':
      return editorMessages.saveState.paused
    case 'checking':
      return messages.auth.checkingSession
    case 'unconfirmed':
      return editorMessages.pausedUnconfirmed
  }
}

/** 离开编辑的过程中页头的说法（M3-P5 设计 §3.11）：按原因 */
function leavingText(cause: LeaveCause): string {
  switch (cause) {
    case 'exit':
      return editorMessages.mode.exiting
    case 'idle':
      return editorMessages.mode.idleReleasing
    case 'handover-request':
    case 'handover-tab':
      return editorMessages.mode.handingOver
  }
}

/**
 * 页头看得见的状态：模式（打开中、只能查看、进入与退出编辑、编辑权已失效……）与编辑时的保存状态。它本身不是读屏的播报区：
 * 读屏播的是 SaveAnnouncer 的那一句（只播有意义的变化）
 */
function headerStatus(view: EditorPageView): string {
  const { load, mode, save } = view
  if (load.kind === 'loading' || mode === undefined)
    return editorMessages.loading
  switch (mode.kind) {
    case 'opening':
      return editorMessages.loading
    case 'reading':
      // 点了"编辑"、要先向服务端确认会话（审查 A10）：确认期间说正在确认，与按保存时的确认相同（复验 C8）
      if (view.confirmingSession)
        return messages.auth.checkingSession
      // 与服务端不兼容（M3-P3）：本页过旧时需要刷新；文档由更新的版本保存过时只能查看。打开自检失败（M3-P4）同样只能查看，原因在说明里
      if (mode.blocked === 'client-outdated')
        return editorMessages.status.outdated
      return mode.canEdit && mode.blocked === undefined && mode.damaged === undefined ? '' : editorMessages.status.readOnly
    case 'entering':
      return editorMessages.mode.entering
    case 'editing':
      if (view.confirmingSession)
        return messages.auth.checkingSession
      return save === undefined ? '' : saveStateText(view, save)
    case 'exiting':
      return leavingText(mode.cause)
    case 'losing':
      return editorMessages.mode.losing
    case 'lost':
      return editorMessages.status.leaseLost
    case 'failed':
    case 'unavailable':
      return ''
  }
}

/** 读屏的播报：key 一样就不再播（undefined 是不改播报区，见 announcementOf）；text 是要播的那一句 */
interface Announcement {
  readonly key: string | undefined
  readonly text: string
}

/**
 * 读屏要播的那一句（设计 §3.9）：模式的切换、会话的确认照旧每次都播（key 就是那句话）；编辑时按保存状态的 announcementKey
 * （save-indicator.ts：只播有意义的变化，例行的"有未保存的修改""保存中…"不改播报区）。暂停按原因分开播（审查 A6）：
 * 不是用户按了保存的那种确认（例如别的标签页的消息触发的）不播，确认失败了才播
 */
function announcementOf(view: EditorPageView): Announcement {
  const text = headerStatus(view)
  if (view.mode?.kind === 'editing' && !view.confirmingSession && view.save !== undefined) {
    const indicator = indicatorOf(view, view.save)
    if (indicator === 'paused') {
      const reason = pausedReasonOf(view)
      return { key: reason === 'checking' ? undefined : `save:paused:${reason}`, text }
    }
    const key = announcementKey(indicator)
    return { key: key === undefined ? undefined : `save:${key}`, text }
  }
  return { key: `page:${text}`, text }
}

/**
 * 读屏的播报区（role="status"，一直在、只做视觉隐藏）：announcementOf 的 key 变了才换上新的一句，ANNOUNCEMENT_MS 之后清空。
 * 显式写 aria-live（语义不变：role="status" 本来就是 polite，M2-P5 复验第二轮 G1）：保存在后台进行，分享对话框（模态）开着时也会完成或失败；
 * Radix 的模态弹窗打开时把弹窗之外的内容都标为 aria-hidden，只跳过那一刻已经在的、显式写了 aria-live 的元素（aria-hidden 库的 hideOthers）
 */
function SaveAnnouncer({ view }: { view: EditorPageView }) {
  const next = announcementOf(view)
  const [spoken, setSpoken] = useState<Announcement>(() => (next.key === undefined ? { key: undefined, text: '' } : next))
  const [cleared, setCleared] = useState(false)
  // 渲染中按这一次的结果调整（React 的写法：随即重新渲染，不经 effect 多渲染一轮）
  if (next.key !== undefined && next.key !== spoken.key) {
    setSpoken(next)
    setCleared(false)
  }
  useEffect(() => {
    if (cleared || spoken.text === '')
      return
    const timer = setTimeout(setCleared, ANNOUNCEMENT_MS, true)
    return () => clearTimeout(timer)
  }, [spoken, cleared])
  return <p role="status" aria-live="polite" className="sr-only">{cleared ? '' : spoken.text}</p>
}

/**
 * 编辑时（与离开编辑的过程中）页头里能做的事。不可用一律用 aria-disabled：按钮变成 disabled 时焦点会丢（审查 B13），重复点击由
 * 保存的状态机、页面挡住。"保存"不随保存中变灰：在途时按下排一次（M3-P4 设计 §3.9）。离开中两个按钮都留着、都不可用：
 * 没有离开成功（保存失败、公式没收齐）时焦点还在原来的按钮上（审查 A2）。leaving 是离开的原因（不在离开时为 undefined）：
 * 只有"退出编辑"的那一种由它说正在退出、标为进行中（空闲释放、交出不是按了它，页头的状态说明在做什么，M3-P5 设计 §3.11）
 */
function SaveControls({ page, save, confirming, leaving, apple }: { page: EditorPage, save: SaveView, confirming: boolean, leaving: LeaveCause | undefined, apple: boolean }) {
  const exiting = leaving === 'exit'
  return (
    <>
      <Button
        size="sm"
        aria-disabled={!save.canSave || confirming || leaving !== undefined}
        aria-busy={confirming}
        aria-keyshortcuts={apple ? 'Meta+S' : 'Control+S'}
        title={editorMessages.saveShortcut(apple ? '⌘S' : 'Ctrl+S')}
        onClick={() => void page.save()}
      >
        {editorMessages.save}
      </Button>
      {/* 退出编辑：先保存（没存上就留在编辑，说明由保存的状态给出），释放编辑权，回到阅读 */}
      <Button size="sm" variant="outline" aria-disabled={confirming || leaving !== undefined} aria-busy={exiting} onClick={() => void page.exitEditing()}>
        {exiting ? editorMessages.mode.exiting : editorMessages.mode.exit}
      </Button>
    </>
  )
}

/**
 * 阅读时进入编辑的那个按钮这一刻做什么（同一个按钮元素，M3-P5 设计 §3.11）：请求编辑进行中——等待时取消请求，发出、取消的过程中不做事；持有者是
 * 自己、"在此编辑"进行中或等人选——本人接管；别人在编辑——请求编辑；没人在编辑（或者认不出是谁）——编辑。进入编辑中不做事
 */
type EnterAction = 'enter' | 'take-over' | 'request' | 'cancel-request' | 'none'

function enterActionOf(reading: ReadingMode | undefined): EnterAction {
  if (reading === undefined)
    return 'none'
  const request = reading.request
  if (request !== undefined)
    return request.kind === 'waiting' || request.kind === 'granted' ? 'cancel-request' : 'none'
  if (reading.holder?.sameUser === true || reading.takeover !== undefined)
    return 'take-over'
  return reading.holder === undefined ? 'enter' : 'request'
}

/**
 * 阅读时进入编辑的那个按钮的说法：进入编辑中；请求编辑的进展（正在请求、取消请求、正在取消）；那边没能交出（仍在此编辑）、接手中、持有者是自己
 * （在此编辑）；别人在编辑（请求编辑）；别的（编辑）
 */
function enterLabel(reading: ReadingMode | undefined): string {
  if (reading === undefined)
    return editorMessages.mode.entering
  switch (reading.request?.kind) {
    case 'sending':
      return editorMessages.mode.requesting
    case 'cancelling':
      return editorMessages.mode.cancellingRequest
    case 'waiting':
    case 'granted':
      return editorMessages.mode.cancelRequest
    case undefined:
      break
  }
  if (reading.takeover?.kind === 'failed')
    return editorMessages.mode.takeOverAnyway
  if (reading.takeover !== undefined)
    return editorMessages.mode.takingOver
  if (reading.holder?.sameUser === true)
    return editorMessages.mode.takeOverHere
  return reading.holder === undefined ? editorMessages.mode.enter : editorMessages.mode.requestEdit
}

/**
 * 阅读时能不能"强制接管"（M3-P5 设计 §3.8）：能强制接管、能编辑、还读得到、没有不兼容与数据不完整，正在编辑的是别人；与请求编辑、"在此编辑"互斥
 * （它们进行中不出现：请求在等时持有者会交出，接手是本人的事）
 */
function offersForceTakeOver(reading: ReadingMode): boolean {
  return reading.canTakeOver && reading.canEdit && !reading.gone && reading.blocked === undefined && reading.damaged === undefined
    && reading.holder !== undefined && !reading.holder.sameUser && reading.request === undefined && reading.takeover === undefined
}

/**
 * 阅读时（与进入编辑的过程中）页头里能做的事："有更新，点击刷新"；"编辑"（能编辑、还读得到时）。reading 为 undefined 是进入编辑中：
 * "编辑"留着、说正在进入，没有进入成功（被占用、网络失败）时焦点还在它上面（审查 A2）。正在载入最新的版本时（审查 A1）、会话不是本人时
 * （审查 A10）"编辑"不可用；点了由页面挡住，或者先向服务端确认会话。确认会话期间（confirming）"编辑"不可用、标为进行中，文字不变，
 * 页头的状态说正在确认登录状态——与按保存时的确认同一个做法，确认之后进入编辑时才说正在进入（复验 C8）。
 * 持有者是自己（M3-P5 设计 §3.7）：同一个按钮换成"在此编辑"；接手进行中说"正在接手…"（不可用、进行中，"有更新"也不可用）；那边没能交出时
 * 换成"仍在此编辑"，旁边加"取消"。
 * 强制接管（M3-P5 设计 §3.8）："请求编辑"旁边的"强制接管"（outline）：点了交给 onForce（先确认）；forcing 是强制接管的进入编辑中——这时只留它，
 * 说正在接管（不可用、进行中），没成功时焦点还在它上面
 */
function ReadingControls({ page, reading, session, confirming, forcing, forceRef, onForce }: { page: EditorPage, reading: ReadingMode | undefined, session: EditorPageSession, confirming: boolean, forcing: boolean, forceRef: RefObject<HTMLButtonElement | null>, onForce: (holder: LeaseHolder) => void }) {
  const entering = reading === undefined
  const update = reading?.update ?? 'none'
  // 与服务端不兼容（M3-P3）时不给"编辑"：申请也会被拒，重新加载才是新的页面。打开自检失败（M3-P4）时同样不给：数据不完整的不能编辑
  const offersEdit = reading === undefined || (reading.canEdit && !reading.gone && reading.blocked === undefined && reading.damaged === undefined)
  const takeover = reading?.takeover
  const taking = takeover !== undefined && takeover.kind !== 'failed'
  // 请求编辑正在发出、正在取消（M3-P5）：按钮留着，不可用、标为进行中
  const requestBusy = reading?.request?.kind === 'sending' || reading?.request?.kind === 'cancelling'
  const action = enterActionOf(reading)
  // 取消请求不受"正在载入最新的版本"影响（与重建无关）
  const blockedByUpdate = update === 'loading' && action !== 'cancel-request'
  // 强制接管：阅读时按条件出现，进入编辑的过程中（forcing）留着；载入最新的版本、确认会话、会话不是本人时不可用
  const forceHolder = reading !== undefined && offersForceTakeOver(reading) ? reading.holder : undefined
  const forceUnavailable = forcing || confirming || update === 'loading' || session !== 'active'
  const run = (): void => {
    switch (action) {
      case 'enter':
        void page.enterEditing()
        break
      case 'take-over':
        void page.takeOverHere()
        break
      case 'request':
        void page.requestEditing()
        break
      case 'cancel-request':
        void page.cancelRequest()
        break
      case 'none':
        break
    }
  }
  return (
    <>
      {update !== 'none' && (
        <Button size="sm" variant="outline" aria-disabled={update === 'loading' || taking} onClick={() => void page.refreshUpdate()}>
          {update === 'loading' ? editorMessages.mode.updating : editorMessages.mode.update}
        </Button>
      )}
      {offersEdit && !forcing && (
        <Button size="sm" aria-disabled={entering || taking || requestBusy || confirming || blockedByUpdate || session !== 'active'} aria-busy={entering || taking || requestBusy || confirming} onClick={run}>
          {enterLabel(reading)}
        </Button>
      )}
      {offersEdit && takeover?.kind === 'failed' && (
        <Button size="sm" variant="outline" onClick={page.cancelTakeOver}>{editorMessages.mode.cancelTakeOver}</Button>
      )}
      {(forcing || forceHolder !== undefined) && (
        <Button
          ref={forceRef}
          size="sm"
          variant="outline"
          aria-disabled={forceUnavailable}
          aria-busy={forcing}
          onClick={() => {
            if (!forceUnavailable && forceHolder !== undefined)
              onForce(forceHolder)
          }}
        >
          {forcing ? editorMessages.mode.forcingTakeover : editorMessages.mode.forceTakeOver}
        </Button>
      )}
    </>
  )
}

/** 编辑时与服务端不兼容（M3-P3）：保存的状态是终态 outdated、too-new；其余为 undefined */
function editingBlock(save: SaveView): Incompatibility | undefined {
  if (save.status === 'outdated')
    return 'client-outdated'
  return save.status === 'too-new' ? 'document-too-new' : undefined
}

/**
 * 与服务端不兼容时本页的修改存上了没有（M3-P3 审查 B5）：正在核对结果未知的那次保存时先不下结论；修改没有保存；修改都已保存、
 * 只有公式的结果没有存上；都已保存
 */
type PendingWork = 'checking' | 'edits' | 'formulas' | 'none'

function pendingWorkOf(save: SaveView): PendingWork {
  if (save.checking)
    return 'checking'
  if (save.unsavedEdits)
    return 'edits'
  return save.unsaved ? 'formulas' : 'none'
}

/**
 * 与服务端不兼容的说明（M3-P3 设计 §3.10）：本页过旧时给"重新加载"（重新加载就是新的页面；编辑时本页的修改没保存的话先说明复制出来）；
 * 文档由更新的版本保存过时只说明——重新加载拿到的还是同一个版本，不提示刷新（那会死循环）。editing 是编辑时本页的修改存上了没有，
 * 阅读时为 undefined
 */
function IncompatibleNotice({ kind, editing, onReload }: { kind: Incompatibility, editing: PendingWork | undefined, onReload: () => void }) {
  if (kind === 'document-too-new') {
    return (
      <Alert variant={editing === undefined ? 'default' : 'destructive'}>
        <AlertDescription>{editing === undefined ? editorMessages.incompatible.tooNewReading : editorMessages.incompatible.tooNewEditing(editing)}</AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert variant="destructive">
      <AlertDescription>
        <p>{editing === undefined ? editorMessages.incompatible.outdatedReading : editorMessages.incompatible.outdatedEditing(editing)}</p>
        <Button variant="outline" size="sm" className="mt-2" onClick={onReload}>{editorMessages.reload}</Button>
      </AlertDescription>
    </Alert>
  )
}

/** 打开自检失败的原因（M3-P4 设计 §3.12）：编辑器自己没有完整载入（档案不全，有一项就是），或者这份文档的数据没能完整载入 */
function damageOf(failures: OpenCheckFailures): 'profile' | 'data' {
  return failures.some(failure => isProfileFailure(failure.kind)) ? 'profile' : 'data'
}

/** 没能完整载入的那几部分的说法：按失败清单的先后，去掉重复（三种保护设置是一个说法） */
function damagedParts(failures: OpenCheckFailures): string[] {
  return [...new Set(failures.map(failure => editorMessages.damaged.resource(failure.resource)))]
}

/**
 * 打开自检失败的说明（M3-P4 设计 §3.12）：编辑器没有完整载入时请重新加载页面，给"重新加载"（能编辑的人另说已阻止编辑）；这份文档的数据
 * 没能完整载入时，能编辑的人说已阻止编辑、哪些部分没能载入、继续编辑会让它们丢失、已通知管理员。查看者的数据不完整只是一句不打断的说明，
 * 在读屏状态区里（readingInfo），这里不画
 */
function DamagedNotice({ failures, canEdit, onReload }: { failures: OpenCheckFailures, canEdit: boolean, onReload: () => void }) {
  if (damageOf(failures) === 'profile') {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>{canEdit ? editorMessages.damaged.profile : editorMessages.damaged.profileViewer}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={onReload}>{editorMessages.reload}</Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (!canEdit)
    return null
  return (
    <Alert variant="destructive">
      <AlertDescription>
        <p>{editorMessages.damaged.blocked}</p>
        <p>{editorMessages.damaged.reason(damagedParts(failures))}</p>
      </AlertDescription>
    </Alert>
  )
}

/** 最近一次捕获达到容量的 80%（US-M3-14）、还没超过上限时的说明；超过上限由保存失败（too-large）说明 */
function capacityNote(save: SaveView | undefined): string | undefined {
  const bytes = save?.snapshotBytes
  if (bytes === undefined || bytes < SNAPSHOT_WARN_RAW_BYTES || bytes > SNAPSHOT_MAX_RAW_BYTES)
    return undefined
  return editorMessages.nearCapacity(Math.floor((bytes / SNAPSHOT_MAX_RAW_BYTES) * 100))
}

function SaveNotices({ view, save, onReload }: { view: EditorPageView, save: SaveView, onReload: () => void }) {
  const { session } = view
  const notices: ReactNode[] = []
  const block = editingBlock(save)
  if (block !== undefined)
    notices.push(<IncompatibleNotice key="incompatible" kind={block} editing={pendingWorkOf(save)} onReload={onReload} />)
  if (save.conflict !== undefined) {
    notices.push(
      <Alert key="conflict" variant="destructive">
        <AlertDescription>
          <p>{editorMessages.conflict}</p>
          {/* 换了人：重新加载会以另一个账户打开，可能看不到这份文档，先说明（复验 TB8） */}
          {session === 'other-user' && <p>{editorMessages.otherUserBeforeReload}</p>}
          <Button variant="outline" size="sm" className="mt-2" onClick={onReload}>{editorMessages.reload}</Button>
        </AlertDescription>
      </Alert>,
    )
  }
  if (save.problem !== undefined && !(isSessionProblem(save.problem) && (session !== 'active' || view.confirmingSession))) {
    const problem = problemMessage(save.problem, view.sessionProblem)
    notices.push(
      <Alert key="problem" variant={problem.destructive ? 'destructive' : 'default'}>
        <AlertDescription>
          <p>{problem.text}</p>
          {problem.requestId !== undefined && <p>{messages.common.requestId(problem.requestId)}</p>}
        </AlertDescription>
      </Alert>,
    )
  }
  // "公式结果尚未保存"由页头的保存状态说（算完之后自动保存，M3-P4 设计 §3.9），不另给说明
  return notices
}

/** 别处正在编辑：谁（人名经人名组件）、最后活动几分钟之前；是自己时说在另一个标签页或设备上 */
function heldCause(holder: LeaseHolder | undefined): PhraseParts<ReactNode> {
  if (holder === undefined)
    return [editorMessages.editing.lostHeldUnknown]
  if (holder.sameUser)
    return [editorMessages.editing.lostHeldBySelf]
  const lastActive = holder.lastActiveMinutes === undefined ? undefined : editorMessages.editing.lastActive(holder.lastActiveMinutes)
  return editorMessages.editing.lostHeldBy(<PersonName person={holder.holder} />, lastActive)
}

/**
 * 编辑权失效的原因（P1 设计 §3.2；编辑权中断时先自动续上，到这里的是续不上的，或者失去了访问、编辑权）：
 * 编辑权被收回；不认识的原因（undefined，只说编辑权已失效）；读不到了（404）与不能编辑了（403，带上服务端这次给的原因）分开说；
 * 续上时别处正在编辑；续上时发现别处保存过更新的版本；本人在别处接手了；被强制接管了（M3-P5 设计 §3.8：空间管理员，个人空间是文档的所有者——
 * personal；读到了接管的人就带上人名）；已经交给了请求编辑的人（§3.6：交出的回答没收到、之后才得知）
 */
function lostCause(loss: LeaseLoss, personal: boolean): PhraseParts<ReactNode> | undefined {
  switch (loss.kind) {
    case 'lease':
      return loss.reason === 'revoked' ? [editorMessages.editing.lostRevoked] : undefined
    case 'not-found':
      return [editorMessages.editing.lostNotFound]
    case 'denied':
      return [editorMessages.editing.lostDenied(describeError(loss.error).message)]
    case 'held':
      return heldCause(loss.holder)
    case 'newer':
      return [editorMessages.editing.lostNewer]
    case 'taken-over':
      return [loss.where === 'this-browser' ? editorMessages.editing.lostTakenOverHere : editorMessages.editing.lostTakenOverElsewhere]
    case 'forced':
      return editorMessages.editing.lostForced(loss.by === undefined ? undefined : <PersonName person={loss.by} />, personal)
    case 'handed-over':
      return editorMessages.editing.lostHandedOver(loss.to === undefined ? undefined : <PersonName person={loss.to} />)
  }
}

/** 另存为副本成功的说明：新文档在新标签页打开（本页留着） */
function CopiedNote({ title, documentId }: { title: string, documentId: string }) {
  return (
    <>
      {editorMessages.mode.copied(title)}
      {' '}
      <a href={documentPagePath(documentId)} target="_blank" rel="noopener" className="underline underline-offset-2">{editorMessages.mode.openCopy}</a>
    </>
  )
}

/**
 * 副本被拒、再试也一样时的说明（M3-P3 审查 B3）：本页过旧时说先把内容复制出来、再重新加载页面；内容不能保存时按违反的规则
 * （或超过容量）说，与编辑时保存被拒同一套说法，不说"可以再试"
 */
function copyRefusalMessage(refused: Extract<CopyState, { kind: 'refused' }>): string {
  if (refused.refusal === 'outdated')
    return editorMessages.lost.copyOutdated
  const problem = refused.error.code === 'PAYLOAD_TOO_LARGE' ? editorMessages.capacityExceeded : editorMessages.snapshotInvalid(snapshotRuleOf(refused.error))
  return editorMessages.lost.copyRefused(problem)
}

/**
 * 失去编辑权（M3-P2 设计 §3.4）：原因与本页的修改有没有保存（只看内容，不看保存的状态，M3-P1 审查 B3），之后能做的事：
 * - 还读得到而且有修改：另存为副本（失败可以再试，内容一律留着）、放弃本页的修改（先确认）；正在核对结果未知的那次保存时先不给；
 *   副本被拒、再试也一样时（M3-P3 审查 B3）不再给副本——本页过旧时只给整页的重新加载（重新加载就是新的页面，说明里先请用户把内容
 *   复制出来），内容不能保存时给放弃；
 * - 还读得到、没有修改（或已经另存为副本）：重新加载——按服务端的最新内容重建为阅读；
 * - 读不到了（404）：只说明（审查 B2）；页头的返回链接照常在；
 * - 本页的内容没能取出：编辑器留着（还能复制），提供整页重新加载；
 * - 单元格里正在输入的那一处提交不了：说明它不在取出的内容里（审查 A4）；
 * - 编辑器没能重新打开（以只读重建失败）：说明表格暂时显示不出来，副本照常（审查 A3）。焦点原在可编辑的编辑器里（单元格的输入框），
 *   它销毁之后没有新的编辑器接过焦点、落到了 body：交给说明里的第一个按钮（另存为副本、重新加载），没有按钮时（正在核对那次保存）
 *   交给返回链接；焦点在别处时不抢（复验 C2，规范 §2.4）
 */
function LostNotice({ page, lost, personal, onDiscard, fallbackFocus }: { page: EditorPage, lost: LostMode, personal: boolean, onDiscard: () => void, fallbackFocus: RefObject<HTMLElement | null> }) {
  const { loss, unsaved, readable, checking, captureFailed, inputLeft, reopenFailed, copy, reload } = lost
  const copied = copy.kind === 'done' ? copy.document : undefined
  const refused = copy.kind === 'refused' ? copy : undefined
  // 还能另存为副本：读得到、有修改、取出了内容、还没建好，也没有被拒得再试也一样
  const copyable = readable && unsaved && !captureFailed && copied === undefined && refused === undefined
  const offersCopy = copyable && !checking
  const offersDiscard = offersCopy || refused?.refusal === 'content'
  const offersReload = readable && !captureFailed && (!unsaved || copied !== undefined)
  // 整页的重新加载：本页的内容没能取出时；副本因本页过旧被拒时（重新加载就是新的页面）
  const offersPageReload = captureFailed || refused?.refusal === 'outdated'
  const noticeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (reopenFailed && focusIsLost())
      (noticeRef.current?.querySelector('button') ?? fallbackFocus.current)?.focus()
  }, [reopenFailed, fallbackFocus])
  return (
    <Alert ref={noticeRef} variant="destructive">
      <AlertDescription>
        {captureFailed
          ? <p>{editorMessages.lost.captureFailed}</p>
          : <p><Phrase parts={editorMessages.editing.lost(lostCause(loss, personal), unsaved && copied === undefined, readable, !reopenFailed, refused === undefined)} /></p>}
        {inputLeft && !captureFailed && <p>{editorMessages.lost.inputLeft}</p>}
        {reopenFailed && <p>{editorMessages.lost.reopenFailed(copyable)}</p>}
        {checking && <p>{editorMessages.lost.checking}</p>}
        {copy.kind === 'failed' && <p>{editorMessages.lost.copyFailed(describeError(copy.error).message)}</p>}
        {refused !== undefined && <p>{copyRefusalMessage(refused)}</p>}
        {copied !== undefined && <p><CopiedNote title={copied.title} documentId={copied.id} /></p>}
        {reload.kind === 'loading' && <p>{editorMessages.lost.reloading}</p>}
        {reload.kind === 'failed' && <p>{editorMessages.lost.reloadFailed(describeError(reload.error).message)}</p>}
        {(offersCopy || offersDiscard || offersReload || offersPageReload) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {offersCopy && (
              <Button variant="outline" size="sm" aria-disabled={copy.kind === 'saving' || reload.kind === 'loading'} onClick={() => void page.saveCopy()}>
                {copy.kind === 'saving' ? editorMessages.lost.savingCopy : editorMessages.lost.saveCopy}
              </Button>
            )}
            {offersDiscard && <Button variant="outline" size="sm" aria-disabled={copy.kind === 'saving' || reload.kind === 'loading'} onClick={onDiscard}>{editorMessages.lost.discard}</Button>}
            {offersReload && <Button variant="outline" size="sm" aria-disabled={reload.kind === 'loading'} onClick={() => void page.discard()}>{editorMessages.reload}</Button>}
            {offersPageReload && <Button variant="outline" size="sm" onClick={page.reload}>{editorMessages.reload}</Button>}
          </div>
        )}
      </AlertDescription>
    </Alert>
  )
}

/** 阅读时上一次操作没有成功的说明（另存为副本成功的说明在读屏状态区里）。personal：文档在个人空间里（失效的原因里怎样称呼能强制接管的人） */
function readingFailure(notice: ReadingNotice | undefined, personal: boolean): ReactNode {
  switch (notice?.kind) {
    case 'denied':
      return editorMessages.mode.denied(describeError(notice.error).message)
    case 'enter-failed':
      return editorMessages.mode.enterFailed(describeError(notice.error).message)
    case 'force-denied':
      return editorMessages.mode.forceDenied(describeError(notice.error).message)
    case 'force-failed':
      return editorMessages.mode.forceFailed(describeError(notice.error).message)
    case 'enter-lost':
      return <Phrase parts={editorMessages.mode.enterLost(lostCause(notice.loss, personal))} />
    case 'editor-failed':
      return editorMessages.mode.editorFailed
    case 'refresh-failed':
      return editorMessages.mode.refreshFailed(describeError(notice.error).message)
    case 'request-denied':
      return editorMessages.mode.requestDenied(describeError(notice.error).message)
    case 'request-failed':
      return editorMessages.mode.requestFailed(describeError(notice.error).message)
    // 另存为副本成功、空闲释放、交出之后、请求编辑结束（谢绝、别人已在请求、编辑权刚交给了别人、失效、空闲取消）的说明在读屏状态区里（readingInfo）
    case 'copied':
    case 'idle-released':
    case 'handed-over-tab':
    case 'handed-over':
    case 'reserved':
    case 'request-declined':
    case 'request-occupied':
    case 'request-gone':
    case 'request-idle':
    case undefined:
      return undefined
  }
}

/**
 * 别处正在编辑时的说明（M3-P1 设计 §3.4.7）：谁在编辑（人名经人名组件）、最后活动几分钟之前；能编辑的人另说现在只能阅读。
 * 是自己、而且现在能编辑时按那个页面在哪里说（M3-P5 设计 §3.7：本浏览器的另一个标签页，或者另一台设备、浏览器，也可能是刚关闭、刷新过的
 * 页面），能"在此编辑"时说点了会怎样——本页刚退出编辑、没能确认放掉编辑权时多半就是本页那一代，照实说（releaseUnconfirmed，审查 A13）；
 * 不能编辑了时自己那一代已经失效（持有者要能编辑），只是还没读到新的编辑状态，照别人一样说谁在编辑，不提"在此编辑"。与服务端不兼容、数据
 * 不完整的阅读不给"在此编辑"，同样不提（M3-P3 审查 B8：停住续租之后退出编辑，那次释放没送到时这里也说本页刚退出）
 */
function elsewhereNotice(reading: ReadingMode, holder: LeaseHolder | undefined): ReactNode {
  if (holder === undefined)
    return editorMessages.editing.elsewhereUnknown
  if (holder.sameUser && reading.canEdit) {
    const reenter = reading.blocked === undefined && reading.damaged === undefined
    if (reading.releaseUnconfirmed)
      return editorMessages.editing.elsewhereThisPage(reenter)
    return reading.selfHolder === 'this-browser' ? editorMessages.editing.elsewhereThisBrowser(reenter) : editorMessages.editing.elsewhereAway(reenter)
  }
  const lastActive = holder.lastActiveMinutes === undefined ? undefined : editorMessages.editing.lastActive(holder.lastActiveMinutes)
  return <Phrase parts={editorMessages.editing.elsewhere(<PersonName person={holder.holder} />, lastActive, reading.canEdit)} />
}

/** "在此编辑"的进展的说明（M3-P5 设计 §3.7）：请那边交出、等刷新之前的保存、那边没能交出；刚开始时没有（照旧说谁在编辑） */
function takeoverNotice(takeover: TakeoverProgress | undefined): string | undefined {
  switch (takeover?.kind) {
    case 'asking':
      return editorMessages.mode.takeoverAsking
    case 'waiting-save':
      return editorMessages.mode.takeoverWaitingSave
    case 'failed':
      return editorMessages.mode.takeoverFailed(takeover.reason)
    case 'preparing':
    case undefined:
      return undefined
  }
}

/**
 * 请求编辑的进展的说明（M3-P5 设计 §3.6）：等待中（取消中也是）说在等谁、他停下 2 分钟会自动交过来、可以取消（不倒计时），没取消成时另说原因；
 * 编辑权已经可以交给本页而还没进入时：页面在后台说回来就进入，看得见、这一刻进不了（会话不是本人、正在载入新的版本）说稍后进入（审查 B11）。
 * 正在发出时没有（照旧说谁在编辑）
 */
function requestNotice(progress: EditRequestProgress | undefined): ReactNode {
  switch (progress?.kind) {
    case 'waiting':
    case 'cancelling': {
      const holder = progress.holder === undefined ? undefined : <PersonName person={progress.holder} />
      const failure = progress.kind === 'waiting' && progress.cancelFailure !== undefined ? progress.cancelFailure : undefined
      return (
        <>
          <Phrase parts={editorMessages.mode.requestWaiting(holder)} />
          {failure !== undefined && ` ${editorMessages.mode.cancelRequestFailed(describeError(failure).message)}`}
        </>
      )
    }
    case 'granted':
      return progress.until === 'visible' ? editorMessages.mode.requestGranted : editorMessages.mode.requestGrantedSoon
    case 'sending':
    case undefined:
      return undefined
  }
}

/**
 * 阅读里说明请求编辑结束了、交出之后的那一句（M3-P5 设计 §3.6）：交给了请求编辑的人（持有者这一侧）；编辑权刚交给了别人（留到何时，服务端的时刻
 * 按页面的时区写成 HH:mm；强制接管时得到的另说这期间不能强制接管，§3.8）；持有者谢绝了（不能强制接管的人另说可以请空间管理员——个人空间里是文档的
 * 所有者，personal）；别人已在请求；请求失效了；空闲满 10 分钟取消了
 */
function requestOutcomeNotice(reading: ReadingMode, personal: boolean): ReactNode {
  const { notice } = reading
  switch (notice?.kind) {
    case 'handed-over':
      return <Phrase parts={editorMessages.mode.handedOver(<PersonName person={notice.to} />, notice.auto)} />
    case 'reserved':
      return <Phrase parts={editorMessages.mode.reservedFor(<PersonName person={notice.reservedFor} />, formatClockTime(notice.reservedUntil), notice.forced === true)} />
    case 'request-declined':
      return <Phrase parts={editorMessages.mode.requestDeclined(<PersonName person={notice.holder} />, reading.canTakeOver, personal)} />
    case 'request-occupied':
      return <Phrase parts={editorMessages.mode.requestOccupied(<PersonName person={notice.requester} />)} />
    case 'request-gone':
      return editorMessages.mode.requestGone
    case 'request-idle':
      return editorMessages.mode.requestIdle
    case 'denied':
    case 'enter-failed':
    case 'enter-lost':
    case 'editor-failed':
    case 'refresh-failed':
    case 'copied':
    case 'idle-released':
    case 'handed-over-tab':
    case 'request-denied':
    case 'request-failed':
    case 'force-denied':
    case 'force-failed':
    case undefined:
      return undefined
  }
}

/**
 * 异常中断的提醒的说法（M3-P5 设计 §3.5、§3.11）：别人的那一代说上一位编辑者（人名经人名组件呈现）的会话异常中断，自己的说你上一次的编辑异常中断。
 * 时刻是服务端的、按页面的时区写成 HH:mm；服务端只在结束之后 30 分钟以内给出它，这段时间跨过了午夜时带日期（formatRecentClockTime：不与浏览器的
 * 时钟比较）
 */
function interruptionText(interruption: EditInterruption): ReactNode {
  const at = formatRecentClockTime(interruption.endedAt, EDIT_INTERRUPTION_NOTICE_SECONDS * 1000)
  return interruption.sameUser ? editorMessages.editing.interruptedSelf(at) : <Phrase parts={editorMessages.editing.interruptedBy(<PersonName person={interruption.holder} />, at)} />
}

/**
 * 进入编辑之后的异常中断的说明（M3-P5 设计 §3.11）：页头下面一条不打断的说明（不是 alert，不新插入 role="status"：读屏的那一句在一直在的状态区里）
 * 与"知道了"（点了说明消失，焦点由 useFocusRescue 交给返回链接）；出现时不移动焦点
 */
function InterruptionNotice({ interruption, onDismiss }: { interruption: EditInterruption, onDismiss: () => void }) {
  return (
    <div data-slot="interruption-notice" className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-2.5 py-2 text-sm text-card-foreground">
      <p className="min-w-0 flex-1">{interruptionText(interruption)}</p>
      <Button size="sm" variant="outline" onClick={onDismiss}>{editorMessages.editing.dismissInterruption}</Button>
    </div>
  )
}

/**
 * 阅读时的说明，放进一直在的读屏状态区（规范 §2.4）：查看者看到的这一版数据不完整（M3-P4 设计 §3.12：能编辑的人与编辑器没有完整载入的
 * 说明在提示条里，DamagedNotice）、谁在编辑（能不能编辑都说：US-M3-04 的"其他人"包括查看者，编辑状态能读就能看；
 * P2 的定期检查会让它变化）、文档读不到了、有更新与正在载入（页头的按钮之外读屏也听得到，审查 A6）、另存为副本成功、
 * 本页显示的这一版"公式待更新"（M3-P4 设计 §3.5 第 4 条：能进入编辑的人另说进入编辑之后会重算并保存）、空闲释放与交出之后为什么回到了阅读、
 * "在此编辑"与请求编辑的进展、请求编辑为什么结束了（M3-P5 设计 §3.6、§3.7、§3.9、§3.11：不新插入 role="status"）
 */
function readingInfo(reading: ReadingMode | undefined, personal: boolean): ReactNode {
  if (reading === undefined)
    return undefined
  const lines: ReactNode[] = []
  // 空闲释放、交给本浏览器的另一个标签页之后（US-M3-07、08）：为什么回到了阅读，放在最前面；交出、请求编辑结束的说明（US-M3-06）同样
  if (reading.notice?.kind === 'idle-released')
    lines.push(<span key="idle">{editorMessages.mode.idleReleased}</span>)
  if (reading.notice?.kind === 'handed-over-tab')
    lines.push(<span key="handed-over">{editorMessages.mode.handedOverTab}</span>)
  const outcome = requestOutcomeNotice(reading, personal)
  if (outcome !== undefined)
    lines.push(<span key="request-outcome">{outcome}</span>)
  if (reading.damaged !== undefined && !reading.canEdit && damageOf(reading.damaged) === 'data')
    lines.push(<span key="damaged">{editorMessages.damaged.viewer}</span>)
  // "在此编辑"进行中、那边没能交出（M3-P5 设计 §3.7），请求编辑在等（§3.6）：说进展，代替谁在编辑的那一句（那一句说的是点了会怎样）
  const takeover = takeoverNotice(reading.takeover)
  const waiting = requestNotice(reading.request)
  if (reading.gone)
    lines.push(<span key="gone">{editorMessages.mode.gone}</span>)
  else if (takeover !== undefined)
    lines.push(<span key="takeover">{takeover}</span>)
  else if (waiting !== undefined)
    lines.push(<span key="request">{waiting}</span>)
  else if (reading.holder !== undefined)
    lines.push(<span key="holder">{elsewhereNotice(reading, reading.holder)}</span>)
  // 本人在别的页面、设备上发出、正在等的请求（审查 B2）：这一页不续期、不撤回、不自动进入，说一句（本页有请求时就是它自己的，不说）
  if (reading.requestedElsewhere && reading.request === undefined && !reading.gone)
    lines.push(<span key="requested-elsewhere">{editorMessages.mode.requestedElsewhere}</span>)
  // 上一位编辑者（别人）异常中断（M3-P5 设计 §3.5：没人在编辑时编辑状态里才有，阅读页不必等点"编辑"）
  if (reading.interruption !== undefined && !reading.gone)
    lines.push(<span key="interruption">{interruptionText(reading.interruption)}</span>)
  if (reading.update !== 'none')
    lines.push(<span key="update">{reading.update === 'loading' ? editorMessages.mode.updating : editorMessages.mode.updateAvailable}</span>)
  if (reading.notice?.kind === 'copied')
    lines.push(<span key="copied"><CopiedNote title={reading.notice.document.title} documentId={reading.notice.document.id} /></span>)
  // 读不到了时不说（之前打开的内容，进入编辑也不可能）；数据不完整时不提进入编辑之后重算（不能进入编辑）
  if (reading.formulasPending && !reading.gone)
    lines.push(<span key="formulas">{editorMessages.mode.formulasPending(reading.canEdit && reading.blocked === undefined && reading.damaged === undefined)}</span>)
  return lines.length === 0 ? undefined : <>{lines.flatMap((line, index) => index === 0 ? [line] : [' ', line])}</>
}

/**
 * 有人请求编辑时页头下面的提示（M3-P5 设计 §3.6）：带标题的分组（role="group"，aria-labelledby 指向"[人名] 请求编辑这份文档"），一行静态说明
 * （不倒计时）与"交出""继续编辑"。不是对话框、不是 alert，不新插入 role="status"（读屏的那一句在一直在的状态区里），出现时不移动焦点。
 * 离开编辑的过程中（leaving：交出、退出、空闲释放）、正在谢绝、正在确认会话时按钮留着、不可用（aria-disabled：焦点不丢），交出时"交出"说正在交出、
 * 谢绝时"继续编辑"标为进行中；上一次交出、谢绝没成时说明原因（没存上的由保存的状态说明）
 */
function RequestPrompt({ page, request, leaving, handingOver, confirming }: { page: EditorPage, request: IncomingRequest, leaving: boolean, handingOver: boolean, confirming: boolean }) {
  const titleId = useId()
  const busy = leaving || request.declining || confirming
  const failure = request.failure
  return (
    <div role="group" aria-labelledby={titleId} data-slot="edit-request-prompt" className="rounded-lg border bg-card px-2.5 py-2 text-sm text-card-foreground">
      <p id={titleId} className="font-medium"><Phrase parts={editorMessages.editing.requestTitle(<PersonName person={request.requester} />)} /></p>
      <p className="text-muted-foreground">{editorMessages.editing.requestNote}</p>
      {failure !== undefined && (
        <p>{failure.action === 'handover' ? editorMessages.editing.handOverFailed(describeError(failure.error).message) : editorMessages.editing.declineFailed(describeError(failure.error).message)}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" aria-disabled={busy} aria-busy={handingOver} onClick={() => void page.handOver()}>
          {handingOver ? editorMessages.editing.handingOver : editorMessages.editing.handOver}
        </Button>
        <Button size="sm" variant="outline" aria-disabled={busy} aria-busy={request.declining} onClick={() => void page.keepEditing()}>
          {editorMessages.editing.keepEditing}
        </Button>
      </div>
    </div>
  )
}

/**
 * 编辑时读屏状态区里的话（M3-P5 设计 §3.5、§3.6、M3-P3）：异常中断的提醒（进入编辑时出现，播一次）、有人请求编辑时的那一句（提示出现时礼貌地播一次）、
 * 请求方取消了请求、快照接近容量上限。只有前两样时视觉隐藏（页头下面的说明与分组里已经写着），有别的时照常显示
 */
function editingInfo(request: IncomingRequest | undefined, notice: EditingNotice | undefined, save: SaveView | undefined, interruption: EditInterruption | undefined): { readonly content: ReactNode, readonly announcementOnly: boolean } {
  const lines: ReactNode[] = []
  if (interruption !== undefined)
    lines.push(<span key="interruption">{interruptionText(interruption)}</span>)
  if (request !== undefined)
    lines.push(<span key="request"><Phrase parts={editorMessages.editing.requestAnnouncement(<PersonName person={request.requester} />)} /></span>)
  const announcements = lines.length
  if (notice !== undefined)
    lines.push(<span key="withdrawn"><Phrase parts={editorMessages.editing.requestWithdrawn(<PersonName person={notice.requester} />)} /></span>)
  const capacity = capacityNote(save)
  if (capacity !== undefined)
    lines.push(<span key="capacity">{capacity}</span>)
  return {
    content: lines.length === 0 ? undefined : <>{lines.flatMap((line, index) => index === 0 ? [line] : [' ', line])}</>,
    announcementOnly: announcements > 0 && lines.length === announcements,
  }
}

/** 向服务端确认会话失败（例如断网时按了保存）：说明原因，页面照旧等本人重新登录（复验 RB7） */
function SessionCheckProblem({ problem }: { problem: unknown }) {
  return problem === undefined ? null : <p>{editorMessages.sessionCheckFailed(describeError(problem).message)}</p>
}

/**
 * 会话不是本人时的提示：编辑时本页的修改还在、登录回来之后照常保存（编辑权随即自动续上，M3-P1）；
 * 别的时候（阅读、失去编辑权）没有要保存的，不提修改与保存（M3-P1 审查 B10）
 */
function SessionNotice({ view, editing }: { view: EditorPageView, editing: boolean }) {
  if (view.session === 'signed-out') {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>{editing ? editorMessages.signedOut : editorMessages.signedOutReadOnly}</p>
          <SessionCheckProblem problem={view.sessionProblem} />
          {/* 在新标签页登录：本页不离开，修改留着；那边登录之后，本页收到消息恢复 */}
          <a href={LOGIN_PATH} target="_blank" rel="noopener" className={buttonVariants({ variant: 'outline', size: 'sm', className: 'mt-2' })}>
            {editorMessages.loginInNewTab}
          </a>
        </AlertDescription>
      </Alert>
    )
  }
  if (view.session === 'other-user') {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>{editing ? editorMessages.otherUser : editorMessages.otherUserReadOnly}</p>
          <SessionCheckProblem problem={view.sessionProblem} />
        </AlertDescription>
      </Alert>
    )
  }
  return null
}

function LoadFailure({ load }: { load: Exclude<EditorPageLoad, { kind: 'loading' | 'ready' }> }) {
  let text: string
  let requestId: string | undefined
  if (load.kind === 'not-found') {
    text = editorMessages.notFound
  }
  else if (load.kind === 'unsupported') {
    text = editorMessages.unsupported
  }
  else if (load.kind === 'editor-failed') {
    text = editorMessages.editorFailed
  }
  else {
    const error = describeError(load.error)
    text = editorMessages.loadFailed(error.message)
    requestId = error.requestId
  }
  return (
    <main className="mx-auto flex max-w-md flex-col items-start gap-3 p-6">
      <Alert variant={load.kind === 'not-found' ? 'default' : 'destructive'}>
        <AlertDescription>
          <p>{text}</p>
          {requestId !== undefined && <p>{messages.common.requestId(requestId)}</p>}
        </AlertDescription>
      </Alert>
      <a href={HOME_PATH} className={buttonVariants({ variant: 'outline' })}>{editorMessages.back}</a>
    </main>
  )
}

/** apple：苹果的平台，保存的快捷键是 Cmd+S，其他平台是 Ctrl+S */
export function EditorChrome({ page, apple }: { page: EditorPage, apple: boolean }) {
  const view = useSyncExternalStore(page.subscribe, page.view)
  const [queryClient] = useState(() => editorQueryClient(page))
  /** 确认框（放弃本页的修改、强制接管）：同一时刻至多一个 */
  const [pending, setPending] = useState<PendingConfirmation>()
  const { load, mode, save } = view
  const ready = load.kind === 'ready' ? load : undefined
  const title = ready?.title
  const back = backLinkOf(ready)
  const backRef = useRef<HTMLAnchorElement>(null)
  /** "强制接管"（M3-P5）：确认框关掉之后焦点交还给它（WebKit 点按钮时焦点不在按钮上，确认框记不下打开者） */
  const forceRef = useRef<HTMLButtonElement>(null)
  // 页头与说明里有焦点的按钮随状态消失、焦点落到 body 时，交给一直在的返回链接（规范 §2.4，审查 A2）：
  // "编辑"随权限消失（403、404、检查时读到不能编辑）、"有更新"在载入或得知没有变化之后、失去编辑权时的"保存""退出编辑"、副本建好之后的按钮
  const rescueFocus = useFocusRescue(backRef)

  useEffect(() => {
    if (title !== undefined)
      document.title = messages.app.pageTitle(title)
  }, [title])

  if (load.kind !== 'loading' && load.kind !== 'ready')
    return <LoadFailure load={load} />

  const reading = ready !== undefined && mode?.kind === 'reading' ? mode : undefined
  const entering = ready !== undefined && mode?.kind === 'entering'
  // 强制接管的进入编辑中（M3-P5）："强制接管"留着、说正在接管
  const forcing = entering && mode.forced === true
  // 文档在个人空间里（M3-P5）：能强制接管的是文档的所有者，说法里不叫空间管理员
  const personal = ready?.space.type === 'personal'
  // 编辑与退出编辑的过程中（先保存再退出）：保存的状态、按钮与说明都在，退出中不卸载
  const editing = ready !== undefined && (mode?.kind === 'editing' || mode?.kind === 'exiting') && save !== undefined ? save : undefined
  const lost = ready !== undefined && mode?.kind === 'lost' ? mode : undefined
  const failure = readingFailure(reading?.notice, personal)
  // 持有者这一侧在等回应的请求编辑（M3-P5）：编辑与离开编辑的过程中有；离开的是交出时提示里的"交出"说正在交出
  const leaving = ready !== undefined && mode?.kind === 'exiting' ? mode : undefined
  const incoming = ready !== undefined && (mode?.kind === 'editing' || mode?.kind === 'exiting') ? mode.request : undefined
  // 进入编辑时申请带回的异常中断的提醒（M3-P5）：编辑与离开编辑的过程中有，"知道了"之后没有
  const interruption = ready !== undefined && (mode?.kind === 'editing' || mode?.kind === 'exiting') ? mode.interruption : undefined
  const info = reading === undefined ? editingInfo(incoming, mode?.kind === 'editing' ? mode.notice : undefined, editing, interruption) : undefined

  /**
   * 强制接管（M3-P5 设计 §3.8）：先确认，说清后果（正在编辑的人、最后活动多久之前，他没保存的修改不会写进来、记入审计）。确认的操作不在弹窗里做：
   * 交回"关掉之后再做的事"——确认框关掉、aria-hidden 解除、焦点交还给"强制接管"之后才开始，进入编辑与没成功时的说明都写在那之后（规范 §2.4）。
   * "强制接管"在弹窗开着时随检查消失了（例如他刚退出编辑），焦点交给返回链接
   */
  function confirmForceTakeOver(holder: LeaseHolder): void {
    const lastActive = holder.lastActiveMinutes === undefined ? undefined : editorMessages.editing.lastActive(holder.lastActiveMinutes)
    setPending({
      title: editorMessages.mode.forceTitle,
      description: editorMessages.mode.forceDescription(messages.people.text(holder.holder), lastActive),
      confirmLabel: editorMessages.mode.forceConfirm,
      destructive: true,
      run: async () => () => void page.forceTakeOver(),
      // 强制接管只改本页（进入编辑），不改哪个列表
      refresh: async () => undefined,
      returnFocus: () => (forceRef.current ?? backRef.current)?.focus(),
    })
  }

  /** 放弃本页的修改：先确认（规范 §2.4 的确认框）；放弃之后这个按钮不在了，焦点交给返回链接 */
  function confirmDiscard(): void {
    setPending({
      title: editorMessages.lost.discardTitle,
      description: editorMessages.lost.discardDescription,
      confirmLabel: editorMessages.lost.discardConfirm,
      destructive: true,
      run: async () => {
        await page.discard()
      },
      // 放弃只改本页（按服务端的最新内容重建），不改哪个列表
      refresh: async () => undefined,
      returnFocus: () => backRef.current?.focus(),
    })
  }

  return (
    <QueryClientProvider client={queryClient}>
      {/* 只为接住焦点包一层（display: contents，不影响布局） */}
      <div ref={rescueFocus} className="contents">
        <header className="flex h-12 items-center gap-3 border-b border-border px-3">
          {/* 回到平台页面是整页跳转（两个入口，P4 设计 §3.8） */}
          <a ref={backRef} href={back.href} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            <ArrowLeft aria-hidden="true" />
            {back.label}
          </a>
          {title !== undefined && <h1 className="min-w-0 truncate text-base font-medium">{title}</h1>}
          <div className="ml-auto flex items-center gap-3">
            {/* 分享（M2-P5）：只在能分享时出现 */}
            {ready !== undefined && <EditorShareEntry page={page} ready={ready} fallbackFocus={() => backRef.current?.focus()} />}
            {/* 看得见的状态（不是播报区：例行的变化只改文字）与读屏的播报区（只播有意义的变化） */}
            <p data-slot="header-status" className="text-sm whitespace-nowrap text-muted-foreground">{headerStatus(view)}</p>
            <SaveAnnouncer view={view} />
            {(reading !== undefined || entering) && <ReadingControls page={page} reading={reading} session={view.session} confirming={view.confirmingSession} forcing={forcing} forceRef={forceRef} onForce={confirmForceTakeOver} />}
            {editing !== undefined && <SaveControls page={page} save={editing} confirming={view.confirmingSession} leaving={mode?.kind === 'exiting' ? mode.cause : undefined} apple={apple} />}
          </div>
        </header>
        {/* 一直在的读屏状态区：阅读时谁在编辑、有更新、请求编辑的进展等；编辑时有人请求编辑的那一句（只有它时视觉隐藏）、请求方取消了、
            快照接近容量上限的说明（不打断，M3-P3、M3-P5） */}
        <StatusRegion className={info?.announcementOnly === true ? 'sr-only' : 'mx-3 mt-2 rounded-lg border bg-card px-2.5 py-2 text-sm text-card-foreground'}>{readingInfo(reading, personal) ?? info?.content}</StatusRegion>
        <div className="flex flex-col gap-2 px-3 empty:hidden [&:not(:empty)]:py-2">
          {/* 上一位编辑者异常中断（M3-P5）：进入编辑之后页头下面一条不打断的说明，"知道了"之后、离开编辑时消失 */}
          {interruption !== undefined && <InterruptionNotice interruption={interruption} onDismiss={page.dismissInterruption} />}
          {/* 有人请求编辑（M3-P5）：页头下面的提示，不移动焦点、不挂屏障 */}
          {incoming !== undefined && <RequestPrompt page={page} request={incoming} leaving={leaving !== undefined} handingOver={leaving?.cause === 'handover-request'} confirming={view.confirmingSession} />}
          {/* 一直渲染（没有问题时什么也不画）：重试成功、说明连同"重试"一起消失时它才能把焦点交给返回链接（DEF-040） */}
          <DetailRefreshProblem
            query={{ isRefetchError: view.detailProblem !== undefined, isRefetching: view.detailRefreshing, error: view.detailProblem, refetch: page.refreshDetail }}
            detail={editorMessages.detail}
            fallbackFocus={backRef}
          />
          {failure !== undefined && (
            <Alert variant="destructive">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}
          {/* 打开自检失败（M3-P4）：编辑器没有完整载入，或者能编辑的人看到的这一版数据不完整 */}
          {reading?.damaged !== undefined && <DamagedNotice failures={reading.damaged} canEdit={reading.canEdit} onReload={page.reload} />}
          {/* 阅读时与服务端不兼容（M3-P3）：打开时就看得出、申请编辑权时得知，或者编辑时得知之后退出了编辑 */}
          {reading?.blocked !== undefined && <IncompatibleNotice kind={reading.blocked} editing={undefined} onReload={page.reload} />}
          {lost !== undefined && <LostNotice page={page} lost={lost} personal={personal} onDiscard={confirmDiscard} fallbackFocus={backRef} />}
          {/* 版本冲突之后本页不能再保存：会话的提示（"登录之后回到这里保存"）不成立，只显示冲突的说明（复验 SB9；换了人时那条说明里另有一句，复验 TB8）；
              读不到了（404）之后没有要做的事，不提登录 */}
          {editing?.conflict === undefined && !(lost !== undefined && !lost.readable) && <SessionNotice view={view} editing={editing !== undefined} />}
          {editing !== undefined && <SaveNotices view={view} save={editing} onReload={page.reload} />}
        </div>
      </div>
      <ConfirmDialog pending={pending} onClose={() => setPending(undefined)} />
    </QueryClientProvider>
  )
}
