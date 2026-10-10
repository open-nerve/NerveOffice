// 保存/调度单元测试使用实际所有权内核，只替换耗时 codec；持久与真实 gzip 由整合矩阵覆盖。
import type { SaveRequest } from './save-coordinator.ts'
import type { DraftCaptureRef, WorkingDraft } from './working-draft.ts'
import { vi } from 'vitest'
import { PAGE_CLIENT_FORMAT } from './client-format.ts'
import { createWorkingDraftSource } from './working-draft-source.ts'

export interface TestCapture {
  readonly seq: number
  readonly snapshot: string
  readonly bytes: number
  readonly formulasPending: boolean
  readonly digest: string | undefined
}

export function fakeWorkingDraft(options: {
  readonly compress?: (snapshot: string) => Promise<Uint8Array<ArrayBuffer>>
  readonly digest?: (snapshot: string) => Promise<string | undefined>
  readonly reportError?: (error: unknown) => void
  readonly baseRevision?: number
} = {}) {
  const compress = options.compress ?? vi.fn(async (snapshot: string) => new TextEncoder().encode(snapshot))
  const digest = options.digest ?? vi.fn(async () => undefined)
  const reportError = options.reportError ?? vi.fn()
  const supplied = new Map<string, TestCapture>()
  const snapshots = new WeakMap<DraftCaptureRef, string>()
  const local = { kind: 'memory' as const, reason: 'disabled' as const }
  const inner = createWorkingDraftSource({ sessionId: 'test-draft', initialDraftSeq: 0, baseRevision: options.baseRevision ?? 1, format: PAGE_CLIENT_FORMAT, writtenBy: 'test-client', reportError }, {
    write: async ({ ref, bytes }) => {
      const snapshot = new TextDecoder().decode(bytes)
      const given = supplied.get(snapshot)
      const hashing = (given === undefined ? digest(snapshot) : Promise.resolve(given.digest)).catch((error: unknown) => {
        reportError(error)
        return undefined
      })
      const [gzip, hash] = await Promise.all([compress(snapshot), hashing])
      return { contentSeq: ref.draftSeq, gzip, digest: hash, local, retainBody: true }
    },
    read: async () => { throw new Error('测试来源未保留被读取的正文') },
    markInFlight: vi.fn(async () => local),
    confirm: vi.fn(async () => local),
    dispose: vi.fn(),
  })
  const draft: WorkingDraft = {
    ...inner,
    capture: (input) => {
      const ref = inner.capture(input)
      snapshots.set(ref, input.snapshot)
      return ref
    },
  }
  return {
    draft,
    compress,
    digest,
    reportError,
    snapshot: (ref: DraftCaptureRef) => snapshots.get(ref),
    capture: (input: TestCapture): DraftCaptureRef => {
      supplied.set(input.snapshot, input)
      return draft.capture({ snapshot: input.snapshot, editorSeq: input.seq, formulasPending: input.formulasPending, dedupe: true })
    },
  }
}

/** 旧故事的正文断言从实际发送的字节解码；生产请求不持有正文。仅用于假 codec 的单元测试。 */
export function requestWithSnapshot<T extends { readonly request: SaveRequest, readonly body: Uint8Array }>(call: T) {
  return { ...call, request: { ...call.request, snapshot: new TextDecoder().decode(call.body) } }
}
