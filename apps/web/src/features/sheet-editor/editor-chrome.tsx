// 编辑器页的页头与提示（P4 设计 §3.7.3）：返回我的空间、标题、保存状态（role="status"）、保存按钮；载入与保存的各种结果。
// 编辑器本身挂在页头之外的容器里（editor.html 的 #sheet-editor），不归 React 管。
import type { ReactNode } from 'react'
import type { EditorPage, EditorPageLoad } from './editor-page.ts'
import type { SaveProblem, SaveView } from './save-coordinator.ts'
import { ArrowLeft } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import { ApiError, describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { Alert, AlertDescription, Button, buttonVariants } from '../../shared/ui/index.ts'

const HOME = '/'

function problemMessage(problem: SaveProblem): { text: string, requestId?: string, destructive: boolean } {
  if (problem.kind === 'cell-editing')
    return { text: messages.editor.finishCellEditing, destructive: false }
  if (problem.kind === 'too-large' || (problem.error instanceof ApiError && problem.error.code === 'PAYLOAD_TOO_LARGE'))
    return { text: messages.editor.tooLarge, destructive: true }
  const error = describeError(problem.error)
  return { text: messages.editor.saveFailed(error.message), requestId: error.requestId, destructive: true }
}

function SaveControls({ save, onSave, apple }: { save: SaveView, onSave: () => void, apple: boolean }) {
  return (
    <>
      <p role="status" className="text-sm whitespace-nowrap text-muted-foreground">{messages.editor.status[save.status]}</p>
      {/* 保存中用 aria-disabled：按钮变成 disabled 时焦点会丢（审查 B13）；重复点击由保存的状态机挡住 */}
      <Button
        size="sm"
        aria-disabled={!save.canSave}
        aria-keyshortcuts={apple ? 'Meta+S' : 'Control+S'}
        title={messages.editor.saveShortcut(apple ? '⌘S' : 'Ctrl+S')}
        onClick={onSave}
      >
        {messages.editor.save}
      </Button>
    </>
  )
}

function SaveNotices({ save, onReload }: { save: SaveView, onReload: () => void }) {
  const notices: ReactNode[] = []
  if (save.conflict !== undefined) {
    notices.push(
      <Alert key="conflict" variant="destructive">
        <AlertDescription>
          <p>{messages.editor.conflict}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={onReload}>{messages.editor.reload}</Button>
        </AlertDescription>
      </Alert>,
    )
  }
  if (save.problem !== undefined) {
    const problem = problemMessage(save.problem)
    notices.push(
      <Alert key="problem" variant={problem.destructive ? 'destructive' : 'default'}>
        <AlertDescription>
          <p>{problem.text}</p>
          {problem.requestId !== undefined && <p>{messages.common.requestId(problem.requestId)}</p>}
        </AlertDescription>
      </Alert>,
    )
  }
  if (save.formulasPending && save.status !== 'saving') {
    notices.push(
      <Alert key="formulas">
        <AlertDescription>{messages.editor.formulasPending}</AlertDescription>
      </Alert>,
    )
  }
  return notices
}

function LoadFailure({ load }: { load: Exclude<EditorPageLoad, { kind: 'loading' | 'ready' }> }) {
  let text: string
  let requestId: string | undefined
  if (load.kind === 'not-found') {
    text = messages.editor.notFound
  }
  else if (load.kind === 'unsupported') {
    text = messages.editor.unsupported
  }
  else if (load.kind === 'editor-failed') {
    text = messages.editor.editorFailed
  }
  else {
    const error = describeError(load.error)
    text = messages.editor.loadFailed(error.message)
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
      <a href={HOME} className={buttonVariants({ variant: 'outline' })}>{messages.editor.back}</a>
    </main>
  )
}

/** apple：苹果的平台，保存的快捷键是 Cmd+S，其他平台是 Ctrl+S */
export function EditorChrome({ page, apple }: { page: EditorPage, apple: boolean }) {
  const view = useSyncExternalStore(page.subscribe, page.view)
  const { load, save } = view
  const title = load.kind === 'ready' ? load.title : undefined

  useEffect(() => {
    if (title !== undefined)
      document.title = messages.editor.pageTitle(title)
  }, [title])

  if (load.kind !== 'loading' && load.kind !== 'ready')
    return <LoadFailure load={load} />

  return (
    <>
      <header className="flex h-12 items-center gap-3 border-b border-border px-3">
        {/* 回到平台页面是整页跳转（两个入口，P4 设计 §3.8） */}
        <a href={HOME} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          <ArrowLeft aria-hidden="true" />
          {messages.editor.back}
        </a>
        {title !== undefined && <h1 className="min-w-0 truncate text-base font-medium">{title}</h1>}
        <div className="ml-auto flex items-center gap-3">
          {load.kind === 'loading' && <p role="status" className="text-sm text-muted-foreground">{messages.editor.loading}</p>}
          {load.kind === 'ready' && load.readOnly && <p className="text-sm text-muted-foreground">{messages.editor.status.readOnly}</p>}
          {save !== undefined && <SaveControls save={save} apple={apple} onSave={() => void page.save()} />}
        </div>
      </header>
      {(view.sessionChanged || save !== undefined) && (
        <div className="flex flex-col gap-2 px-3 empty:hidden [&:not(:empty)]:py-2">
          {view.sessionChanged && (
            <Alert variant="destructive">
              <AlertDescription>{messages.editor.sessionChanged}</AlertDescription>
            </Alert>
          )}
          {save !== undefined && <SaveNotices save={save} onReload={page.reload} />}
        </div>
      )}
    </>
  )
}
