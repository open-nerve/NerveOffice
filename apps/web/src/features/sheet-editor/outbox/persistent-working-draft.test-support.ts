import type { LocalKeyHandle } from '../../../shared/outbox/draft-codec.ts'
import type { LocalKeyKeeper, LocalKeyProblem } from '../../../shared/outbox/local-key.ts'
import type { LeaseVerdict } from '../edit-lease.ts'
import type { WorkingDraftOptions } from '../working-draft.ts'
import type { OutboxHost } from './outbox-host.ts'
import { vi } from 'vitest'
import { CLIENT_INSTANCE_ID, DOCUMENT_ID, NOW, sampleMeta, USER_ID, WRITER_ID } from '../../../shared/outbox/draft-record.test-support.ts'
import { fakeDraftStore } from '../../../shared/outbox/draft-store.test-support.ts'
import { createDraftWriter } from '../../../shared/outbox/draft-writer.ts'
import { prepareOutboxSession } from './outbox-session.ts'

export const DRAFT_KEY = { userId: USER_ID, documentId: DOCUMENT_ID }
export const DRAFT_OPTIONS: WorkingDraftOptions = { sessionId: 'edit-1', initialDraftSeq: 0, baseRevision: 7, format: sampleMeta().format, writtenBy: CLIENT_INSTANCE_ID, reportError: () => {} }

export async function newKey(version: number): Promise<LocalKeyHandle> {
  return { version, key: await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['encrypt', 'decrypt']) }
}

/** 实际 P1 writer + fence 的内存存储，只有宿主放置被替换；真实 Worker/IDB 留浏览器矩阵。 */
export async function persistentHarness() {
  const store = fakeDraftStore()
  const key = await newKey(1)
  let current: LocalKeyHandle | undefined = key
  const keeper: LocalKeyKeeper = { current: () => current, ensure: async (): Promise<LocalKeyHandle | LocalKeyProblem> => current ?? { kind: 'unavailable', retryAt: NOW + 1_000 }, subscribe: () => () => {}, discard: () => {
    current = undefined
  }, observeVersion: () => {} }
  const hosts: { readonly host: OutboxHost, readonly break: () => void }[] = []
  const host = vi.fn(async () => {
    const writer = createDraftWriter({ store: store.store, now: () => NOW })
    let broken = false
    const instance: OutboxHost = { kind: 'in-process', writer, broken: () => broken, dispose: () => {
      broken = true
      writer.dispose()
    } }
    hosts.push({ host: instance, break: () => {
      broken = true
    } })
    return instance
  })
  const confirm = vi.fn(async (): Promise<LeaseVerdict> => ({ kind: 'current' }))
  let serial = 0
  const session = prepareOutboxSession({ enabled: true, key: DRAFT_KEY, writeEpoch: 3, newWriterId: () => `${WRITER_ID}-${++serial}`, keeper, confirm, host, persist: async () => ({ kind: 'denied' }), supported: () => true, still: () => true })
  const result = await session.ready()
  if (result.kind !== 'ready')
    throw new Error('测试需要首次持久准备成功')
  const writer = hosts[0]?.host.writer
  if (writer === undefined)
    throw new Error('测试需要准备好的宿主')
  const reportError = vi.fn()
  return { store, key, session, writer, host, hosts, confirm, reportError, options: { ...DRAFT_OPTIONS, initialDraftSeq: result.lastDraftSeq, reportError, key: DRAFT_KEY, session }, changeKey: (next: LocalKeyHandle | undefined) => {
    current = next
  } }
}
