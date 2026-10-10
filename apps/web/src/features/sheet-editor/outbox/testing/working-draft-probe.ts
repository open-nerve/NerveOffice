// 仅测试构建使用：保留生产来源的引用身份，跨页面边界只交回元数据和测试用的解压文本。
import type { LocalKeyHandle } from '../../../../shared/outbox/draft-codec.ts'
import type { DraftKey, InFlightSave } from '../../../../shared/outbox/draft-record.ts'
import type { LocalKeyKeeper } from '../../../../shared/outbox/local-key.ts'
import type { DraftCaptureRef, DraftReadLatest, PreparedDraft, WorkingDraft } from '../../working-draft.ts'
import type { OutboxSession } from '../outbox-session.ts'
import type { WorkerLike } from '../outbox-worker-client.ts'
import type { PersistentWorkingDraft } from '../persistent-working-draft.ts'
import { gunzipBytes, sha256Hex } from '../../../../shared/outbox/draft-codec.ts'
import { createMemoryWorkingDraft } from '../../memory-working-draft.ts'
import { createOutboxHost } from '../outbox-host.ts'
import { prepareOutboxSession } from '../outbox-session.ts'
import { createOutboxWorker } from '../outbox-worker-client.ts'
import { createPersistentWorkingDraft } from '../persistent-working-draft.ts'

interface Entry {
  readonly source: WorkingDraft
  readonly persistent: PersistentWorkingDraft | undefined
  readonly session: OutboxSession
  readonly refs: Map<number, DraftCaptureRef>
  readonly workers: WorkerLike[]
  readonly counts: { keys: number, hosts: number, confirmations: number }
  readonly changeKey: (key: LocalKeyHandle | undefined) => void
  upload: PreparedDraft | undefined
}

const FORMAT = { clientBuild: '0.1.0', univerVersion: '0.12.4', profile: 'sheet-v1', formatVersion: 1 }

export function createWorkingDraftProbe(options: { readonly key: () => LocalKeyHandle | undefined }) {
  const entries = new Map<number, Entry>()
  const reads = new Map<number, Promise<DraftReadLatest>>()
  let serial = 0

  function entry(id: number): Entry {
    const value = entries.get(id)
    if (value === undefined)
      throw new Error(`没有工作草稿 ${id}`)
    return value
  }

  function refOf(id: number, serial: number): DraftCaptureRef {
    const value = entry(id).refs.get(serial)
    if (value === undefined)
      throw new Error('没有这一次捕获')
    return value
  }

  function uploadOf(id: number): PreparedDraft {
    const value = entry(id).upload
    if (value === undefined)
      throw new Error('尚未固定上传')
    return value
  }

  return {
    create: async (input: { readonly draft: DraftKey, readonly mode: 'worker' | 'initial-failure' | 'memory' }) => {
      let key = options.key()
      const counts = { keys: 0, hosts: 0, confirmations: 0 }
      const workers: WorkerLike[] = []
      const keeper: LocalKeyKeeper = {
        current: () => key,
        ensure: async () => {
          counts.keys += 1
          return key ?? { kind: 'unavailable', retryAt: 10_000 }
        },
        observeVersion: () => {},
        discard: () => {
          key = undefined
        },
        subscribe: () => () => {},
      }
      const session = prepareOutboxSession({
        enabled: input.mode !== 'memory',
        key: input.draft,
        writeEpoch: 3,
        keeper,
        still: () => true,
        newWriterId: () => crypto.randomUUID(),
        persist: async () => ({ kind: 'denied' }),
        confirm: async () => {
          counts.confirmations += 1
          return { kind: 'current' }
        },
        host: async (signal) => {
          counts.hosts += 1
          return createOutboxHost({ signal, createWorker: () => {
            if (input.mode === 'initial-failure')
              throw new DOMException('测试：Worker 启动失败', 'NotSupportedError')
            const worker = createOutboxWorker()
            workers.push(worker)
            return worker
          } })
        },
      })
      const result = await session.ready()
      const id = ++serial
      const common = { sessionId: `working-probe-${id}`, initialDraftSeq: result.kind === 'ready' ? result.lastDraftSeq : 0, baseRevision: 7, format: FORMAT, writtenBy: 'working-draft-probe', reportError: () => {} }
      const persistent = input.mode === 'memory' ? undefined : createPersistentWorkingDraft({ ...common, key: input.draft, session })
      const source = persistent ?? createMemoryWorkingDraft({ ...common, reason: 'disabled' })
      entries.set(id, { source, persistent, session, refs: new Map(), workers, counts, upload: undefined, changeKey: (next) => {
        key = next
      } })
      return { id, result }
    },
    capture: (id: number, snapshot: string, editorSeq: number, dedupe = true) => {
      const target = entry(id)
      const ref = target.source.capture({ snapshot, editorSeq, dedupe, formulasPending: false })
      target.refs.set(ref.serial, ref)
      return ref
    },
    ready: async (id: number, serial: number) => entry(id).source.ready(refOf(id, serial)),
    prepare: async (id: number, serial: number) => {
      const target = entry(id)
      const result = await target.source.prepare(refOf(id, serial))
      if (result.kind !== 'prepared')
        return result
      target.upload = result
      const { gzip, ...metadata } = result
      return { ...metadata, gzipBytes: gzip.byteLength, gzipHash: await sha256Hex(gzip), text: new TextDecoder().decode(await gunzipBytes(gzip)) }
    },
    release: (id: number) => {
      const target = entry(id)
      if (target.upload !== undefined)
        target.source.release(target.upload)
      target.upload = undefined
    },
    markInFlight: async (id: number, inFlight: InFlightSave) => entry(id).source.markInFlight(uploadOf(id), inFlight),
    confirm: async (id: number, revision: number) => entry(id).source.confirm(uploadOf(id), revision),
    readLatest: async (id: number) => entry(id).source.readLatest(),
    view: (id: number) => entry(id).source.view(),
    setKey: async (id: number, from: 'probe' | 'none') => {
      const target = entry(id)
      const key = from === 'probe' ? options.key() : undefined
      target.changeKey(key)
      return target.persistent?.setKey(key) ?? { kind: 'memory' }
    },
    suspend: (id: number) => entry(id).persistent?.suspend(),
    resume: async (id: number) => entry(id).persistent?.resume() ?? { kind: 'memory' },
    terminate: (id: number) => entry(id).workers.at(-1)?.terminate(),
    startRead: (id: number) => {
      reads.set(id, entry(id).source.readLatest())
    },
    readResult: async (id: number) => {
      const result = await reads.get(id)
      reads.delete(id)
      return result
    },
    counts: (id: number) => ({ ...entry(id).counts }),
    disposeAll: () => {
      for (const target of entries.values()) {
        target.source.dispose()
        target.session.dispose()
      }
      entries.clear()
      reads.clear()
    },
  }
}
