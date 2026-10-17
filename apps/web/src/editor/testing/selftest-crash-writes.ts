import type { StoredDraft } from '../../shared/outbox/draft-record.ts'

type Identity = Pick<StoredDraft, 'userId' | 'documentId' | 'writeEpoch' | 'writerId' | 'draftSeq' | 'writtenBy'>
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function callId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function identityOf(value: unknown): Identity | undefined {
  if (!object(value) || !object(value.key) || !object(value.writer)
    || typeof value.key.userId !== 'string' || typeof value.key.documentId !== 'string'
    || !positive(value.writer.writeEpoch) || typeof value.writer.writerId !== 'string'
    || !positive(value.draftSeq) || typeof value.writtenBy !== 'string') {
    return undefined
  }
  return { userId: value.key.userId, documentId: value.key.documentId, writeEpoch: value.writer.writeEpoch, writerId: value.writer.writerId, draftSeq: value.draftSeq, writtenBy: value.writtenBy }
}
function keyOf(value: Identity): string {
  return JSON.stringify([value.userId, value.documentId, value.writeEpoch, value.writerId, value.draftSeq, value.writtenBy])
}

/** 只保留身份和摘要；生产 Worker 已 await 镜像 flush 后的回包才能形成镜像证据。 */
export function createCrashWriteEvidence() {
  const calls = new WeakMap<object, Map<number, Identity>>()
  const mirrors = new Map<string, string>()
  let written = 0
  return {
    sent(worker: object, message: unknown): void {
      if (!object(message) || message.type !== 'write' || !callId(message.id))
        return
      const identity = identityOf(message.capture)
      if (identity === undefined)
        return
      let pending = calls.get(worker)
      if (pending === undefined) {
        pending = new Map()
        calls.set(worker, pending)
      }
      pending.set(message.id, identity)
    },
    received(worker: object, message: unknown): void {
      if (!object(message) || !callId(message.id))
        return
      const pending = calls.get(worker)
      const identity = pending?.get(message.id)
      if (identity === undefined)
        return
      pending?.delete(message.id)
      if (message.ok !== true || !object(message.result) || message.result.kind !== 'written')
        return
      written += 1
      const { mirror, digest } = message.result
      if (object(mirror) && mirror.kind === 'mirrored' && typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest))
        mirrors.set(keyOf(identity), digest)
    },
    count: () => written,
    mirrorFor(draft: Identity, snapshotHash: string): { readonly draftSeq: number, readonly snapshotHash: string } | undefined {
      return mirrors.get(keyOf(draft)) === snapshotHash ? { draftSeq: draft.draftSeq, snapshotHash } : undefined
    },
  }
}
