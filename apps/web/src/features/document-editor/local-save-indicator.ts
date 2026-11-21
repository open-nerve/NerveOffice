import type { ConnectionView } from '../../shared/lib/connection-state.ts'
import type { LocalSaveView } from './editing-session.ts'
import { editorMessages } from '../../shared/i18n/zh-cn/editor.ts'

export interface LocalSaveIndicator {
  readonly kind: 'saved' | 'partial' | 'writing' | 'confirmed' | 'memory' | 'empty'
  readonly summary: string
  readonly details: readonly string[]
  /** 只按故障/降级事实变化；不含内容序号、捕获状态或覆盖范围，避免逐次输入朗读。 */
  readonly announcementKey: string | undefined
  readonly announcement: string
}

export const CONNECTION_WARNING_MS = 90_000

/** 展示只读元数据；当前捕获的完整覆盖和实际持久写入必须同时成立。 */
export function localSaveIndicator(local: LocalSaveView, connection: ConnectionView | undefined, now: number): LocalSaveIndicator {
  const text = editorMessages.localSave
  const { storage, draft } = local
  const reason = !local.enabled ? 'disabled' : storage.reason ?? (storage.kind === 'inactive' ? 'paused' : undefined)
  const memoryMessage = reason === 'disabled' && local.enabled ? text.disabledForSession : reason === undefined ? undefined : text.memory[reason]
  const fact = draft.kind === 'working' ? draft.local : undefined
  const metadataIssue = draft.kind === 'working' ? draft.metadataIssue : undefined
  const capturedConfirmed = draft.kind === 'working' && draft.summary?.kind === 'ready' && draft.summary.confirmedRevision !== undefined
  let kind: LocalSaveIndicator['kind']
  let summary: string
  if (memoryMessage !== undefined) {
    kind = 'memory'
    summary = memoryMessage
  }
  else if (metadataIssue?.operation === 'confirm' && capturedConfirmed) {
    kind = local.coversCurrent ? 'confirmed' : 'partial'
    summary = local.coversCurrent ? text.confirmedUnverified : text.confirmedPartial
  }
  else if (fact?.kind === 'persisted') {
    kind = local.coversCurrent ? 'saved' : 'partial'
    summary = !local.coversCurrent ? text.partial : connection?.browserOnline === false ? text.offlineSaved : text.saved
  }
  else if (fact?.kind === 'confirmed' && local.coversCurrent) {
    kind = 'confirmed'
    summary = text.confirmed
  }
  else if (fact?.kind === 'writing') {
    kind = 'writing'
    summary = text.writing
  }
  else {
    kind = 'empty'
    summary = local.unsaved ? text.pending : text.ready
  }
  const details: string[] = []
  const keys: string[] = []
  const announcements: string[] = []
  function issue(key: string, message: string): void {
    keys.push(key)
    announcements.push(message)
  }
  if (metadataIssue !== undefined) {
    const message = text.metadata[metadataIssue.reason]
    details.push(message, text.metadataRecovery)
    issue(`metadata:${metadataIssue.operation}:${metadataIssue.reason}`, message)
  }
  if (connection?.problem !== undefined) {
    const message = connection.problem === 'offline' ? text.offline : text.network
    details.push(message)
    issue(connection.problem, message)
    if (connection.since !== undefined && now - connection.since >= CONNECTION_WARNING_MS) {
      details.push(text.expired)
      issue('expired', text.expired)
    }
  }
  if (reason !== undefined && memoryMessage !== undefined)
    issue(`memory:${reason}:${local.enabled}`, memoryMessage)
  if (local.unsaved && (kind !== 'saved' || !local.coversCurrent))
    details.push(text.pageOnly)
  details.push(text.browserOnly)
  if (storage.hostKind === 'in-process') {
    details.push(text.inProcess)
    issue('in-process', text.inProcess)
  }
  if (storage.mirror !== undefined) {
    const mirror = storage.mirror
    const key = mirror.kind === 'not-mirrored' ? mirror.reason : mirror.kind
    details.push(text.mirror[key])
    if (mirror.kind !== 'mirrored')
      issue(`mirror:${key}`, text.mirror[key])
  }
  if (storage.kind === 'persistent' || storage.hostKind !== undefined) {
    const persistence = storage.persistence?.kind
    const message = persistence === 'granted'
      ? text.persistent
      : persistence === 'denied'
        ? text.persistenceDenied
        : persistence === undefined ? text.persistencePending : text.persistenceUnavailable
    details.push(message)
    if (persistence !== undefined && persistence !== 'granted')
      issue(`persistence:${persistence}`, message)
  }
  return { kind, summary, details, announcementKey: keys.length === 0 ? undefined : keys.join('|'), announcement: announcements.join(' ') }
}
