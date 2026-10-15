// 保留原观察与原请求字节；不登记、不清理，也不授予编辑资格。
import type { SaveContentResponse } from '@nerve-office/contracts'
import type { ObserveResult, OpenedRecord } from '../outbox/draft-writer.ts'
import type { DraftReplayRequest, RecoveryDecision, RecoveryFacts } from './recovery-decision.ts'
import { SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'
import { ApiError } from '../api/index.ts'
import { decideDraftRecovery } from './recovery-decision.ts'

export interface ResolvedRecovery {
  readonly observed: ObserveResult
  readonly decision: RecoveryDecision
  readonly problem?: unknown
}

export interface ResolveRecoveryOptions {
  readonly observed: ObserveResult
  readonly facts: Omit<RecoveryFacts, 'record' | 'replay'>
  readonly replay: (request: DraftReplayRequest, gzip: Uint8Array<ArrayBuffer>) => Promise<SaveContentResponse>
}

export async function resolveRecovery({ observed, facts, replay }: ResolveRecoveryOptions): Promise<ResolvedRecovery> {
  const record = observed.kind === 'observed' ? observed.record : observed
  const inputs = { ...facts, record }
  const decision = decideDraftRecovery({ ...inputs, replay: { kind: 'unchecked' } })
  if (decision.kind !== 'replay' || record.kind !== 'draft')
    return { observed, decision }
  const { requestId } = decision.replay.request
  try {
    // 上传持有副本，不能转移/改变发现者手里的原 gzip。
    const receipt = await replay(decision.replay, record.gzip.slice())
    return { observed, decision: decideDraftRecovery({ ...inputs, replay: { kind: 'confirmed', requestId, revision: receipt.revision } }) }
  }
  catch (problem) {
    const kind = problem instanceof ApiError && problem.status === 409 && problem.code === 'EDIT_LEASE_LOST' ? 'unconfirmed' : 'unknown'
    return { observed, decision: decideDraftRecovery({ ...inputs, replay: { kind, requestId } }), problem }
  }
}

export type DecodedRecovery = { readonly kind: 'decoded', readonly snapshot: string } | { readonly kind: 'corrupted' }

/** 按经过认证的原字节数和平台上限流式解码，既不修补快照，也不无限制解压损坏的记录。 */
export async function decodeRecovery(record: Extract<OpenedRecord, { kind: 'draft' }>): Promise<DecodedRecovery> {
  const expected = record.meta.rawBytes
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > SNAPSHOT_MAX_RAW_BYTES)
    return { kind: 'corrupted' }
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ start: (controller) => {
    controller.enqueue(record.gzip)
    controller.close()
  } })
  const reader = stream.pipeThrough(new DecompressionStream('gzip')).getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parts: string[] = []
  let bytes = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done)
        break
      bytes += item.value.byteLength
      if (bytes > expected)
        return { kind: 'corrupted' }
      parts.push(decoder.decode(item.value, { stream: true }))
    }
    if (bytes !== expected)
      return { kind: 'corrupted' }
    parts.push(decoder.decode())
    return { kind: 'decoded', snapshot: parts.join('') }
  }
  catch {
    return { kind: 'corrupted' }
  }
  finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
