// P1 写入结果适配为公共内容来源。这里只留身份/序号/摘要，不另存 gzip；所有正文归 working-draft-source 的当前项或固定上传。
import type { LocalKeyHandle } from '../../../shared/outbox/draft-codec.ts'
import type { DraftKey } from '../../../shared/outbox/draft-record.ts'
import type { CaptureWritten, KeyChange, WriterProblem } from '../../../shared/outbox/draft-writer.ts'
import type { WriterIdentity } from '../../../shared/outbox/writer-fence.ts'
import type { DraftRetention, DraftWriteInput, WrittenDraftContent } from '../working-draft-source.ts'
import type { DraftCaptureRef, DraftMemoryReason, WorkingDraft, WorkingDraftOptions } from '../working-draft.ts'
import type { OutboxPreparation, OutboxSession, OutboxSessionState } from './outbox-session.ts'
import { gzipBytes } from '../../../shared/outbox/draft-codec.ts'
import { isSameWriter } from '../../../shared/outbox/writer-fence.ts'
import { createWorkingDraftSource } from '../working-draft-source.ts'

export interface PersistentWorkingDraftOptions extends WorkingDraftOptions {
  readonly key: DraftKey
  /** 初次 ready 已结束；之后由这个来源独占文档的写入/读回顺序。 */
  readonly session: OutboxSession
}

export interface PersistentWorkingDraft extends WorkingDraft {
  readonly suspend: () => void
  readonly resume: () => Promise<OutboxPreparation>
  readonly setKey: (key: LocalKeyHandle | undefined) => Promise<KeyChange>
  /** 先同步停写/取钥，保留正文后关闭旧宿主；保留失败也必须释放旧钥。 */
  readonly discardKey: () => Promise<DraftRetention>
}

interface StoredContent {
  readonly writer: WriterIdentity
  readonly contentSeq: number
  readonly digest: string
  readonly baseRevision: number
  readonly formulasPending: boolean
  readonly local: Extract<WrittenDraftContent['local'], { readonly kind: 'persisted' }>
}

function problem(name: string, message: string): Error {
  return Object.assign(new Error(message), { name })
}

function reasonOf(state: OutboxSessionState): DraftMemoryReason {
  return state.kind === 'memory' ? state.reason : state.kind === 'lost' ? 'fenced' : 'unavailable'
}

function writeProblem(result: CaptureWritten): WriterProblem | undefined {
  switch (result.kind) {
    case 'failed': return { kind: 'failed', error: result.error }
    case 'unavailable': return { kind: 'unavailable', reason: result.reason }
    case 'quota': return { kind: 'quota' }
    case 'no-key':
    case 'fenced':
    case 'written':
    case 'unchanged': return undefined
  }
}

const RETRYABLE: ReadonlySet<DraftMemoryReason> = new Set(['no-key', 'quota', 'unavailable', 'fenced', 'worker-failed'])

export function createPersistentWorkingDraft(options: PersistentWorkingDraftOptions): PersistentWorkingDraft {
  const { session } = options
  if (!Number.isSafeInteger(options.initialDraftSeq) || options.initialDraftSeq < 0)
    throw new RangeError('工作草稿的序号起点必须是非负安全整数')
  const initial = session.view()
  if (initial.kind === 'preparing')
    throw problem('OutboxNotPrepared', '先等初次宿主准备结束，再建立工作草稿来源')
  let disposed = false
  let paused = false
  let changingKey = false
  let generation = 0
  let resuming: { readonly generation: number, readonly promise: Promise<OutboxPreparation> } | undefined
  let highWater = initial.kind === 'ready' || initial.kind === 'memory' ? initial.lastDraftSeq ?? 0 : 0
  let last: StoredContent | undefined
  const stored = new WeakMap<DraftCaptureRef, StoredContent>()

  async function memory(input: DraftWriteInput, reason: DraftMemoryReason, gzip?: Uint8Array<ArrayBuffer>, storageProblem?: WriterProblem): Promise<WrittenDraftContent> {
    if (gzip === undefined) {
      let bytes = input.bytes
      if (bytes.byteLength !== input.ref.bytes) {
        const snapshot = input.fallbackSnapshot()
        if (snapshot === undefined)
          throw problem('DraftContentMissing', '转移的捕获已被取代，不能拿别的内容补作这一次上传')
        bytes = new TextEncoder().encode(snapshot)
      }
      gzip = await gzipBytes(bytes)
    }
    return { contentSeq: input.ref.draftSeq, digest: undefined, local: { kind: 'memory', reason, ...(storageProblem === undefined ? {} : { problem: storageProblem }) }, gzip, retainBody: true }
  }

  function currentWriter(record: StoredContent): boolean {
    const state = session.view()
    return !paused && !changingKey && state.kind === 'ready' && isSameWriter(state.writer, record.writer)
  }

  function sequenceFloor(): number {
    const state = session.view()
    if (state.kind === 'ready' || state.kind === 'memory')
      highWater = Math.max(highWater, state.lastDraftSeq ?? 0)
    return highWater
  }

  const source = createWorkingDraftSource({ ...options, initialDraftSeq: Math.max(options.initialDraftSeq, highWater) }, {
    sequenceFloor,
    write: async (input) => {
      if (paused || changingKey)
        return memory(input, paused ? 'paused' : 'no-key')
      let state = session.view()
      if (state.kind === 'memory' && RETRYABLE.has(state.reason)) {
        last = undefined
        if (state.reason === 'no-key') {
          const refreshed = await session.refreshKey()
          state = refreshed.kind === 'no-host' ? await session.resume() : session.view()
        }
        else {
          state = await session.resume()
        }
      }
      if (disposed)
        throw problem('InvalidStateError', '工作草稿来源已销毁')
      if (paused || changingKey)
        return memory(input, paused ? 'paused' : 'no-key')
      if (state.kind === 'ready' || state.kind === 'memory')
        highWater = Math.max(highWater, state.lastDraftSeq ?? 0)
      if (state.kind !== 'ready')
        return memory(input, reasonOf(state), undefined, state.kind === 'memory' ? state.problem : undefined)
      // 新登记读到了更高的水位：当前引用的同步分配已经结束，不偷换序号；本次退内存，后续 capture 吸收水位。
      if (input.ref.draftSeq <= highWater)
        return memory(input, 'fenced')
      const previous = last
      const dedupe = input.dedupe && input.inFlight === null && previous !== undefined && isSameWriter(previous.writer, state.writer) && previous.baseRevision === input.baseRevision
      const result = await session.write({ draftSeq: input.ref.draftSeq, baseRevision: input.baseRevision, writtenBy: options.writtenBy, format: options.format, formulasPending: input.ref.formulasPending, inFlight: input.inFlight, bytes: input.bytes, dedupe })
      if (disposed)
        throw problem('InvalidStateError', '工作草稿来源已销毁')
      if (result.kind === 'written') {
        const record: StoredContent = { writer: state.writer, contentSeq: input.ref.draftSeq, digest: result.digest, baseRevision: input.baseRevision, formulasPending: input.ref.formulasPending, local: { kind: 'persisted', mirror: result.mirror } }
        last = record
        stored.set(input.ref, record)
        highWater = Math.max(highWater, record.contentSeq)
        return { contentSeq: record.contentSeq, digest: result.digest, local: record.local, gzip: result.gzip, retainBody: false }
      }
      if (result.kind === 'unchanged') {
        if (!dedupe || previous === undefined || previous.digest !== result.digest || previous.formulasPending !== input.ref.formulasPending)
          return memory(input, 'unavailable')
        stored.set(input.ref, previous)
        return { contentSeq: previous.contentSeq, digest: previous.digest, local: previous.local, gzip: undefined, retainBody: false }
      }
      last = undefined
      return memory(input, result.kind === 'failed' ? reasonOf(session.view()) : result.kind, result.gzip ?? undefined, writeProblem(result))
    },
    read: async (summary) => {
      const identity = stored.get(summary.ref)
      if (identity === undefined)
        throw problem('DraftContentMissing', '这个引用没有可读回的持久记录')
      let read = await session.read()
      if (read.kind === 'failed' || read.kind === 'unavailable' || read.kind === 'no-key')
        read = await session.readRecovered()
      if (disposed)
        throw problem('InvalidStateError', '工作草稿来源已销毁')
      if (read.kind !== 'draft')
        throw problem('DraftContentUnavailable', `无法读回这份内容（${read.kind}），原记录保留`)
      if (read.meta.userId !== options.key.userId || read.meta.documentId !== options.key.documentId || !isSameWriter(read.meta, identity.writer) || read.meta.draftSeq !== identity.contentSeq || read.meta.draftSeq !== summary.contentSeq)
        throw problem('DraftIdentityMismatch', '持久记录的文档、写入者或内容序号与捕获引用不符')
      return read.gzip
    },
    markInFlight: async (summary, inFlight) => {
      const identity = stored.get(summary.ref)
      if (identity === undefined || !currentWriter(identity))
        return { kind: 'memory', reason: summary.local.kind === 'memory' ? summary.local.reason : reasonOf(session.view()) }
      return session.markInFlight(inFlight)
    },
    confirm: async (summary, revision) => {
      const identity = stored.get(summary.ref)
      const result = identity !== undefined && currentWriter(identity)
        ? await session.confirm(summary.contentSeq, revision)
        : { kind: 'memory' as const, reason: summary.local.kind === 'memory' ? summary.local.reason : reasonOf(session.view()) }
      // 回执已确认云端内容，无论本机删除/重封是否成功都让下一次捕获真正写下当前基准。
      // 特别是 deleted 后不能继续使用 P1 留下的 dedupe 键，把不存在的记录说成 unchanged。
      last = undefined
      if (!paused && !changingKey)
        await session.seedDigest(undefined)
      return result
    },
    dispose: () => {
      disposed = true
      generation += 1
      last = undefined
      session.dispose()
    },
  })

  const inactive: KeyChange = { kind: 'failed', error: { name: 'WorkingDraftInactive', message: '草稿已暂停、销毁或生命周期已进入下一代' } }

  function current(run: number): boolean {
    return !disposed && generation === run
  }

  async function rewriteLatest(run: number): Promise<void> {
    const content = await source.readLatest()
    const latest = source.view()
    if (!current(run) || content.kind !== 'snapshot' || latest.kind !== 'working' || latest.ref !== content.ref)
      return
    const ref = source.capture({ snapshot: content.snapshot, editorSeq: content.ref.editorSeq, formulasPending: content.ref.formulasPending, dedupe: false })
    await source.ready(ref)
  }

  function stopped(): OutboxPreparation {
    const state = session.view()
    return state.kind === 'preparing' ? { kind: 'memory', reason: 'paused' } : state
  }

  async function resume(run: number): Promise<OutboxPreparation> {
    const kept = await source.retainLatest('paused')
    if (!current(run))
      return stopped()
    if (kept.kind === 'failed')
      return { kind: 'memory', reason: 'unavailable', problem: { kind: 'failed', error: kept.error } }
    const result = await session.resume()
    if (!current(run))
      return stopped()
    paused = false
    if (result.kind === 'ready')
      await rewriteLatest(run)
    return current(run) ? result : stopped()
  }

  return {
    ...source,
    suspend: () => {
      if (disposed)
        return
      generation += 1
      paused = true
      changingKey = false
      session.suspend()
      // 内部保留只交回元数据，已完成的 Promise 不另持有正文。
      void source.retainLatest('paused')
    },
    discardKey: async () => {
      if (disposed)
        return { kind: 'disposed' }
      generation += 1
      paused = true
      changingKey = false
      last = undefined
      const finish = session.beginKeyDiscard()
      try {
        return await source.retainLatest('paused')
      }
      finally {
        // 即使保留失败、销毁或开始了新一代，仍须关闭这个旧宿主；finish 绑定身份，不能碰新宿主。
        finish()
      }
    },
    resume: async () => {
      if (disposed)
        return { kind: 'disposed' }
      if (resuming?.generation === generation)
        return resuming.promise
      const run = ++generation
      paused = true
      changingKey = false
      const promise = resume(run)
      resuming = { generation: run, promise }
      try {
        return await promise
      }
      finally {
        if (resuming?.generation === run)
          resuming = undefined
      }
    },
    setKey: async (handle) => {
      if (disposed || paused)
        return inactive
      const run = ++generation
      changingKey = true
      last = undefined
      try {
        const kept = await source.retainLatest('no-key')
        if (!current(run) || paused || kept.kind === 'failed')
          return kept.kind === 'failed' ? { kind: 'failed', error: kept.error } : inactive
        const result = await session.setKey(handle)
        if (!current(run) || paused)
          return inactive
        changingKey = false
        // 包括 notResealed：当前内容已由来源持有，用新钥明确写一次，不能沿用旧摘要跳过。
        if (result.kind === 'key-set' && handle !== undefined && session.view().kind === 'ready')
          await rewriteLatest(run)
        return current(run) ? result : inactive
      }
      finally {
        if (current(run))
          changingKey = false
      }
    },
  }
}
