import type { CreatedDocument } from '@nerve-office/contracts'
import type { Destination } from '../documents/index.ts'
import { documentIdSchema, documentPagePath, historyPreviewPagePath } from '@nerve-office/contracts'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { restoreDocumentHistory } from '../../shared/api/document-history.ts'
import { describeError, isAccessDenied, isUnknownOutcome } from '../../shared/api/index.ts'
import { historyMessages as text } from '../../shared/i18n/zh-cn/history.ts'
import { formatDateTime } from '../../shared/lib/format.ts'
import { useRequestIdLedger } from '../../shared/lib/request-id-ledger.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { useFirstLoadRetry } from '../../shared/lib/use-first-load-retry.ts'
import { useFocusAfterRender } from '../../shared/lib/use-focus-after-render.ts'
import { useFocusRescue } from '../../shared/lib/use-focus-rescue.ts'
import { Alert, AlertDescription, Button, buttonVariants, PersonName, RetryButton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../shared/ui/index.ts'
import { RefreshProblem } from '../../shared/ui/refresh-problem.tsx'
import { DestinationForm, spaceDocumentsQueryKey, targetSpacesOf } from '../documents/index.ts'
import { spacesQueryOptions } from '../spaces/index.ts'
import { ClearHistory } from './clear-history.tsx'
import { historyQueryOptions } from './history-api.ts'

export function HistoryPage() {
  const parsed = documentIdSchema.safeParse(useParams().id)
  return parsed.success ? <DocumentHistory key={parsed.data} documentId={parsed.data} /> : <p role="alert">{text.unavailable}</p>
}

function DocumentHistory({ documentId }: { readonly documentId: string }) {
  useDocumentTitle(text.title)
  const history = useInfiniteQuery(historyQueryOptions(documentId))
  const spaces = useQuery(spacesQueryOptions())
  const queryClient = useQueryClient()
  const ledger = useRequestIdLedger()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusArea = useFocusRescue(headingRef)
  const firstLoad = useFirstLoadRetry(history, headingRef)
  const focusAfterRender = useFocusAfterRender()
  const recoverButtonRef = useRef<HTMLButtonElement>(null)
  const copyLinkRef = useRef<HTMLAnchorElement>(null)
  const nextPreviewRef = useRef<HTMLAnchorElement>(null)
  const [nextFocusId, setNextFocusId] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [copy, setCopy] = useState<CreatedDocument>()
  const items = history.data?.pages.flatMap(page => page.items) ?? []
  const denied = isAccessDenied(history.error)
  const chosen = denied ? undefined : items.find(item => item.id === selected)
  // 撤权或历史消失后清掉选择；资格恢复时不重新打开先前的恢复表单。
  if (selected !== undefined && chosen === undefined)
    setSelected(undefined)

  const mutation = useMutation({
    mutationFn: async ({ id, destination }: { id: string, destination: Destination }) => ledger.send(
      `history:${documentId}/${id}->${destination.spaceId}/${destination.folderId ?? ''}`,
      async requestId => restoreDocumentHistory(documentId, id, { requestId, spaceId: destination.spaceId, ...(destination.folderId === undefined ? {} : { folderId: destination.folderId }) }),
    ),
    onSuccess: (result) => {
      setCopy(result)
      setSelected(undefined)
      focusAfterRender(copyLinkRef)
      void queryClient.invalidateQueries({ queryKey: spaceDocumentsQueryKey(result.spaceId) })
    },
    onError: async (error) => {
      if (isAccessDenied(error))
        await history.refetch()
    },
  })
  function errorMessage(): string | undefined {
    if (!mutation.isError)
      return undefined
    if (ledger.earlierAttemptDone(mutation.error))
      return text.earlier
    return isUnknownOutcome(mutation.error) ? text.unknown : describeError(mutation.error).message
  }
  async function more(): Promise<void> {
    if (history.isFetchingNextPage)
      return
    const count = items.length
    const result = await history.fetchNextPage()
    const first = result.data?.pages.flatMap(page => page.items)[count]
    if (first !== undefined) {
      focusAfterRender(nextPreviewRef)
      setNextFocusId(first.id)
    }
  }

  return (
    <section ref={focusArea} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold">{text.title}</h1>
        <a href={documentPagePath(documentId)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{text.back}</a>
      </div>
      <p className="text-sm text-muted-foreground">{text.description}</p>
      <ClearHistory
        documentId={documentId}
        canClear={!denied && history.data?.pages[0]?.canClearHistory === true}
        hasItems={items.length > 0}
        listUnavailable={history.isFetching || history.isError}
        returnFocus={() => headingRef.current?.focus()}
      />
      {copy !== undefined && (
        <div className="flex items-center gap-3 rounded-lg border p-3" role="status">
          <p>{copy.replayed ? text.replayed : text.restored}</p>
          <a ref={copyLinkRef} href={documentPagePath(copy.id)} target="_blank" rel="noopener" className={buttonVariants({ variant: 'outline', size: 'sm' })}>{text.openCopy}</a>
        </div>
      )}
      {denied
        ? <Alert variant="destructive"><AlertDescription>{text.unavailable}</AlertDescription></Alert>
        : firstLoad.failed
          ? (
              <div onFocus={firstLoad.focus.onFocus} onBlur={firstLoad.focus.onBlur}>
                <p role="alert">{text.failed}</p>
                <RetryButton retrying={firstLoad.retrying} onRetry={() => void history.refetch()} />
              </div>
            )
          : history.data === undefined
            ? <p role="status" aria-label={text.loading}>{text.loading}</p>
            : (
                <>
                  {items.length === 0
                    ? <p>{text.empty}</p>
                    : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>{text.title}</TableHead>
                              <TableHead>{text.saved}</TableHead>
                              <TableHead>{text.expires}</TableHead>
                              <TableHead>{text.actions}</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {items.map(item => (
                              <Fragment key={item.id}>
                                <TableRow>
                                  <TableCell>
                                    <p className="font-medium">{item.title}</p>
                                    <p>{text.revision(item.revision)}</p>
                                  </TableCell>
                                  <TableCell>
                                    {item.savedBy === null ? text.unknownUser : <PersonName person={item.savedBy} />}
                                    <p><time dateTime={item.savedAt}>{formatDateTime(item.savedAt)}</time></p>
                                  </TableCell>
                                  <TableCell><time dateTime={item.expiresAt}>{formatDateTime(item.expiresAt)}</time></TableCell>
                                  <TableCell>
                                    <div className="flex flex-wrap gap-2">
                                      <a ref={item.id === nextFocusId ? nextPreviewRef : undefined} href={historyPreviewPagePath(documentId, item.id)} target="_blank" rel="noopener" className={buttonVariants({ variant: 'outline', size: 'sm' })}>{text.preview}</a>
                                      {item.compatibility === 'supported'
                                        ? (
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              aria-expanded={chosen?.id === item.id}
                                              aria-disabled={mutation.isPending}
                                              onClick={(event) => {
                                                if (mutation.isPending)
                                                  return
                                                recoverButtonRef.current = event.currentTarget
                                                mutation.reset()
                                                setSelected(item.id)
                                              }}
                                            >
                                              {text.restore}
                                            </Button>
                                          )
                                        : <p className="text-sm text-muted-foreground">{text.unsupported}</p>}
                                    </div>
                                  </TableCell>
                                </TableRow>
                                {chosen?.id === item.id && (
                                  <TableRow>
                                    <TableCell colSpan={4}>
                                      <p className="mb-2 text-sm">{text.restoreDescription}</p>
                                      <DestinationForm
                                        panelId={`history-restore-${item.id}`}
                                        action="copy"
                                        labels={{ action: text.restore, submit: text.restoreHere, pending: text.restoring }}
                                        current={{ spaceId: '', folderId: undefined }}
                                        targets={targetSpacesOf(spaces)}
                                        pending={mutation.isPending}
                                        error={errorMessage()}
                                        onSubmit={(destination) => {
                                          if (!mutation.isPending)
                                            mutation.mutate({ id: item.id, destination })
                                        }}
                                        onCancel={() => {
                                          setSelected(undefined)
                                          focusAfterRender(recoverButtonRef)
                                        }}
                                      />
                                    </TableCell>
                                  </TableRow>
                                )}
                              </Fragment>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                  {history.hasNextPage && <Button variant="outline" aria-disabled={history.isFetchingNextPage} onClick={() => void more()}>{history.isFetchingNextPage ? text.loadingMore : text.more}</Button>}
                  <RefreshProblem query={history} list={text.title} fallbackFocus={headingRef} />
                </>
              )}
    </section>
  )
}
