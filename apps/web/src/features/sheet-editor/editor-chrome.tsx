// 编辑器页的页头与提示（P4 设计 §3.7.3）：返回文档所在的空间（M2-P2 设计 §3.10；只凭授权时回"与我共享"，M2-P5）、标题、
// 分享的入口（M2-P5）、保存状态（role="status"）、保存按钮；载入与保存的各种结果。
// 编辑器本身挂在页头之外的容器里（editor.html 的 #sheet-editor），不归 React 管。
import type { ReactNode } from 'react'
import type { EditorPage, EditorPageLoad, EditorPageReady, EditorPageView } from './editor-page.ts'
import type { SaveProblem, SaveView } from './save-coordinator.ts'
import { ArrowLeft } from 'lucide-react'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { ApiError, describeError, isAuthenticationError, isCsrfTokenError, isNotFoundError, isPermissionDeniedError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'
import { LOGIN_PATH } from '../../shared/lib/login-path.ts'
import { HOME_PATH, SHARED_PATH, spacePath } from '../../shared/lib/space-paths.ts'
import { Alert, AlertDescription, Button, buttonVariants } from '../../shared/ui/index.ts'
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
  const error = describeError(problem.error)
  // 文档被删除、移走或失去权限之后（M2 总设计 A14，M2-P6 复核 S8）：再保存也存不进去了，说清楚本页的修改没有保存、
  // 需要的话先复制出来。看不到了（404）与能看却不能改（403，原因由服务端给出，例如空间已归档）分开说。
  // 只认 404：400（请求不合法）是这次请求本身的问题，不说成"已经被删除、移走"（M2-P6 复核第二批 G-5）
  if (isNotFoundError(problem.error))
    return { text: editorMessages.saveFailed(editorMessages.saveGone), requestId: error.requestId, destructive: true }
  if (isPermissionDeniedError(problem.error))
    return { text: editorMessages.saveFailed(editorMessages.saveDenied(error.message)), requestId: error.requestId, destructive: true }
  return { text: editorMessages.saveFailed(error.message), requestId: error.requestId, destructive: true }
}

function SaveControls({ save, confirming, onSave, apple }: { save: SaveView, confirming: boolean, onSave: () => void, apple: boolean }) {
  return (
    <>
      {/* 按了保存、正在向服务端确认会话：说明正在确认，而不是看起来没有反应（复验 SB5）。
          显式写 aria-live（语义不变：role="status" 本来就是 polite，M2-P5 复验第二轮 G1）：保存在后台进行，分享对话框（模态）开着时
          也会完成或失败。Radix 的模态弹窗打开时把弹窗之外的内容都标为 aria-hidden，只跳过那一刻已经在的、显式写了 aria-live 的元素
          （aria-hidden 库的 hideOthers）；只有隐含的 live 时，"已保存到云端""保存失败"写进去的那一刻在 aria-hidden 之下，读屏不播报。
          能打开分享对话框时它一定已经在（页头就绪时保存状态机先于 ready 建好；只读的文档没有保存，也就没有它）。
          保存失败的详细说明（下面的提示条，role="alert"）随失败插入：对话框开着时它在 aria-hidden 之下，但这里会播报"保存失败"，
          对话框关掉之后详细说明读得到，不另做机制 */}
      <p role="status" aria-live="polite" className="text-sm whitespace-nowrap text-muted-foreground">{confirming ? messages.auth.checkingSession : editorMessages.status[save.status]}</p>
      {/* 保存中用 aria-disabled：按钮变成 disabled 时焦点会丢（审查 B13）；重复点击由保存的状态机挡住 */}
      <Button
        size="sm"
        aria-disabled={!save.canSave || confirming}
        aria-busy={confirming}
        aria-keyshortcuts={apple ? 'Meta+S' : 'Control+S'}
        title={editorMessages.saveShortcut(apple ? '⌘S' : 'Ctrl+S')}
        onClick={onSave}
      >
        {editorMessages.save}
      </Button>
    </>
  )
}

function SaveNotices({ view, save, onReload }: { view: EditorPageView, save: SaveView, onReload: () => void }) {
  const { session } = view
  const notices: ReactNode[] = []
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
  // 会话不是本人时本页不能保存，"稍后再保存一次"不成立（复验 SB9）
  if (save.formulasPending && save.status !== 'saving' && session === 'active') {
    notices.push(
      <Alert key="formulas">
        <AlertDescription>{editorMessages.formulasPending}</AlertDescription>
      </Alert>,
    )
  }
  return notices
}

/** 向服务端确认会话失败（例如断网时按了保存）：说明原因，页面照旧等本人重新登录（复验 RB7） */
function SessionCheckProblem({ problem }: { problem: unknown }) {
  return problem === undefined ? null : <p>{editorMessages.sessionCheckFailed(describeError(problem).message)}</p>
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
  const { load, save } = view
  const ready = load.kind === 'ready' ? load : undefined
  const title = ready?.title
  const back = backLinkOf(ready)
  const backRef = useRef<HTMLAnchorElement>(null)

  useEffect(() => {
    if (title !== undefined)
      document.title = messages.app.pageTitle(title)
  }, [title])

  if (load.kind !== 'loading' && load.kind !== 'ready')
    return <LoadFailure load={load} />

  return (
    <>
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
          {load.kind === 'loading' && <p role="status" className="text-sm text-muted-foreground">{editorMessages.loading}</p>}
          {load.kind === 'ready' && load.readOnly && <p className="text-sm text-muted-foreground">{editorMessages.status.readOnly}</p>}
          {save !== undefined && <SaveControls save={save} confirming={view.confirmingSession} apple={apple} onSave={() => void page.save()} />}
        </div>
      </header>
      {(view.session !== 'active' || save !== undefined) && (
        <div className="flex flex-col gap-2 px-3 empty:hidden [&:not(:empty)]:py-2">
          {/* 版本冲突之后本页不能再保存：会话的提示（"登录之后回到这里保存"）不成立，只显示冲突的说明（复验 SB9；换了人时冲突的说明里另有一句，复验 TB8） */}
          {view.session === 'signed-out' && save?.conflict === undefined && (
            <Alert variant="destructive">
              <AlertDescription>
                <p>{editorMessages.signedOut}</p>
                <SessionCheckProblem problem={view.sessionProblem} />
                {/* 在新标签页登录：本页不离开，修改留着；那边登录之后，本页收到消息恢复保存 */}
                <a href={LOGIN_PATH} target="_blank" rel="noopener" className={buttonVariants({ variant: 'outline', size: 'sm', className: 'mt-2' })}>
                  {editorMessages.loginInNewTab}
                </a>
              </AlertDescription>
            </Alert>
          )}
          {view.session === 'other-user' && save?.conflict === undefined && (
            <Alert variant="destructive">
              <AlertDescription>
                <p>{editorMessages.otherUser}</p>
                <SessionCheckProblem problem={view.sessionProblem} />
              </AlertDescription>
            </Alert>
          )}
          {save !== undefined && <SaveNotices view={view} save={save} onReload={page.reload} />}
        </div>
      )}
    </>
  )
}
