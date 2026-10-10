// 内容所有权与串行调度：普通捕获只有执行中和最新待处理两格；另允许一份同步固定的上传。
// 后端只处理字节和存储，不能缓存另一份页面正文。所有长期 Promise 的结果除 prepare 外都只有元数据。
import type { InFlightSave } from '../../shared/outbox/draft-record.ts'
import type { DraftCapture, DraftCaptureRef, DraftFailure, DraftLocalFact, DraftMemoryReason, DraftMutation, DraftPreparation, DraftReadLatest, DraftReady, DraftSummary, PreparedDraft, WorkingDraft, WorkingDraftOptions, WorkingDraftView } from './working-draft.ts'
import { gunzipBytes, gzipBytes } from '../../shared/outbox/draft-codec.ts'
import { describeFailure } from '../../shared/outbox/failure.ts'

export interface DraftWriteInput {
  readonly ref: DraftCaptureRef
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly baseRevision: number
  readonly inFlight: InFlightSave | null
  readonly dedupe: boolean
  /** 仅故障时读对应捕获仍归来源拥有的临时文本；不能在后端另存一份。 */
  readonly fallbackSnapshot: () => string | undefined
}

export interface WrittenDraftContent {
  readonly contentSeq: number
  readonly digest: string | undefined
  readonly local: DraftLocalFact
  readonly gzip: Uint8Array<ArrayBuffer> | undefined
  /** 内存退路留在来源；写成了则只给当前固定上传，其他情况立即释放。 */
  readonly retainBody: boolean
}

export interface WorkingDraftBackend {
  /** 恢复登记后观察到的高水位，只在下一次同步 capture 分配时吸收。 */
  readonly sequenceFloor?: () => number
  readonly write: (input: DraftWriteInput) => Promise<WrittenDraftContent>
  readonly read: (summary: DraftSummary) => Promise<Uint8Array<ArrayBuffer>>
  readonly markInFlight: (summary: DraftSummary, inFlight: InFlightSave) => Promise<DraftMutation>
  readonly confirm: (summary: DraftSummary, revision: number) => Promise<DraftMutation>
  readonly dispose: () => void
}

export type DraftRetention = { readonly kind: 'retained', readonly ref: DraftCaptureRef } | { readonly kind: 'empty' | 'disposed' } | DraftFailure

/** 只交给持久适配层的生命周期能力，不把正文交给第二个所有者。 */
export interface ControlledWorkingDraft extends WorkingDraft {
  readonly retainLatest: (reason: DraftMemoryReason) => Promise<DraftRetention>
}

interface Entry {
  readonly ref: DraftCaptureRef
  readonly dedupe: boolean
  readonly ready: Promise<DraftReady>
  readonly settle: (result: DraftReady) => void
  result: DraftReady | undefined
  summary: DraftSummary | undefined
  snapshot: string | undefined
  bytes: Uint8Array<ArrayBuffer> | undefined
  gzip: Uint8Array<ArrayBuffer> | undefined
  retainBody: boolean
  started: boolean
}

interface Pin {
  readonly entry: Entry
  readonly promise: Promise<DraftPreparation>
  readonly resolve: (result: DraftPreparation) => void
  prepared: PreparedDraft | undefined
  settled: boolean
}

function fault(name: string, message: string): Error {
  return Object.assign(new Error(message), { name })
}

function failed(ref: DraftCaptureRef, error: unknown): DraftFailure {
  return { kind: 'failed', ref, error: describeFailure(error) }
}

/** 公共接口没有原始后端，调用方不能绕过引用、固定上传或队列。 */
export function createWorkingDraftSource(options: WorkingDraftOptions, backend: WorkingDraftBackend): ControlledWorkingDraft {
  if (!Number.isSafeInteger(options.initialDraftSeq) || options.initialDraftSeq < 0)
    throw new RangeError('工作草稿的序号起点必须是非负安全整数')
  let draftSeq = options.initialDraftSeq
  let serial = 0
  let baseRevision = options.baseRevision
  let inFlight: InFlightSave | null = null
  let inFlightGeneration = 0
  let needsMetadataWrite = false
  let disposed = false
  let running = false
  let executing: Entry | undefined
  let latest: Entry | undefined
  let pending: Entry | undefined
  let pin: Pin | undefined
  let publication = 0
  const format = Object.freeze({ ...options.format })
  const entries = new WeakMap<DraftCaptureRef, Entry>()
  const listeners = new Set<() => void>()
  const controls: (() => Promise<void>)[] = []
  const cancelControls = new Set<() => void>()
  let reading: { readonly entry: Entry, readonly promise: Promise<DraftReadLatest>, readonly resolve: (result: DraftReadLatest) => void } | undefined

  function report(error: unknown): void {
    if (disposed)
      return
    try {
      options.reportError(error)
    }
    catch {
      // 上报故障不能中断内容的交回和后续捕获。
    }
  }

  function publish(): void {
    const current = ++publication
    for (const listener of [...listeners]) {
      if (disposed || publication !== current)
        break
      try {
        listener()
      }
      catch (error) {
        report(error)
      }
    }
  }

  function kept(entry: Entry): boolean {
    return !disposed && (entry === latest || entry === pin?.entry || entry === reading?.entry)
  }

  function clear(entry: Entry): void {
    entry.snapshot = undefined
    entry.bytes = undefined
    entry.gzip = undefined
  }

  function drop(entry: Entry | undefined): void {
    if (entry !== undefined && !kept(entry))
      clear(entry)
  }

  function settle(entry: Entry, result: DraftReady): void {
    if (entry.result !== undefined)
      return
    entry.result = result
    entry.settle(result)
    if (entry === latest && !disposed)
      publish()
  }

  function supersede(entry: Entry): void {
    if (!entry.started)
      settle(entry, { kind: 'superseded', ref: entry.ref })
    drop(entry)
  }

  async function write(entry: Entry): Promise<void> {
    executing = entry
    entry.started = true
    if (pending === entry)
      pending = undefined
    const bytes = entry.bytes
    try {
      if (bytes === undefined)
        throw fault('DraftContentMissing', '待处理的工作草稿没有正文')
      const metadataGeneration = inFlightGeneration
      const result = await backend.write({ ref: entry.ref, bytes, baseRevision, inFlight, dedupe: entry.dedupe && !needsMetadataWrite, fallbackSnapshot: () => kept(entry) ? entry.snapshot : undefined })
      // unchanged 不带 gzip；若暂停已要求保留，仍握有的本次文本必须先变成内存内容，不能赌稍后的库还能读。
      const gzip = result.gzip ?? (entry.retainBody && kept(entry) && entry.snapshot !== undefined ? await gzipBytes(new TextEncoder().encode(entry.snapshot)) : undefined)
      if (disposed)
        return
      if (result.local.kind === 'persisted' && metadataGeneration === inFlightGeneration)
        needsMetadataWrite = false
      entry.summary = { kind: 'ready', ref: entry.ref, contentSeq: result.contentSeq, digest: result.digest, baseRevision, format, local: result.local, confirmedRevision: undefined }
      entry.retainBody ||= result.retainBody
      if (kept(entry) && (entry.retainBody || pin?.entry === entry || reading?.entry === entry))
        entry.gzip = gzip
      entry.snapshot = undefined
      entry.bytes = undefined
      settle(entry, entry.summary)
    }
    catch (error) {
      if (!disposed) {
        report(error)
        settle(entry, failed(entry.ref, error))
      }
    }
    finally {
      executing = undefined
      drop(entry)
    }
  }

  async function body(entry: Entry): Promise<Uint8Array<ArrayBuffer>> {
    if (entry.gzip !== undefined)
      return entry.gzip
    if (pin?.entry === entry && pin.prepared !== undefined)
      return pin.prepared.gzip
    if (entry.summary === undefined)
      throw fault('DraftContentMissing', '工作草稿尚未准备好')
    return backend.read(entry.summary)
  }

  async function preparePinned(target: Pin): Promise<void> {
    const entry = target.entry
    try {
      if (entry.summary === undefined) {
        target.resolve(entry.result !== undefined && entry.result.kind !== 'ready' ? entry.result : failed(entry.ref, fault('DraftContentMissing', '工作草稿尚未准备好')))
        return
      }
      const gzip = await body(entry)
      if (disposed || pin !== target)
        return
      const { contentSeq, digest, baseRevision, format } = entry.summary
      target.prepared = { kind: 'prepared', ref: entry.ref, contentSeq, gzip, digest, baseRevision, format, formulasPending: entry.ref.formulasPending }
      target.resolve(target.prepared)
    }
    catch (error) {
      if (!disposed) {
        report(error)
        target.resolve(failed(entry.ref, error))
      }
    }
    finally {
      target.settled = true
      if (target.prepared === undefined && pin === target) {
        pin = undefined
        drop(entry)
      }
    }
  }

  function pump(): void {
    if (running || disposed)
      return
    let task: (() => Promise<void>) | undefined = controls.shift()
    if (task === undefined && pin !== undefined && !pin.settled) {
      const target = pin
      task = target.entry.result === undefined ? async () => write(target.entry) : async () => preparePinned(target)
    }
    if (task === undefined && pending !== undefined) {
      const next = pending
      task = async () => write(next)
    }
    if (task === undefined)
      return
    running = true
    void task().catch(report).finally(() => {
      running = false
      pump()
    })
  }

  function invalidUpload(): DraftMutation {
    return { kind: 'failed', error: { name: 'InvalidPreparedDraft', message: '上传已释放、不是当前固定上传，或来源已销毁' } }
  }

  async function mutate(prepared: PreparedDraft, task: (entry: Entry) => Promise<DraftMutation>): Promise<DraftMutation> {
    const target = pin
    if (disposed || target?.prepared !== prepared)
      return Promise.resolve(invalidUpload())
    return new Promise((resolve) => {
      let settled = false
      function finish(result: DraftMutation): void {
        if (settled)
          return
        settled = true
        cancelControls.delete(cancel)
        resolve(result)
      }
      function cancel(): void {
        finish(invalidUpload())
      }
      cancelControls.add(cancel)
      controls.push(async () => {
        if (disposed || pin !== target) {
          cancel()
          return
        }
        try {
          finish(await task(target.entry))
        }
        catch (error) {
          if (!disposed)
            report(error)
          finish({ kind: 'failed', error: describeFailure(error) })
        }
      })
      pump()
    })
  }

  function view(): WorkingDraftView {
    if (disposed)
      return { kind: 'disposed' }
    if (latest === undefined)
      return { kind: 'empty' }
    return { kind: 'working', ref: latest.ref, local: latest.summary?.local ?? (latest.result?.kind === 'failed' ? { kind: 'memory', reason: 'unavailable' } : { kind: 'writing' }), summary: latest.summary ?? latest.result }
  }

  return {
    retainLatest: async (reason) => {
      if (disposed)
        return { kind: 'disposed' }
      const entry = latest
      if (entry === undefined)
        return { kind: 'empty' }
      const ref = entry.ref
      // 这个意图跨过已开始的 write：即使写成也接住 gzip，随后才能关闭旧宿主。
      entry.retainBody = true
      if (!entry.started && entry.snapshot !== undefined)
        return { kind: 'retained', ref: entry.ref }
      return new Promise((resolve) => {
        let settled = false
        function finish(result: DraftRetention): void {
          if (settled)
            return
          settled = true
          cancelControls.delete(cancel)
          resolve(result)
        }
        function cancel(): void {
          finish({ kind: 'disposed', ref })
        }
        cancelControls.add(cancel)
        controls.push(async () => {
          if (disposed) {
            cancel()
            return
          }
          if (latest !== entry) {
            finish({ kind: 'superseded', ref: entry.ref })
            return
          }
          try {
            // 写入在压缩前失败时，原文仍是可靠的内存内容。
            if (entry.snapshot !== undefined) {
              finish({ kind: 'retained', ref: entry.ref })
              return
            }
            const gzip = await body(entry)
            if (disposed)
              return
            if (latest !== entry) {
              finish({ kind: 'superseded', ref: entry.ref })
              return
            }
            entry.gzip = gzip
            entry.retainBody = true
            if (entry.summary !== undefined)
              entry.summary = { ...entry.summary, local: { kind: 'memory', reason } }
            publish()
            finish({ kind: 'retained', ref: entry.ref })
          }
          catch (error) {
            if (!disposed) {
              // 清钥时新捕获可先接住当前正文并关闭旧宿主；旧读取的失败不再属于当前内容。
              if (latest !== entry) {
                finish({ kind: 'superseded', ref: entry.ref })
                return
              }
              report(error)
              finish(failed(entry.ref, error))
            }
          }
        })
        pump()
      })
    },
    capture: (capture: DraftCapture) => {
      if (disposed)
        throw fault('InvalidStateError', '工作草稿来源已销毁')
      draftSeq = Math.max(draftSeq, backend.sequenceFloor?.() ?? 0)
      if (!Number.isSafeInteger(draftSeq) || draftSeq < 0 || draftSeq === Number.MAX_SAFE_INTEGER || serial === Number.MAX_SAFE_INTEGER)
        throw new RangeError('工作草稿序号已达到安全整数上限')
      const bytes = new TextEncoder().encode(capture.snapshot)
      const ref: DraftCaptureRef = Object.freeze({ sessionId: options.sessionId, serial: ++serial, draftSeq: ++draftSeq, editorSeq: capture.editorSeq, bytes: bytes.byteLength, formulasPending: capture.formulasPending })
      let resolve!: (result: DraftReady) => void
      const ready = new Promise<DraftReady>((done) => {
        resolve = done
      })
      const entry: Entry = { ref, dedupe: capture.dedupe, ready, settle: resolve, result: undefined, summary: undefined, snapshot: capture.snapshot, bytes, gzip: undefined, retainBody: false, started: false }
      entries.set(ref, entry)
      const previous = latest
      latest = entry
      if (pending !== undefined && pending !== pin?.entry)
        supersede(pending)
      pending = entry
      drop(previous)
      publish()
      pump()
      return ref
    },
    ready: async (ref) => {
      const entry = entries.get(ref)
      if (entry === undefined)
        return Promise.resolve(failed(ref, fault('InvalidCapture', '捕获引用不属于这个来源')))
      return disposed ? Promise.resolve({ kind: 'disposed', ref }) : entry.ready
    },
    prepare: async (ref) => {
      const entry = entries.get(ref)
      if (entry === undefined)
        return Promise.resolve(failed(ref, fault('InvalidCapture', '捕获引用不属于这个来源')))
      if (disposed)
        return Promise.resolve({ kind: 'disposed', ref })
      if (pin?.entry === entry)
        return pin.promise
      if (entry !== latest)
        return Promise.resolve({ kind: 'superseded', ref })
      if (pin !== undefined)
        return Promise.resolve(failed(ref, fault('DraftBusy', '先释放当前固定上传，才能准备下一份')))
      let resolve!: (result: DraftPreparation) => void
      const promise = new Promise<DraftPreparation>((done) => {
        resolve = done
      })
      pin = { entry, promise, resolve, prepared: undefined, settled: false }
      if (pending === entry)
        pending = undefined
      pump()
      return promise
    },
    release: (prepared) => {
      if (pin?.prepared !== prepared)
        return
      const entry = pin.entry
      pin = undefined
      if (inFlight?.localSeq === prepared.contentSeq) {
        inFlight = null
        inFlightGeneration += 1
        // release 表示这个请求已结束；下一次真实落盘清旧标记，不能以同正文 unchanged 跳过。
        needsMetadataWrite = true
      }
      if (!entry.retainBody && reading?.entry !== entry)
        entry.gzip = undefined
      drop(entry)
      pump()
    },
    markInFlight: async (prepared, next) => {
      if (disposed || pin?.prepared !== prepared || next.localSeq !== prepared.contentSeq)
        return Promise.resolve(invalidUpload())
      return mutate(prepared, async (entry) => {
        if (entry.summary === undefined)
          return invalidUpload()
        inFlight = { ...next }
        inFlightGeneration += 1
        return backend.markInFlight(entry.summary, next)
      })
    },
    confirm: async (prepared, revision) => {
      if (disposed || pin?.prepared !== prepared || !Number.isSafeInteger(revision) || revision < 1)
        return Promise.resolve(invalidUpload())
      return mutate(prepared, async (entry) => {
        if (entry.summary === undefined)
          return invalidUpload()
        let outcome: DraftMutation
        try {
          outcome = await backend.confirm(entry.summary, revision)
        }
        catch (error) {
          report(error)
          outcome = { kind: 'failed', error: describeFailure(error) }
        }
        if (disposed)
          return invalidUpload()
        baseRevision = Math.max(baseRevision, revision)
        if (inFlight?.localSeq === prepared.contentSeq) {
          inFlight = null
          inFlightGeneration += 1
        }
        if (latest?.summary !== undefined) {
          const same = latest.summary.contentSeq === prepared.contentSeq
          latest.summary = { ...latest.summary, baseRevision, confirmedRevision: same ? revision : latest.summary.confirmedRevision }
          // 云端已经确认；本机可能已删除却丢了回包，不能再依赖读库取回当前正文。
          if (same) {
            latest.gzip = prepared.gzip
            latest.retainBody = true
            if (outcome.kind === 'deleted')
              latest.summary = { ...latest.summary, local: { kind: 'confirmed', revision } }
          }
          publish()
        }
        return outcome
      })
    },
    readLatest: async () => {
      if (disposed)
        return Promise.resolve({ kind: 'disposed' })
      if (latest === undefined)
        return Promise.resolve({ kind: 'empty' })
      const entry = latest
      if (entry.snapshot !== undefined)
        return Promise.resolve({ kind: 'snapshot', ref: entry.ref, snapshot: entry.snapshot })
      if (reading !== undefined)
        return reading.entry === entry ? reading.promise : Promise.resolve(failed(entry.ref, fault('DraftReadBusy', '旧内容仍在读回，当前内容需要重新读取')))
      let resolve!: (result: DraftReadLatest) => void
      const promise = new Promise<DraftReadLatest>((done) => {
        resolve = done
      })
      const target = { entry, promise, resolve }
      reading = target
      controls.push(async () => {
        try {
          if (disposed) {
            resolve({ kind: 'disposed' })
            return
          }
          const gzip = await body(entry)
          const bytes = await gunzipBytes(gzip)
          resolve(disposed ? { kind: 'disposed' } : { kind: 'snapshot', ref: entry.ref, snapshot: new TextDecoder().decode(bytes) })
        }
        catch (error) {
          if (!disposed) {
            report(error)
            resolve(failed(entry.ref, error))
          }
        }
        finally {
          if (reading === target)
            reading = undefined
          if (!entry.retainBody && pin?.entry !== entry)
            entry.gzip = undefined
          drop(entry)
        }
      })
      pump()
      return promise
    },
    view,
    subscribe: (listener) => {
      if (!disposed)
        listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => {
      if (disposed)
        return
      disposed = true
      publication += 1
      listeners.clear()
      for (const entry of new Set([latest, pending, executing, pin?.entry, reading?.entry])) {
        if (entry === undefined)
          continue
        settle(entry, { kind: 'disposed', ref: entry.ref })
        clear(entry)
      }
      pin?.resolve({ kind: 'disposed', ref: pin.entry.ref })
      reading?.resolve({ kind: 'disposed' })
      for (const cancel of [...cancelControls])
        cancel()
      pin = undefined
      latest = undefined
      pending = undefined
      backend.dispose()
      // 已排入的只读和修改也要结束等待；它们开头检查 disposed，不再触碰后端。
      for (const control of controls.splice(0))
        void control().catch(report)
    },
  }
}
