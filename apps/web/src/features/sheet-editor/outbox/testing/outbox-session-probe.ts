// 测试构建专用：真实 Worker/IDB 上调用生产准备器。会话与取钥裁决可控，不带入请求层或 zod，不交出密钥。
import type { LocalKeyHandle } from '../../../../shared/outbox/draft-codec.ts'
import type { DraftKey, InFlightSave } from '../../../../shared/outbox/draft-record.ts'
import type { LocalKeyKeeper } from '../../../../shared/outbox/local-key.ts'
import type { OutboxPreparation, OutboxSession, OutboxSessionState } from '../outbox-session.ts'
import type { WorkerLike } from '../outbox-worker-client.ts'
import { gunzipBytes } from '../../../../shared/outbox/draft-codec.ts'
import { createOutboxHost } from '../outbox-host.ts'
import { prepareOutboxSession } from '../outbox-session.ts'
import { createOutboxWorker } from '../outbox-worker-client.ts'

interface Options {
  readonly draft: DraftKey
  readonly epoch: number
  readonly mode?: 'worker' | 'initial-failure' | 'disabled' | 'no-locks' | 'no-key'
}

type Fact = Readonly<Record<string, unknown>> & { readonly kind: string }

function fact(result: OutboxPreparation | OutboxSessionState): Fact {
  if (result.kind === 'memory')
    return { kind: result.kind, reason: result.reason, existingKind: result.existing?.kind, lastDraftSeq: result.lastDraftSeq }
  if (result.kind === 'lost')
    return { kind: result.kind, verdict: result.verdict.kind }
  return result
}

interface Entry {
  readonly session: OutboxSession
  readonly counts: { keys: number, hosts: number, persists: number, confirmations: number }
  readonly workers: WorkerLike[]
  readonly changeKey: (key: LocalKeyHandle | undefined) => void
}

const FORMAT = { clientBuild: '0.1.0', univerVersion: '0.12.4', profile: 'sheet-v1', formatVersion: 1 }

export function createOutboxSessionProbe(options: { readonly key: () => LocalKeyHandle | undefined }) {
  const entries = new Map<number, Entry>()
  const reads = new Map<number, Promise<Fact>>()
  let nextId = 0

  function entry(id: number): Entry {
    const value = entries.get(id)
    if (value === undefined)
      throw new Error(`没有会话 ${id}`)
    return value
  }

  async function read(id: number): Promise<Fact> {
    const result = await entry(id).session.read()
    if (result.kind === 'draft')
      return { kind: result.kind, meta: result.meta, text: new TextDecoder().decode(await gunzipBytes(result.gzip)) }
    return { kind: result.kind }
  }

  return {
    create: async (input: Options) => {
      let key = input.mode === 'no-key' ? undefined : options.key()
      const counts = { keys: 0, hosts: 0, persists: 0, confirmations: 0 }
      const workers: WorkerLike[] = []
      const keeper: LocalKeyKeeper = {
        current: () => key,
        ensure: async () => {
          counts.keys += 1
          return key ?? { kind: 'unavailable', retryAt: 10_000 }
        },
        observeVersion: () => {},
        discard: () => { key = undefined },
        subscribe: () => () => {},
      }
      const session = prepareOutboxSession({
        enabled: input.mode !== 'disabled',
        key: input.draft,
        writeEpoch: input.epoch,
        newWriterId: () => crypto.randomUUID(),
        keeper,
        still: () => true,
        ...(input.mode === 'no-locks' ? { supported: () => false } : {}),
        confirm: async () => {
          counts.confirmations += 1
          return { kind: 'current' }
        },
        persist: async () => {
          counts.persists += 1
          return { kind: 'denied' }
        },
        host: async (signal) => {
          counts.hosts += 1
          return createOutboxHost({ signal, createWorker: () => {
            if (input.mode === 'initial-failure')
              throw new DOMException('测试：启动失败', 'NotSupportedError')
            const worker = createOutboxWorker()
            workers.push(worker)
            return worker
          } })
        },
      })
      const id = ++nextId
      entries.set(id, { session, counts, workers, changeKey: (next) => {
        key = next
      } })
      return { id, result: fact(await session.ready()) }
    },
    write: async (id: number, draftSeq: number, text: string, inFlight: InFlightSave | null = null): Promise<Fact> => {
      const result = await entry(id).session.write({ draftSeq, baseRevision: 1, writtenBy: 'outbox-session-probe', format: FORMAT, formulasPending: false, inFlight, bytes: new TextEncoder().encode(text), dedupe: false })
      if (result.kind === 'written')
        return { kind: result.kind, digest: result.digest, text: new TextDecoder().decode(await gunzipBytes(result.gzip)) }
      return { kind: result.kind }
    },
    read,
    startRead: (id: number) => { reads.set(id, read(id)) },
    readResult: async (id: number) => reads.get(id),
    markInFlight: async (id: number, inFlight: InFlightSave) => entry(id).session.markInFlight(inFlight),
    confirm: async (id: number, draftSeq: number, revision: number) => entry(id).session.confirm(draftSeq, revision),
    setKey: async (id: number, source: 'probe' | 'none') => {
      const target = entry(id)
      const key = source === 'probe' ? options.key() : undefined
      target.changeKey(key)
      return target.session.setKey(key)
    },
    suspend: (id: number) => entry(id).session.suspend(),
    resume: async (id: number) => fact(await entry(id).session.resume()),
    state: (id: number) => fact(entry(id).session.view()),
    counts: (id: number) => ({ ...entry(id).counts }),
    terminate: (id: number) => entry(id).workers.at(-1)?.terminate(),
    dispose: (id: number) => entry(id).session.dispose(),
    disposeAll: () => {
      for (const value of entries.values())
        value.session.dispose()
      entries.clear()
      reads.clear()
    },
  }
}
