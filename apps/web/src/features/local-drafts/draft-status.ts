import type { DraftCatalogRow } from '../../shared/local-drafts/draft-catalog.ts'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'
import { localDraftsMessages as text } from '../../shared/i18n/zh-cn/local-drafts.ts'
import { formatDateTime } from '../../shared/lib/format.ts'

export function draftTime(at: number | undefined): string {
  return at === undefined ? text.unknownTime : text.updatedAt(formatDateTime(new Date(at).toISOString()))
}

/** 只翻译共享判定和已发生的结果；不授予存储操作资格。 */
export function draftStatus(row: DraftCatalogRow) {
  const words = editorMessages.recovery
  const view = row.recovery
  const decision = view?.decision
  const cleanup = view?.cleanup
  const finished = view?.stage === 'finished'
  const changed = cleanup?.kind === 'changed' || view?.problem === 'changed'
  const newer = decision?.kind === 'preserve' && decision.reason === 'newer-format'
  const readable = row.access === 'accessible'
  const candidate = !finished && !changed && readable && (decision?.kind === 'restore' || decision?.kind === 'copy' || decision?.kind === 'held')
  const mirrorPending = cleanup?.kind === 'removed' && cleanup.mirror.kind !== 'removed' && cleanup.mirror.kind !== 'unsupported'
  let summary: string = text.checking
  let details: string | undefined
  if (finished) {
    summary = decision?.kind === 'remove' ? words.removed[decision.reason] : decision?.kind === 'confirmed' ? text.confirmed : text.cleaned
    if (mirrorPending) {
      details = `${summary} ${text.mirrorPending}`
      summary = text.mainRemoved
    }
  }
  else if (changed) {
    summary = words.changed
  }
  else if (row.access === 'unknown' && view !== undefined) {
    summary = text.factsFailed
  }
  else if (decision !== undefined) {
    switch (decision.kind) {
      case 'restore':
        summary = text.canRestore
        break
      case 'held':
        summary = words.held
        break
      case 'copy':
        summary = words.copyReason[decision.reason]
        break
      case 'preserve':
        summary = words.preserve[decision.reason]
        break
      case 'refresh-key':
        summary = words.preserve.key
        break
      case 'confirmed':
        summary = text.confirmedPending
        break
      case 'remove':
        summary = words.removing[decision.reason]
        break
      case 'none':
        summary = row.mirrorOnly ? text.mirrorOnly : text.absent
        break
    }
  }
  if (cleanup?.kind === 'quota')
    details = words.cleanupQuota
  if (cleanup?.kind === 'unavailable')
    details = words.cleanupUnavailable
  if (cleanup?.kind === 'failed')
    details = words.cleanupFailed
  if (cleanup?.kind === 'session-invalid')
    details = words.preserve.session
  if (view?.notice !== undefined)
    details = [details, words.notice[view.notice.kind]].filter(Boolean).join(' ')
  if (view?.copy.kind === 'failed')
    details = [details, words.copyFailed].filter(Boolean).join(' ')
  if (view?.copy.kind === 'refused')
    details = [details, words.copyRefused[view.copy.refusal]].filter(Boolean).join(' ')
  if (view?.copy.kind === 'done' && !mirrorPending)
    summary = `${text.copied} ${summary}`
  return {
    summary,
    details,
    canRestore: candidate && (decision?.kind === 'restore' || decision?.kind === 'held') && view?.copy.kind === 'idle',
    canCopy: candidate && (view?.copy.kind === 'idle' || view?.copy.kind === 'failed'),
    canDiscard: !finished && readable && !newer && decision !== undefined && decision.kind !== 'none' && decision.kind !== 'remove' && decision.kind !== 'confirmed' && !(decision.kind === 'preserve' && (decision.reason === 'session' || decision.reason === 'identity')),
    canReload: newer || (view?.copy.kind === 'refused' && view.copy.refusal === 'outdated'),
  }
}
