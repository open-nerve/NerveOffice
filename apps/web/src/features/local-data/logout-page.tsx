import type { SessionResponse } from '@nerve-office/contracts'
import type { LogoutFlow, LogoutLocal } from '../../shared/local-drafts/logout-flow.ts'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isAuthenticationError } from '../../shared/api/index.ts'
import { localDataMessages as text } from '../../shared/i18n/zh-cn/local-data.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { LOCAL_DRAFTS_PATH } from '../../shared/lib/local-drafts-path.ts'
import { LOGIN_PATH } from '../../shared/lib/login-path.ts'
import { usePageLocation } from '../../shared/lib/page-location.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { useFocusRescue } from '../../shared/lib/use-focus-rescue.ts'
import { Button, buttonVariants, PersonName } from '../../shared/ui/index.ts'
import { StatusRegion } from '../../shared/ui/status-region.tsx'
import { fetchSession } from '../auth/index.ts'

function localTime(at: number | undefined): string {
  const date = at === undefined ? undefined : new Date(at)
  return date === undefined || !Number.isFinite(date.getTime()) ? text.unknownTime : text.updated(formatDateTime(date.toISOString()))
}

function localResult(local: LogoutLocal): string | undefined {
  switch (local.kind) {
    case 'cleared': return text.localCleared
    case 'pending': return text.localPending
    case 'unconfirmed': return text.localUnconfirmed
    case 'failed':
    case 'unavailable':
    case 'quota': return text.localFailed
    case 'idle':
    case 'invalidated': return undefined
  }
}

/** 只有预览阶段显示账户与草稿；确认后只保留两侧结果，不挂载旧工作区。 */
export function LogoutContent({ flow, session }: { readonly flow: LogoutFlow, readonly session: SessionResponse }) {
  const state = useSyncExternalStore(flow.subscribe, flow.view)
  const page = usePageLocation()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const rescue = useFocusRescue(headingRef)
  const leftRef = useRef(false)
  useDocumentTitle(text.title)
  useEffect(() => {
    if (!leftRef.current && state.stage === 'result' && state.busy === undefined && state.local.kind === 'cleared' && state.server.kind === 'ended') {
      leftRef.current = true
      page.replace(LOGIN_PATH)
    }
  }, [state, page])
  const busy = state.busy !== undefined
  const preview = state.preview
  return (
    <main ref={rescue} className="mx-auto max-w-xl space-y-5 px-4 py-8 break-words">
      <h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold">{text.title}</h1>
      <StatusRegion className="text-sm text-muted-foreground">{busy ? state.busy === 'preview' ? text.checking : text.working : undefined}</StatusRegion>
      {state.stage === 'ready' && (
        <section className="space-y-4" aria-busy={busy}>
          <PersonName person={session.user} className="font-medium" />
          <p>{text.scope}</p>
          <p className="text-sm text-muted-foreground">{text.warning}</p>
          {(preview?.kind !== 'listed' || preview.incomplete) && <p role="alert">{text.incomplete}</p>}
          {preview?.kind === 'listed' && (
            preview.entries.length > 0
              ? (
                  <ul className="divide-y rounded-md border px-3">
                    {preview.entries.map(entry => (
                      <li key={entry.documentId} className="space-y-1 py-3">
                        <p>{entry.title ?? text.unknownTitle}</p>
                        <p className="text-sm text-muted-foreground">{localTime(entry.updatedAt)}</p>
                      </li>
                    ))}
                  </ul>
                )
              : !preview.incomplete && <p>{text.empty}</p>
          )}
          <a href={LOCAL_DRAFTS_PATH} className={buttonVariants({ variant: 'link' })}>{text.drafts}</a>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              onClick={() => {
                flow.dispose()
                page.assign('/')
              }}
            >
              {text.cancel}
            </Button>
            <Button variant="destructive" aria-disabled={busy} onClick={() => void flow.confirm()}>{text.confirm}</Button>
          </div>
        </section>
      )}
      {state.stage === 'result' && (
        <section className="space-y-4" aria-busy={busy}>
          <StatusRegion>{state.server.kind === 'ended' ? text.serverEnded : state.server.kind === 'unknown' ? text.serverUnknown : undefined}</StatusRegion>
          <StatusRegion>{localResult(state.local)}</StatusRegion>
          <div className="flex flex-wrap gap-3">
            {(state.canRetry || state.busy === 'retry') && <Button aria-disabled={busy} onClick={() => void flow.retry()}>{text.retry}</Button>}
            <a href={LOGIN_PATH} className={buttonVariants({ variant: 'outline' })}>{text.login}</a>
          </div>
        </section>
      )}
      {state.stage === 'invalidated' && (
        <section className="space-y-4">
          <p role="alert">{text.invalidated}</p>
          <Button onClick={page.reload}>{text.repreview}</Button>
          <a href={LOGIN_PATH} className={buttonVariants({ variant: 'outline' })}>{text.login}</a>
        </section>
      )}
    </main>
  )
}

/** 公开结果页只在进入时实际查询；重试退出不查询/采纳新登录。 */
export function LogoutPage() {
  const queryClient = useQueryClient()
  const page = usePageLocation()
  const [loaded, setLoaded] = useState<{ readonly session: SessionResponse, readonly flow: LogoutFlow }>()
  const [problem, setProblem] = useState<'ended' | 'unknown'>()
  useDocumentTitle(text.title)
  useEffect(() => {
    const controller = new AbortController()
    let scope: ReturnType<typeof import('../../shared/local-drafts/browser-logout.ts').createBrowserLogout> | undefined
    void (async () => {
      try {
        const { createBrowserLogout } = await import('../../shared/local-drafts/browser-logout.ts')
        if (controller.signal.aborted)
          return
        const session = await fetchSession(controller.signal)
        if (controller.signal.aborted)
          return
        scope = createBrowserLogout(session, () => queryClient.clear())
        setLoaded({ session, flow: scope.flow })
        await scope.flow.preview()
      }
      catch (error) {
        if (!controller.signal.aborted)
          setProblem(isAuthenticationError(error) ? 'ended' : 'unknown')
      }
    })()
    return () => {
      controller.abort()
      scope?.dispose()
    }
  }, [queryClient])
  if (loaded !== undefined)
    return <LogoutContent flow={loaded.flow} session={loaded.session} />
  return (
    <main className="mx-auto max-w-xl space-y-5 px-4 py-8">
      <h1 className="text-xl font-semibold">{text.title}</h1>
      <StatusRegion>{problem === undefined ? text.checking : problem === 'ended' ? text.sessionEnded : text.sessionFailed}</StatusRegion>
      {problem !== undefined && (
        <div className="flex flex-wrap gap-3">
          <Button onClick={page.reload}>{text.repreview}</Button>
          <a href={LOGIN_PATH} className={buttonVariants({ variant: 'outline' })}>{text.login}</a>
        </div>
      )}
    </main>
  )
}
