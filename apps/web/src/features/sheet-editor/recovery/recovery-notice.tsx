// 只展示恢复事实并转交意图；正文、清理凭证与副本请求均由 DocumentRecovery 持有。
import type { RecoveryView } from './document-recovery.ts'
import { documentPagePath } from '@nerve-office/contracts'
import { describeError } from '../../../shared/api/index.ts'
import { concludesRequest } from '../../../shared/api/request-ids.ts'
import { editorMessages } from '../../../shared/i18n/zh-cn/editor.ts'
import { formatClockTime } from '../../../shared/lib/format.ts'
import { Button, buttonVariants } from '../../../shared/ui/index.ts'
import { StatusRegion } from '../../../shared/ui/status-region.tsx'

export interface RecoveryNoticeProps {
  readonly view: RecoveryView | undefined
  readonly available: boolean
  readonly active: boolean
  readonly reading: boolean
  readonly canRestore: boolean
  readonly entering: boolean
  readonly onRestore: () => void
  readonly onCopy: () => void
  readonly onRetry: () => void
  readonly onDiscard: () => void
  readonly onRetryCleanup: () => void
  readonly onAcknowledge: (at: number) => void
  readonly onReload: () => void
}

const words = editorMessages.recovery

function timeOf(view: RecoveryView): string | undefined {
  return view.updatedAt === undefined ? undefined : formatClockTime(new Date(view.updatedAt).toISOString())
}

function recoveryText(view: RecoveryView): string | undefined {
  if (view.copy.kind === 'done')
    return editorMessages.mode.copied(view.copy.document.title)
  if (view.saved === true)
    return words.saved
  if (view.cleanup?.kind === 'failed' || view.problem === 'invalidated')
    return undefined
  if (view.stage === 'restored')
    return words.restored(timeOf(view))
  const decision = view.decision
  if (view.stage === 'finished' && decision?.kind !== 'remove' && decision?.kind !== 'confirmed')
    return words.cleared
  if (decision === undefined)
    return view.stage === 'checking' ? words.checking : undefined
  switch (decision.kind) {
    case 'none': return undefined
    case 'restore': return words.found(timeOf(view))
    case 'copy': return words.copyReason[decision.reason]
    case 'held': return words.held
    case 'preserve': return words.preserve[decision.reason]
    case 'refresh-key': return words.preserve.key
    case 'confirmed': return words.confirmed
    case 'remove': return view.stage === 'finished' ? words.removed[decision.reason] : words.removing[decision.reason]
  }
}

function cleanupText(view: RecoveryView): string | undefined {
  switch (view.cleanup?.kind) {
    case 'changed': return words.changed
    case 'quota': return words.cleanupQuota
    case 'failed': return view.problem === 'invalidated' ? words.invalidated : words.cleanupFailed
    case 'unavailable': return words.cleanupUnavailable
    case 'removed': return view.cleanup.mirror.kind === 'failed' ? words.mirrorFailed : undefined
    case undefined:
    case 'absent': return undefined
  }
}

function problemText(view: RecoveryView): string | undefined {
  if (view.problem === 'changed')
    return view.cleanup?.kind === 'changed' ? undefined : words.changed
  if (view.problem === 'invalidated')
    return view.cleanup?.kind === 'failed' ? undefined : words.invalidated
  if (view.problem === 'open-check' || view.problem === 'formulas' || view.problem === 'storage' || view.problem === 'cancelled')
    return words.problem[view.problem]
  return undefined
}

/** 空的状态区也留在无障碍树里；按钮消失的焦点交还由 EditorChrome 的 useFocusRescue 负责。 */
export function RecoveryNotice(props: RecoveryNoticeProps) {
  const { view } = props
  const notice = view?.notice
  const decision = view?.decision
  const ready = view?.stage === 'ready' || view?.stage === 'checking'
  const actionable = ready && (decision?.kind === 'restore' || decision?.kind === 'copy' || decision?.kind === 'held')
  const copyIdle = view?.copy.kind === 'idle'
  const copyRetry = view?.copy.kind === 'failed'
  const copies = [...new Map([...(view?.completedCopies ?? []), ...(view?.copy.kind === 'done' ? [view.copy.document] : [])].map(document => [document.id, document])).values()]
  const reading = props.reading || props.entering
  const disabled = !props.available || !props.active || view?.operation !== undefined || props.entering
  const changed = view?.cleanup?.kind === 'changed' || view?.problem === 'changed' || view?.problem === 'invalidated'
  const restore = reading && ready && copyIdle && (decision?.kind === 'restore' || (decision?.kind === 'preserve' && decision.reason === 'server'))
  const copy = reading && (copyRetry || (actionable && (copyIdle || view?.copy.kind === 'saving')))
  const discard = reading && actionable && view?.copy.kind !== 'done'
  const retryCleanup = view !== undefined && !changed && (view.cleanup?.kind === 'quota' || view.cleanup?.kind === 'failed' || view.cleanup?.kind === 'unavailable')
  const retry = props.reading && view !== undefined && (changed || decision?.kind === 'preserve' || decision?.kind === 'refresh-key' || view.problem !== undefined)
  const reload = (decision?.kind === 'preserve' && decision.reason === 'newer-format') || (view?.copy.kind === 'refused' && view.copy.refusal === 'outdated')
  const lines = view === undefined
    ? []
    : [
        recoveryText(view),
        ...copies.filter(document => view.copy.kind !== 'done' || document.id !== view.copy.document.id).map(document => editorMessages.mode.copied(document.title)),
        view.operation === undefined ? undefined : words.operation[view.operation],
        cleanupText(view),
        problemText(view),
        view.copy.kind === 'failed' ? concludesRequest(view.copy.error) ? words.copyRejected(describeError(view.copy.error).message) : words.copyFailed : view.copy.kind === 'refused' ? words.copyRefused[view.copy.refusal] : undefined,
        view.notice === undefined ? undefined : words.notice[view.notice.kind],
      ].filter(line => line !== undefined)
  return (
    <div className="contents" data-slot="recovery-notice">
      <StatusRegion className="mx-3 mt-2 rounded-lg border bg-card px-2.5 py-2 text-sm text-card-foreground">
        {lines.length === 0 ? undefined : [...new Set(lines)].map(line => <span className="block" key={line}>{line}</span>)}
      </StatusRegion>
      {(restore || copy || discard || retryCleanup || retry || reload || copies.length > 0 || view?.notice !== undefined) && (
        <div className="mx-3 mt-2 flex flex-wrap items-center gap-2">
          {restore && <Button size="sm" disabled={disabled || changed || !props.canRestore} onClick={props.onRestore}>{words.restore}</Button>}
          {copy && <Button size="sm" variant="outline" disabled={disabled || (changed && !copyRetry)} onClick={props.onCopy}>{copyRetry ? words.copyRetry : words.copy}</Button>}
          {discard && <Button size="sm" variant="outline" disabled={disabled || changed} onClick={props.onDiscard}>{words.discard}</Button>}
          {retryCleanup && <Button size="sm" variant="outline" disabled={disabled} onClick={props.onRetryCleanup}>{words.retryCleanup}</Button>}
          {retry && <Button size="sm" variant="outline" disabled={disabled} onClick={props.onRetry}>{words.retry}</Button>}
          {reload && <Button size="sm" variant="outline" disabled={view?.operation !== undefined} onClick={props.onReload}>{words.reload}</Button>}
          {copies.map(document => <a key={document.id} href={documentPagePath(document.id)} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: 'outline', size: 'sm' })} title={document.title}>{editorMessages.mode.openCopy}</a>)}
          {notice !== undefined && <Button size="sm" variant="outline" disabled={disabled} onClick={() => props.onAcknowledge(notice.at)}>{words.acknowledge}</Button>}
        </div>
      )}
    </div>
  )
}
