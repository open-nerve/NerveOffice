import type { PreviewState } from './preview-controller.ts'
import { historyPagePath } from '@nerve-office/contracts'
import { describeError } from '../../shared/api/index.ts'
import { historyMessages as text } from '../../shared/i18n/zh-cn/history.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { loginPath } from '../../shared/lib/login-path.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { Alert, AlertDescription, Button, buttonVariants, PersonName, RetryButton } from '../../shared/ui/index.ts'

export function PreviewChrome({ state, documentId, pathname, imageProblem, retry }: { state: PreviewState, documentId: string | undefined, pathname: string, imageProblem: boolean, retry: () => void }) {
  useDocumentTitle(state.kind === 'ready' ? `${state.history.title} · ${text.previewTitle}` : text.previewTitle)
  return (
    <header className="space-y-2 border-b border-border p-3">
      <div className="flex flex-wrap items-center gap-3">
        {documentId !== undefined && <a href={historyPagePath(documentId)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{text.historyList}</a>}
        <h1 className="text-base font-semibold">{text.previewTitle}</h1>
        {state.kind === 'ready' && (
          <span>
            {state.history.title}
            {' '}
            ·
            {' '}
            {text.revision(state.history.revision)}
            {' '}
            ·
            {' '}
            {formatDateTime(state.history.savedAt)}
          </span>
        )}
        {state.kind === 'ready' && state.history.savedBy !== null && <PersonName person={state.history.savedBy} />}
      </div>
      <p className="text-sm text-muted-foreground">{text.previewReadOnly}</p>
      {state.kind === 'loading' && <p role="status">{text.previewLoading}</p>}
      {state.kind === 'unavailable' && <Alert variant="destructive"><AlertDescription>{text.unavailable}</AlertDescription></Alert>}
      {(state.kind === 'unsupported' || state.kind === 'unusable') && <Alert variant="destructive"><AlertDescription>{state.kind === 'unsupported' ? text.unsupported : text.previewUnusable}</AlertDescription></Alert>}
      {state.kind === 'failed' && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{describeError(state.error).message}</p>
            <RetryButton retrying={false} onRetry={retry} />
          </AlertDescription>
        </Alert>
      )}
      {state.kind === 'signed-out' && (
        <p role="alert">
          {text.signedOut}
          {' '}
          <a href={loginPath(pathname, 'expired')} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{text.login}</a>
        </p>
      )}
      {state.kind === 'changed-user' && (
        <p role="alert">
          {text.sessionChanged}
          {' '}
          <a href={pathname} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{text.reopen}</a>
        </p>
      )}
      {state.kind === 'ready' && imageProblem && (
        <p role="status">
          {text.imageFailed}
          {' '}
          <Button variant="outline" size="sm" onClick={retry}>{text.reopen}</Button>
        </p>
      )}
    </header>
  )
}
