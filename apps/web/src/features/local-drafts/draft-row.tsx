import type { DraftCatalogRow } from '../../shared/local-drafts/draft-catalog.ts'
import { documentPagePath } from '@nerve-office/contracts'
import { useId, useRef } from 'react'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'
import { localDraftsMessages as text } from '../../shared/i18n/zh-cn/local-drafts.ts'
import { useFocusRescue } from '../../shared/lib/use-focus-rescue.ts'
import { Button, buttonVariants } from '../../shared/ui/index.ts'
import { StatusRegion } from '../../shared/ui/status-region.tsx'
import { draftStatus, draftTime } from './draft-status.ts'

interface DraftRowProps {
  readonly row: DraftCatalogRow
  readonly disabled: boolean
  readonly copyPending: boolean
  readonly cleanupRetry: boolean
  readonly onCopy: () => void
  readonly onDiscard: () => void
  readonly onRetryCleanup: () => void
  readonly onReload: () => void
}

export function DraftRow({ row, disabled, copyPending, cleanupRetry, onCopy, onDiscard, onRetryCleanup, onReload }: DraftRowProps) {
  const titleId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const rescue = useFocusRescue(headingRef)
  const status = draftStatus(row)
  const restore = status.canRestore && !disabled && !copyPending
  const copy = (status.canCopy || copyPending) && !disabled
  const discard = (status.canDiscard || copyPending) && !disabled
  const operation = row.recovery?.operation
  return (
    <li ref={rescue} aria-labelledby={titleId} className="min-w-0 space-y-3 p-4" data-draft-id={row.documentId}>
      <div className="min-w-0 space-y-1">
        <h2 id={titleId} ref={headingRef} tabIndex={-1} data-draft-heading className="truncate font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50" title={row.title ?? text.unknownTitle}>{row.title ?? text.unknownTitle}</h2>
        <p className="text-xs text-muted-foreground">{draftTime(row.updatedAt)}</p>
      </div>
      <StatusRegion className="text-sm" keepFocusInView>{operation === undefined ? status.summary : editorMessages.recovery.operation[operation]}</StatusRegion>
      <StatusRegion className="text-sm text-muted-foreground" keepFocusInView>{status.details}</StatusRegion>
      {/* 三个逐条入口保留在原位；状态改变或进行中不把焦点丢到 body。 */}
      <div className="flex flex-wrap gap-2">
        <a
          href={documentPagePath(row.documentId)}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          aria-disabled={!restore}
          onClick={(event) => {
            if (!restore)
              event.preventDefault()
          }}
        >
          {text.restore}
        </a>
        <Button
          variant="outline"
          size="sm"
          aria-disabled={!copy}
          onClick={() => {
            if (copy)
              onCopy()
          }}
        >
          {copyPending ? text.copyRetry : text.copy}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-disabled={!discard}
          onClick={() => {
            if (discard)
              onDiscard()
          }}
        >
          {text.discard}
        </Button>
        {cleanupRetry && (
          <Button
            variant="outline"
            size="sm"
            aria-disabled={disabled}
            onClick={() => {
              if (!disabled)
                onRetryCleanup()
            }}
          >
            {editorMessages.recovery.retryCleanup}
          </Button>
        )}
        {status.canReload && (
          <Button
            variant="outline"
            size="sm"
            aria-disabled={disabled}
            onClick={() => {
              if (!disabled)
                onReload()
            }}
          >
            {editorMessages.recovery.reload}
          </Button>
        )}
      </div>
    </li>
  )
}
