import type { BackgroundRefresh } from '../../shared/api/write-outcome.ts'
import type { PendingConfirmation } from '../confirmation/index.ts'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { clearDocumentHistory } from '../../shared/api/document-history.ts'
import { describeError, isAccessDenied, isUnknownOutcome } from '../../shared/api/index.ts'
import { refreshAfterSuccess } from '../../shared/api/write-outcome.ts'
import { historyMessages as text } from '../../shared/i18n/zh-cn/history.ts'
import { refreshQueries } from '../../shared/lib/refresh-queries.ts'
import { Button } from '../../shared/ui/index.ts'
import { StillRefreshing } from '../../shared/ui/still-refreshing.tsx'
import { ConfirmDialog } from '../confirmation/index.ts'
import { historyQueryOptions } from './history-api.ts'

interface ClearHistoryProps {
  readonly documentId: string
  readonly canClear: boolean
  readonly hasItems: boolean
  readonly listUnavailable: boolean
  readonly returnFocus: () => void
}

/** 每次确认对应当时的清除意图；结果未知后不能用同一确认再次删掉后来产生的历史。 */
export function ClearHistory({ documentId, canClear, hasItems, listUnavailable, returnFocus }: ClearHistoryProps) {
  const queryClient = useQueryClient()
  const query = historyQueryOptions(documentId)
  const [pending, setPending] = useState<PendingConfirmation>()
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<{ cleared: number, refreshing: BackgroundRefresh | undefined }>()
  const consumedRef = useRef(false)
  const cannotOpen = listUnavailable || needsRefresh || pending !== undefined

  async function refresh(): Promise<void> {
    await refreshQueries(queryClient, [query.queryKey])
    setNeedsRefresh(false)
  }

  function open(): void {
    if (cannotOpen || !canClear || !hasItems)
      return
    consumedRef.current = false
    setNotice(undefined)
    setPending({
      title: text.clearTitle,
      description: text.clearDescription,
      confirmLabel: text.clearConfirm,
      destructive: true,
      returnFocus,
      refresh,
      refreshAfter: isAccessDenied,
      describeFailure: (error, refreshed) => isUnknownOutcome(error) ? text.clearUnknown(refreshed) : describeError(error).message,
      run: async () => {
        let result
        try {
          result = await clearDocumentHistory(documentId)
        }
        catch (error) {
          if (isUnknownOutcome(error)) {
            consumedRef.current = true
            setNeedsRefresh(true)
          }
          throw error
        }
        // 先取消旧读取，再移除已经确定被删的缓存；刷新失败也不把它们留在页面。
        await queryClient.cancelQueries({ queryKey: query.queryKey })
        queryClient.setQueryData(query.queryKey, data => data === undefined
          ? undefined
          : {
              pages: [{ items: [], nextCursor: null, canClearHistory: data.pages[0]?.canClearHistory ?? false }],
              pageParams: [null],
            })
        const background = await refreshAfterSuccess(refresh)
        return () => setNotice({ cleared: result.cleared, refreshing: background })
      },
    })
  }

  async function reload(): Promise<void> {
    if (refreshing)
      return
    setRefreshing(true)
    try {
      await refresh()
    }
    catch {
      // 查询自身保留失败说明；禁止在没有新读取事实时开始下一次清除。
    }
    finally {
      setRefreshing(false)
    }
  }

  return (
    <>
      {canClear && hasItems && <Button variant="outline" size="sm" aria-disabled={cannotOpen} onClick={open}>{text.clear}</Button>}
      {needsRefresh && pending === undefined && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert">{text.clearNeedsRefresh}</p>
          <Button variant="outline" aria-disabled={refreshing} onClick={() => void reload()}>{text.reload}</Button>
        </div>
      )}
      {notice !== undefined && (
        <p role="status">
          {text.cleared(notice.cleared)}
          <StillRefreshing refresh={notice.refreshing} list={text.title} sentence />
        </p>
      )}
      <ConfirmDialog
        pending={pending}
        onClose={() => setPending(undefined)}
        unavailable={() => consumedRef.current ? text.clearReconfirm : !canClear || !hasItems ? text.clearUnavailable : undefined}
      />
    </>
  )
}
