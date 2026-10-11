import type { ContentFormat, DraftKey, DraftMeta } from '../../../shared/outbox/draft-record.ts'
import type { RecoveryReader } from './recovery-reader.ts'
import type { ReloadMarker } from './reload-marker.ts'
import { decideDraftRecovery } from './recovery-decision.ts'

export interface ReloadDraftOptions {
  readonly expected: ReloadMarker
  readonly reader: RecoveryReader
  readonly key: DraftKey
  readonly pageFormat: ContentFormat
  readonly now: () => number
  readonly still: () => boolean
}

/** 必须用于认证成功后的元数据；未解密的字段不构成归属证明。 */
export function matchesReloadRecord(meta: DraftMeta, expected: ReloadMarker): boolean {
  return meta.userId.toLowerCase() === expected.userId.toLowerCase() && meta.documentId.toLowerCase() === expected.documentId.toLowerCase()
    && meta.writtenBy.toLowerCase() === expected.clientInstanceId.toLowerCase() && meta.writeEpoch === expected.writeEpoch && meta.writerId.toLowerCase() === expected.writerId.toLowerCase()
}

/** 短期预检只读、不解压、不重放；实际恢复仍须在新租约/登记之后重新观察。 */
export async function matchesReloadDraft(options: ReloadDraftOptions): Promise<boolean> {
  const { reader, key, expected, still } = options
  try {
    if (!still() || expected.userId.toLowerCase() !== key.userId.toLowerCase() || expected.documentId.toLowerCase() !== key.documentId.toLowerCase())
      return false
    let observed = await reader.observe()
    if (!still())
      return false
    if (observed.kind === 'observed' && observed.record.kind === 'unreadable' && observed.record.reason === 'stale-key') {
      observed = await reader.refreshKey(observed.record.meta.keyVersion)
      if (!still())
        return false
    }
    if (observed.kind !== 'observed' || observed.record.kind !== 'draft'
      || observed.observation.key.userId.toLowerCase() !== key.userId.toLowerCase() || observed.observation.key.documentId.toLowerCase() !== key.documentId.toLowerCase()
      || !matchesReloadRecord(observed.record.meta, expected)) {
      return false
    }
    // 复用同一格式/保留期判定。未知服务端来源、待核对旧请求仅允许成为申请候选，不提前承诺可恢复。
    // UUID 归属已按契约忽略大小写核对；保留原件的键写法交给纯判定，不改存储中的实际键。
    const decision = decideDraftRecovery({ key: observed.record.meta, record: observed.record, access: 'editable', online: true, current: undefined, pageFormat: options.pageFormat, replay: { kind: 'unchecked' }, now: options.now() })
    return decision.kind === 'replay' || (decision.kind === 'preserve' && decision.reason === 'server')
  }
  catch {
    return false
  }
  finally {
    reader.dispose()
  }
}
