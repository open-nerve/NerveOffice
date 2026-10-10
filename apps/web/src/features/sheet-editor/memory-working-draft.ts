import type { DraftMemoryReason, WorkingDraft, WorkingDraftOptions } from './working-draft.ts'
import { gzipBytes, sha256Hex } from '../../shared/outbox/draft-codec.ts'
import { createWorkingDraftSource } from './working-draft-source.ts'

export function createMemoryWorkingDraft(options: WorkingDraftOptions & { readonly reason: DraftMemoryReason }): WorkingDraft {
  const local = { kind: 'memory' as const, reason: options.reason }
  let disposed = false
  return createWorkingDraftSource(options, {
    write: async ({ ref, bytes }) => {
      const digest = sha256Hex(bytes).catch((error: unknown) => {
        try {
          if (!disposed)
            options.reportError(error)
        }
        catch {
          // 摘要和上报失败均不妨碍已有的 gzip 上传。
        }
        return undefined
      })
      const [gzip, hash] = await Promise.all([gzipBytes(bytes), digest])
      return { contentSeq: ref.draftSeq, digest: hash, local, gzip, retainBody: true }
    },
    read: async () => { throw new Error('内存来源的正文不应在仍被保留时丢失') },
    markInFlight: async () => local,
    confirm: async () => local,
    dispose: () => {
      disposed = true
    },
  })
}
