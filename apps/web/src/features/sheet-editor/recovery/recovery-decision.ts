// 恢复只判事实，不持有正文、不授予写入许可。调用方仍须核对租约、本机锁、当前会话与原子接手结果。
import type { RevisionSource } from '@nerve-office/contracts'
import type { ContentFormat, DraftKey, DraftMeta } from '../../../shared/outbox/draft-record.ts'
import type { DraftRead } from '../../../shared/outbox/draft-writer.ts'
import type { SaveRequest } from '../save-coordinator.ts'
import { compareVersions } from '@nerve-office/contracts'
import { canReplayAsSent, isExpired } from '../../../shared/outbox/writer-fence.ts'

export type RecoveryRecord = Exclude<DraftRead, { readonly kind: 'draft' }> | { readonly kind: 'draft', readonly meta: DraftMeta }

export interface RecoveryServer {
  readonly revision: number
  /** undefined 是尚未取得来源；null 是服务端明确没有属于本人的来源。 */
  readonly source: RevisionSource | null | undefined
  readonly occupied: boolean
}

export type ReplayFact
  = | { readonly kind: 'unchecked' }
    | { readonly kind: 'unknown' | 'unconfirmed', readonly requestId: string }
    | { readonly kind: 'confirmed', readonly requestId: string, readonly revision: number }

export interface RecoveryFacts {
  readonly key: DraftKey
  readonly record: RecoveryRecord
  readonly access: 'unknown' | 'unreadable' | 'read-only' | 'editable'
  /** 已结合实际请求结果的连接事实，不能只传 navigator.onLine。 */
  readonly online: boolean
  readonly current: RecoveryServer | undefined
  readonly pageFormat: ContentFormat
  readonly replay: ReplayFact
  readonly now: number
}

export interface DraftReplayRequest {
  readonly request: SaveRequest
  /** 原代次，仅用于无租约的旧回执核对；不得补上当前租约令牌。 */
  readonly writeEpoch: number
}

export type RecoveryDecision
  = | { readonly kind: 'none' }
    | { readonly kind: 'preserve', readonly reason: 'session' | 'offline' | 'storage' | 'key' | 'identity' | 'newer-format' | 'replay' | 'server' }
    | { readonly kind: 'refresh-key' }
    | { readonly kind: 'remove', readonly reason: 'unreadable' | 'expired' | 'revoked' | 'corrupted' | 'malformed' }
    | { readonly kind: 'replay', readonly replay: DraftReplayRequest }
    | { readonly kind: 'confirmed', readonly revision: number }
    | { readonly kind: 'copy', readonly reason: 'read-only' | 'conflict' }
    | { readonly kind: 'held' }
    | { readonly kind: 'restore', readonly baseRevision: number, readonly formulasPending: boolean, readonly reason: 'fast-forward' | 'own-revision' }

/** 不重捕获、不修改原字段；保存原 gzip 的所有者与这个描述一起固定请求。 */
export function draftReplayRequest(meta: DraftMeta, now: number): DraftReplayRequest | undefined {
  const inFlight = meta.inFlight
  if (inFlight === null || !canReplayAsSent(meta, now))
    return undefined
  return {
    request: {
      requestId: inFlight.requestId,
      clientInstanceId: inFlight.clientInstanceId,
      localSeq: inFlight.localSeq,
      baseRevision: meta.baseRevision,
      format: { ...meta.format },
      formulasPending: meta.formulasPending,
    },
    writeEpoch: meta.writeEpoch,
  }
}

/** 数据格式可理解才交给 SDK；构建号本身不决定内容能否读，服务端的最低构建另有守卫。 */
function readableFormat(record: ContentFormat, page: ContentFormat): boolean {
  const sdk = compareVersions(record.univerVersion, page.univerVersion)
  return record.profile === page.profile && record.formatVersion === page.formatVersion && sdk !== undefined && sdk <= 0
}

type Rule = (facts: RecoveryFacts) => RecoveryDecision | undefined

// 顺序也是契约：外来身份和读取失败不能借撤权分支清理；旧钥/新格式不能借过期分支删除。
const PRECONDITIONS: readonly Rule[] = [
  facts => facts.access === 'unknown' ? { kind: 'preserve', reason: 'session' } : undefined,
  ({ key, record }) => 'meta' in record && (record.meta.userId !== key.userId || record.meta.documentId !== key.documentId) ? { kind: 'preserve', reason: 'identity' } : undefined,
  ({ record }) => record.kind === 'failed' || record.kind === 'quota' || record.kind === 'unavailable' ? { kind: 'preserve', reason: 'storage' } : undefined,
  ({ record }) => record.kind === 'absent' ? { kind: 'none' } : undefined,
  facts => facts.access === 'unreadable' ? { kind: 'remove', reason: 'unreadable' } : undefined,
  facts => !facts.online ? { kind: 'preserve', reason: 'offline' } : undefined,
  ({ record }) => record.kind === 'newer-format' ? { kind: 'preserve', reason: 'newer-format' } : undefined,
  ({ record }) => record.kind === 'no-key' ? { kind: 'preserve', reason: 'key' } : undefined,
  ({ record }) => record.kind === 'unreadable'
    ? record.reason === 'stale-key' ? { kind: 'refresh-key' } : { kind: 'remove', reason: record.reason }
    : undefined,
  ({ record }) => record.kind === 'malformed' ? { kind: 'remove', reason: 'malformed' } : undefined,
]

export function decideDraftRecovery(facts: RecoveryFacts): RecoveryDecision {
  for (const rule of PRECONDITIONS) {
    const decision = rule(facts)
    if (decision !== undefined)
      return decision
  }
  // 其余形状均由上表处理；不让将来新增的读取结果穿过这里获得许可。
  if (facts.record.kind !== 'draft')
    return { kind: 'preserve', reason: 'storage' }
  const { meta } = facts.record
  if (!readableFormat(meta.format, facts.pageFormat))
    return { kind: 'preserve', reason: 'newer-format' }
  if (isExpired(meta, facts.now))
    return { kind: 'remove', reason: 'expired' }

  const replay = draftReplayRequest(meta, facts.now)
  if (replay !== undefined) {
    const checked = facts.replay
    if (checked.kind === 'unchecked' || checked.requestId !== replay.request.requestId)
      return { kind: 'replay', replay }
    if (checked.kind === 'unknown')
      return { kind: 'preserve', reason: 'replay' }
    if (checked.kind === 'confirmed')
      return { kind: 'confirmed', revision: checked.revision }
    // unconfirmed 只说明这次无租约请求没有认出回执；恢复安装仍需当前写入资格和最新的服务端事实。
  }
  if (facts.access === 'read-only')
    return { kind: 'copy', reason: 'read-only' }
  const { current } = facts
  if (current === undefined)
    return { kind: 'preserve', reason: 'server' }
  if (current.revision === meta.baseRevision)
    return current.occupied ? { kind: 'held' } : { kind: 'restore', baseRevision: current.revision, formulasPending: meta.formulasPending, reason: 'fast-forward' }
  const inFlight = meta.inFlight
  if (current.revision === meta.baseRevision + 1 && inFlight !== null) {
    if (current.source === undefined)
      return current.occupied ? { kind: 'held' } : { kind: 'preserve', reason: 'server' }
    if (current.source?.clientInstanceId === inFlight.clientInstanceId && current.source.localSeq === inFlight.localSeq)
      return current.occupied ? { kind: 'held' } : { kind: 'restore', baseRevision: current.revision, formulasPending: meta.formulasPending, reason: 'own-revision' }
  }
  return { kind: 'copy', reason: 'conflict' }
}
