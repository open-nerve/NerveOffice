import type { RefObject } from 'react'
import type { CatalogDiscard, DraftCatalog } from '../../shared/local-drafts/draft-catalog.ts'
import type { DraftSessionPermit } from '../../shared/outbox/session-fence.ts'
import type { PendingConfirmation } from '../confirmation/index.ts'
import { documentPagePath } from '@nerve-office/contracts'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { associatedSessionPermit } from '../../shared/api/session-association.ts'
import { localDraftsMessages as text } from '../../shared/i18n/zh-cn/local-drafts.ts'
import { usePageLocation } from '../../shared/lib/page-location.ts'
import { useSessionRecheck } from '../../shared/lib/session-recheck.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { useFocusRescue } from '../../shared/lib/use-focus-rescue.ts'
import { createBrowserDraftCatalog } from '../../shared/local-drafts/browser-draft-catalog.ts'
import { readDraftSessionPermit } from '../../shared/outbox/session-fence.ts'
import { Button, buttonVariants, RetryButton } from '../../shared/ui/index.ts'
import { StatusRegion } from '../../shared/ui/status-region.tsx'
import { sessionQueryOptions } from '../auth/index.ts'
import { ConfirmDialog } from '../confirmation/index.ts'
import { DraftLeaveGuard } from './draft-leave-guard.tsx'
import { DraftRow } from './draft-row.tsx'
import { draftStatus, draftTime } from './draft-status.ts'
import { StorageStatus } from './storage-status.tsx'

/** 视图只订阅元数据；正文和原件凭证始终由 catalog 拥有。 */
export function DraftCatalogContent({ catalog, onSessionRecheck }: { readonly catalog: DraftCatalog, readonly onSessionRecheck: () => Promise<void> }) {
  useDocumentTitle(text.title)
  const page = usePageLocation()
  const state = useSyncExternalStore(catalog.subscribe, catalog.view)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const aliveRef = useRef(false)
  const preparingRef = useRef(false)
  const intentRef = useRef<CatalogDiscard>(undefined)
  const [pending, setPending] = useState<PendingConfirmation>()
  const [announcement, setAnnouncement] = useState<string>()
  const [checkingSession, setCheckingSession] = useState(false)
  const copiesId = useId()
  const fallback = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() {
      const anchors = contentRef.current?.querySelectorAll<HTMLElement>('[data-draft-heading]') ?? []
      return [...anchors].find((anchor) => {
        const rect = anchor.getBoundingClientRect()
        return rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight
      }) ?? headingRef.current
    },
  }), [])
  const rescue = useFocusRescue(fallback)
  useEffect(() => {
    aliveRef.current = true
    const refresh = () => {
      if (document.visibilityState === 'visible')
        void catalog.refresh()
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    window.addEventListener('pageshow', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      aliveRef.current = false
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      window.removeEventListener('pageshow', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [catalog])

  function locked(documentId?: string): boolean {
    const current = catalog.view()
    return current.problem === 'session' || current.busy !== undefined || (current.held !== undefined && current.held !== documentId)
  }

  async function refresh(): Promise<void> {
    if (checkingSession || catalog.view().busy !== undefined)
      return
    setAnnouncement(undefined)
    if (catalog.view().problem !== 'session') {
      await catalog.refresh()
      return
    }
    setCheckingSession(true)
    try {
      await onSessionRecheck()
    }
    finally {
      if (aliveRef.current)
        setCheckingSession(false)
    }
  }

  async function prepareDiscard(documentId: string): Promise<void> {
    if (locked(documentId) || preparingRef.current || intentRef.current !== undefined)
      return
    preparingRef.current = true
    setAnnouncement(undefined)
    try {
      const original = await catalog.prepareDiscard(documentId)
      if (!aliveRef.current || catalog.view().problem === 'session' || original === undefined)
        return
      intentRef.current = original
      setPending({
        title: text.discardTitle,
        description: `${text.discardDescription(original.title ?? text.unknownTitle, draftTime(original.updatedAt))}${catalog.view().copyPending === documentId ? ` ${text.discardUnknownCopy}` : ''}`,
        confirmLabel: text.confirmDiscard,
        destructive: true,
        run: async () => {
          await catalog.discard(original)
          const row = catalog.view().rows.find(item => item.documentId === documentId)
          const result = row === undefined ? text.sessionFailed : draftStatus(row)
          return () => {
            if (aliveRef.current)
              setAnnouncement(typeof result === 'string' ? result : [result.summary, result.details].filter(Boolean).join(' '))
          }
        },
        refresh: catalog.refresh,
        returnFocus: () => fallback.current?.focus(),
      })
    }
    finally {
      preparingRef.current = false
    }
  }

  const checking = state.busy?.kind === 'refresh' || checkingSession
  const hasProblem = state.incomplete || state.problem !== undefined
  const problem = state.problem === 'session' ? text.sessionFailed : state.problem === 'storage' ? text.storageFailed : state.problem === 'facts' ? text.factsFailed : state.incomplete ? text.incomplete : undefined
  return (
    <div ref={contentRef} className="min-w-0 space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">{text.title}</h1>
          <Button variant="outline" size="sm" aria-disabled={checking || state.copyPending !== undefined || (state.held !== undefined && pending !== undefined)} onClick={() => void refresh()}>{text.refresh}</Button>
        </div>
        <p className="text-sm text-muted-foreground">{text.description}</p>
      </header>
      <StorageStatus />
      <StatusRegion className="text-sm text-muted-foreground" keepFocusInView>{[checking || (!state.checked && state.problem === undefined) ? text.checking : undefined, state.stale ? text.stale : undefined, state.copyPending === undefined ? undefined : text.copyHeld, announcement].filter(Boolean).join(' ')}</StatusRegion>
      {hasProblem && (
        <div role="alert" className="space-y-2 rounded-lg border p-4 text-sm">
          <p>{problem}</p>
          <RetryButton retrying={checking} onRetry={() => void refresh()} />
        </div>
      )}
      <div ref={rescue}>
        {state.checked && !checking && !hasProblem && state.rows.length === 0 && <p className="rounded-lg border p-6 text-sm text-muted-foreground">{text.empty}</p>}
        {state.rows.length > 0 && (
          <ul aria-label={text.list} className="divide-y rounded-lg border">
            {state.rows.map(row => (
              <DraftRow
                key={row.documentId}
                row={row}
                disabled={locked(row.documentId)}
                copyPending={state.copyPending === row.documentId}
                cleanupRetry={state.held === row.documentId && row.recovery?.cleanup !== undefined && row.recovery.cleanup.kind !== 'removed' && row.recovery.cleanup.kind !== 'absent' && row.recovery.cleanup.kind !== 'changed'}
                onCopy={() => {
                  if (!locked(row.documentId))
                    void catalog.copy(row.documentId)
                }}
                onDiscard={() => void prepareDiscard(row.documentId)}
                onRetryCleanup={() => {
                  if (!locked(row.documentId))
                    void catalog.retryCleanup(row.documentId)
                }}
                onReload={page.reload}
              />
            ))}
          </ul>
        )}
      </div>
      <StatusRegion className="text-sm text-muted-foreground" keepFocusInView>{state.uncertainCopies.length > 0 ? text.copyUncertain : undefined}</StatusRegion>
      {state.completedCopies.length > 0 && (
        <section aria-labelledby={copiesId} className="space-y-2">
          <h2 id={copiesId} className="font-medium">{text.completedCopies}</h2>
          <ul className="space-y-2">
            {state.completedCopies.map(document => <li key={document.id}><a href={documentPagePath(document.id)} className={buttonVariants({ variant: 'link', className: 'h-auto max-w-full whitespace-normal text-left' })}>{text.openCopy(document.title)}</a></li>)}
          </ul>
        </section>
      )}
      <ConfirmDialog
        pending={state.problem === 'session' ? undefined : pending}
        onClose={() => {
          if (intentRef.current !== undefined)
            catalog.cancelDiscard(intentRef.current)
          intentRef.current = undefined
          setPending(undefined)
        }}
        unavailable={() => catalog.view().problem === 'session' ? text.sessionFailed : undefined}
      />
      <DraftLeaveGuard active={state.copyPending !== undefined || state.busy?.kind === 'copy'} fallback={headingRef} />
    </div>
  )
}

/** 生命周期在 effect 中建立，StrictMode 的预演不会留下第二个目录或 Worker。 */
function SessionDrafts({ permit }: { readonly permit: DraftSessionPermit | undefined }) {
  const recheck = useSessionRecheck()
  const [attempt, setAttempt] = useState(0)
  const [scope, setScope] = useState<{ readonly catalog: DraftCatalog, readonly recheck: () => Promise<void> }>()
  const userId = permit?.userId
  const generation = permit?.generation
  useEffect(() => {
    let alive = true
    const current = createBrowserDraftCatalog({
      permit: userId === undefined || generation === undefined ? undefined : { userId, generation },
      still: () => alive,
      onSessionProblem: () => void recheck(),
      reportError: error => reportError(error),
    })
    // 目录拥有可释放的存储资源，必须与 effect 的建立/清理配对；不能在 render/StrictMode 预演中建立。
    // eslint-disable-next-line react/set-state-in-effect -- 资源实例必须与 effect 清理配对，再把建立好的实例交给视图订阅。
    setScope({ catalog: current, recheck: async () => {
      await recheck()
      if (alive)
        setAttempt(value => value + 1)
    } })
    void current.refresh()
    return () => {
      alive = false
      current.dispose()
    }
  }, [userId, generation, attempt, recheck])
  if (scope === undefined)
    return <p role="status">{text.checking}</p>
  return <DraftCatalogContent key={attempt} catalog={scope.catalog} onSessionRecheck={scope.recheck} />
}

export function LocalDraftsPage() {
  useDocumentTitle(text.title)
  const session = useQuery(sessionQueryOptions())
  const candidate = session.data === undefined ? undefined : readDraftSessionPermit(associatedSessionPermit(session.data))
  const permit = candidate?.userId === session.data?.user.id ? candidate : undefined
  return <SessionDrafts key={`${session.data?.user.id ?? ''}/${permit?.generation ?? ''}`} permit={permit} />
}
