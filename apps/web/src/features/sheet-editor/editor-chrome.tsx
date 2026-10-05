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
// 编辑器本身挂在页头之外的容器里（editor.html 的 #sheet-editor），不归 React 管。
import type { SnapshotRule } from '@nerve-office/contracts'
import type { ReactNode, RefObject } from 'react'
import type { Phrase as PhraseParts } from '../../shared/i18n/index.ts'
import type { PendingConfirmation } from '../confirmation/index.ts'
import type { Incompatibility } from './client-format.ts'
import type { LeaseHolder, LeaseLoss } from './edit-lease.ts'
import type { CopyState, LostMode, ReadingMode, ReadingNotice } from './edit-mode.ts'
import type { EditorPage, EditorPageLoad, EditorPageReady, EditorPageSession, EditorPageView } from './editor-page.ts'
import type { SaveProblem, SaveView } from './save-coordinator.ts'
import { documentPagePath, SNAPSHOT_MAX_RAW_BYTES, SNAPSHOT_WARN_RAW_BYTES, snapshotInvalidDetailsSchema } from '@nerve-office/contracts'
import { QueryClientProvider } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ApiError, describeError, isAuthenticationError, isCsrfTokenError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'
import { LOGIN_PATH } from '../../shared/lib/login-path.ts'
import { HOME_PATH, SHARED_PATH, spacePath } from '../../shared/lib/space-paths.ts'
import { focusIsLost } from '../../shared/lib/use-focus-hand-off.ts'
import { useFocusRescue } from '../../shared/lib/use-focus-rescue.ts'
import { Alert, AlertDescription, Button, buttonVariants, PersonName, Phrase } from '../../shared/ui/index.ts'
import { DetailRefreshProblem } from '../../shared/ui/refresh-problem.tsx'
import { StatusRegion } from '../../shared/ui/status-region.tsx'
import { ConfirmDialog } from '../confirmation/index.ts'
import { editorQueryClient } from './editor-query-client.ts'
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

/**
 * 页头的状态（一直在的 role="status"，模式切换、保存状态的变化随之播报）。显式写 aria-live（语义不变：role="status" 本来就是 polite，
 * M2-P5 复验第二轮 G1）：保存在后台进行，分享对话框（模态）开着时也会完成或失败；Radix 的模态弹窗打开时把弹窗之外的内容都标为
 * aria-hidden，只跳过那一刻已经在的、显式写了 aria-live 的元素（aria-hidden 库的 hideOthers）
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
      // 与服务端不兼容（M3-P3）：本页过旧时需要刷新；文档由更新的版本保存过时只能查看
      if (mode.blocked === 'client-outdated')
        return editorMessages.status.outdated
      return mode.canEdit && mode.blocked === undefined ? '' : editorMessages.status.readOnly
    case 'entering':
      return editorMessages.mode.entering
    case 'editing':
      if (view.confirmingSession)
        return messages.auth.checkingSession
      return save === undefined ? '' : editorMessages.status[save.status]
    case 'exiting':
      return editorMessages.mode.exiting
    case 'losing':
      return editorMessages.mode.losing
    case 'lost':
      return editorMessages.status.leaseLost
    case 'failed':
    case 'unavailable':
      return ''
  }
}

/**
 * 编辑时（与退出编辑的过程中）页头里能做的事。不可用一律用 aria-disabled：按钮变成 disabled 时焦点会丢（审查 B13），重复点击由
 * 保存的状态机、页面挡住。退出中两个按钮都留着（"退出编辑"说正在退出）：没有退出成功（保存失败、公式没收齐）时焦点还在它上面（审查 A2）
 */
function SaveControls({ page, save, confirming, exiting, apple }: { page: EditorPage, save: SaveView, confirming: boolean, exiting: boolean, apple: boolean }) {
  return (
    <>
      <Button
        size="sm"
        aria-disabled={!save.canSave || confirming || exiting}
        aria-busy={confirming}
        aria-keyshortcuts={apple ? 'Meta+S' : 'Control+S'}
        title={editorMessages.saveShortcut(apple ? '⌘S' : 'Ctrl+S')}
        onClick={() => void page.save()}
      >
        {editorMessages.save}
      </Button>
      {/* 退出编辑：先保存（没存上就留在编辑，说明由保存的状态给出），释放编辑权，回到阅读 */}
      <Button size="sm" variant="outline" aria-disabled={confirming || exiting} aria-busy={exiting} onClick={() => void page.exitEditing()}>
        {exiting ? editorMessages.mode.exiting : editorMessages.mode.exit}
      </Button>
    </>
  )
}

/**
 * 阅读时（与进入编辑的过程中）页头里能做的事："有更新，点击刷新"；"编辑"（能编辑、还读得到时）。reading 为 undefined 是进入编辑中：
 * "编辑"留着、说正在进入，没有进入成功（被占用、网络失败）时焦点还在它上面（审查 A2）。正在载入最新的版本时（审查 A1）、会话不是本人时
 * （审查 A10）"编辑"不可用；点了由页面挡住，或者先向服务端确认会话。确认会话期间（confirming）"编辑"不可用、标为进行中，文字不变，
 * 页头的状态说正在确认登录状态——与按保存时的确认同一个做法，确认之后进入编辑时才说正在进入（复验 C8）
 */
function ReadingControls({ page, reading, session, confirming }: { page: EditorPage, reading: ReadingMode | undefined, session: EditorPageSession, confirming: boolean }) {
  const entering = reading === undefined
  const update = reading?.update ?? 'none'
  // 与服务端不兼容（M3-P3）时不给"编辑"：申请也会被拒，重新加载才是新的页面
  const offersEdit = reading === undefined || (reading.canEdit && !reading.gone && reading.blocked === undefined)
  return (
    <>
      {update !== 'none' && (
        <Button size="sm" variant="outline" aria-disabled={update === 'loading'} onClick={() => void page.refreshUpdate()}>
          {update === 'loading' ? editorMessages.mode.updating : editorMessages.mode.update}
        </Button>
      )}
      {offersEdit && (
        <Button size="sm" aria-disabled={entering || confirming || update === 'loading' || session !== 'active'} aria-busy={entering || confirming} onClick={() => void page.enterEditing()}>
          {entering ? editorMessages.mode.entering : editorMessages.mode.enter}
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
  // 会话不是本人时本页不能保存，"稍后再保存一次"不成立（复验 SB9）；与服务端不兼容之后同样不成立
  if (save.formulasPending && save.status !== 'saving' && session === 'active' && block === undefined) {
    notices.push(
      <Alert key="formulas">
        <AlertDescription>{editorMessages.formulasPending}</AlertDescription>
      </Alert>,
    )
  }
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
 * 续上时别处正在编辑；续上时发现别处保存过更新的版本
 */
function lostCause(loss: LeaseLoss): PhraseParts<ReactNode> | undefined {
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
function LostNotice({ page, lost, onDiscard, fallbackFocus }: { page: EditorPage, lost: LostMode, onDiscard: () => void, fallbackFocus: RefObject<HTMLElement | null> }) {
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
          : <p><Phrase parts={editorMessages.editing.lost(lostCause(loss), unsaved && copied === undefined, readable, !reopenFailed, refused === undefined)} /></p>}
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

/** 阅读时上一次操作没有成功的说明（另存为副本成功的说明在读屏状态区里） */
function readingFailure(notice: ReadingNotice | undefined): ReactNode {
  switch (notice?.kind) {
    case 'denied':
      return editorMessages.mode.denied(describeError(notice.error).message)
    case 'enter-failed':
      return editorMessages.mode.enterFailed(describeError(notice.error).message)
    case 'enter-lost':
      return <Phrase parts={editorMessages.mode.enterLost(lostCause(notice.loss))} />
    case 'editor-failed':
      return editorMessages.mode.editorFailed
    case 'refresh-failed':
      return editorMessages.mode.refreshFailed(describeError(notice.error).message)
    // 另存为副本成功的说明在读屏状态区里（readingInfo）
    case 'copied':
    case undefined:
      return undefined
  }
}

/**
 * 别处正在编辑时的说明（M3-P1 设计 §3.4.7）：谁在编辑（人名经人名组件）、最后活动几分钟之前；能编辑的人另说现在只能阅读。
 * 是自己、而且现在能编辑时说在另一个标签页或设备上（到时再点"编辑"就能编辑）——本页刚退出编辑、没能确认放掉编辑权时多半就是本页那一代，
 * 照实说（releaseUnconfirmed，审查 A13）；不能编辑了时自己那一代已经失效（持有者要能编辑），只是还没读到新的编辑状态，
 * 照别人一样说谁在编辑，不提"再点编辑"。与服务端不兼容的阅读（blocked）不给"编辑"，同样不提（M3-P3 审查 B8：停住续租之后退出编辑，
 * 那次释放没送到时这里也说本页刚退出）
 */
function elsewhereNotice(holder: LeaseHolder | undefined, canEdit: boolean, releaseUnconfirmed: boolean, blocked: boolean): ReactNode {
  if (holder === undefined)
    return editorMessages.editing.elsewhereUnknown
  if (holder.sameUser && canEdit)
    return releaseUnconfirmed ? editorMessages.editing.elsewhereThisPage(!blocked) : editorMessages.editing.elsewhereBySelf(!blocked)
  const lastActive = holder.lastActiveMinutes === undefined ? undefined : editorMessages.editing.lastActive(holder.lastActiveMinutes)
  return <Phrase parts={editorMessages.editing.elsewhere(<PersonName person={holder.holder} />, lastActive, canEdit)} />
}

/**
 * 阅读时的说明，放进一直在的读屏状态区（规范 §2.4）：谁在编辑（能不能编辑都说：US-M3-04 的"其他人"包括查看者，编辑状态能读就能看；
 * P2 的定期检查会让它变化）、文档读不到了、有更新与正在载入（页头的按钮之外读屏也听得到，审查 A6）、另存为副本成功
 */
function readingInfo(reading: ReadingMode | undefined): ReactNode {
  if (reading === undefined)
    return undefined
  const lines: ReactNode[] = []
  if (reading.gone)
    lines.push(<span key="gone">{editorMessages.mode.gone}</span>)
  else if (reading.holder !== undefined)
    lines.push(<span key="holder">{elsewhereNotice(reading.holder, reading.canEdit, reading.releaseUnconfirmed, reading.blocked !== undefined)}</span>)
  if (reading.update !== 'none')
    lines.push(<span key="update">{reading.update === 'loading' ? editorMessages.mode.updating : editorMessages.mode.updateAvailable}</span>)
  if (reading.notice?.kind === 'copied')
    lines.push(<span key="copied"><CopiedNote title={reading.notice.document.title} documentId={reading.notice.document.id} /></span>)
  return lines.length === 0 ? undefined : <>{lines.flatMap((line, index) => index === 0 ? [line] : [' ', line])}</>
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
  const [pendingDiscard, setPendingDiscard] = useState<PendingConfirmation>()
  const { load, mode, save } = view
  const ready = load.kind === 'ready' ? load : undefined
  const title = ready?.title
  const back = backLinkOf(ready)
  const backRef = useRef<HTMLAnchorElement>(null)
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
  // 编辑与退出编辑的过程中（先保存再退出）：保存的状态、按钮与说明都在，退出中不卸载
  const editing = ready !== undefined && (mode?.kind === 'editing' || mode?.kind === 'exiting') && save !== undefined ? save : undefined
  const lost = ready !== undefined && mode?.kind === 'lost' ? mode : undefined
  const failure = readingFailure(reading?.notice)

  /** 放弃本页的修改：先确认（规范 §2.4 的确认框）；放弃之后这个按钮不在了，焦点交给返回链接 */
  function confirmDiscard(): void {
    setPendingDiscard({
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
            <p role="status" aria-live="polite" className="text-sm whitespace-nowrap text-muted-foreground">{headerStatus(view)}</p>
            {(reading !== undefined || entering) && <ReadingControls page={page} reading={reading} session={view.session} confirming={view.confirmingSession} />}
            {editing !== undefined && <SaveControls page={page} save={editing} confirming={view.confirmingSession} exiting={mode?.kind === 'exiting'} apple={apple} />}
          </div>
        </header>
        {/* 一直在的读屏状态区：阅读时谁在编辑、有更新等；编辑时快照接近容量上限的说明（不打断，M3-P3） */}
        <StatusRegion className="mx-3 mt-2 rounded-lg border bg-card px-2.5 py-2 text-sm text-card-foreground">{readingInfo(reading) ?? capacityNote(editing)}</StatusRegion>
        <div className="flex flex-col gap-2 px-3 empty:hidden [&:not(:empty)]:py-2">
          {/* 一直渲染（没有问题时什么也不画）：重试成功、说明连同"重试"一起消失时它才能把焦点交给返回链接（DEF-040） */}
          <DetailRefreshProblem
            query={{ isRefetchError: view.detailProblem !== undefined, error: view.detailProblem, refetch: page.refreshDetail }}
            detail={editorMessages.detail}
            fallbackFocus={backRef}
          />
          {failure !== undefined && (
            <Alert variant="destructive">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}
          {/* 阅读时与服务端不兼容（M3-P3）：打开时就看得出、申请编辑权时得知，或者编辑时得知之后退出了编辑 */}
          {reading?.blocked !== undefined && <IncompatibleNotice kind={reading.blocked} editing={undefined} onReload={page.reload} />}
          {lost !== undefined && <LostNotice page={page} lost={lost} onDiscard={confirmDiscard} fallbackFocus={backRef} />}
          {/* 版本冲突之后本页不能再保存：会话的提示（"登录之后回到这里保存"）不成立，只显示冲突的说明（复验 SB9；换了人时那条说明里另有一句，复验 TB8）；
              读不到了（404）之后没有要做的事，不提登录 */}
          {editing?.conflict === undefined && !(lost !== undefined && !lost.readable) && <SessionNotice view={view} editing={editing !== undefined} />}
          {editing !== undefined && <SaveNotices view={view} save={editing} onReload={page.reload} />}
        </div>
      </div>
      <ConfirmDialog pending={pendingDiscard} onClose={() => setPendingDiscard(undefined)} />
    </QueryClientProvider>
  )
}
