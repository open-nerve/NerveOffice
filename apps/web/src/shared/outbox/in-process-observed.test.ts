import { describe, expect, it, vi } from 'vitest'
import { sampleMeta } from './draft-record.test-support.ts'
import { fakeDraftStore } from './draft-store.test-support.ts'
import { createDraftWriter } from './draft-writer.ts'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'
import { createInProcessOutboxHost } from './in-process-outbox-host.ts'
import { deferred } from './outbox-lock.test-support.ts'

describe('恢复操作在进程内宿主也受完整时限保护', () => {
  it.each(['timeout', 'dispose'] as const)('%s 后晚到成功不复活宿主，后续调用不再进入管道', async (stop) => {
    const meta = sampleMeta()
    const key = { userId: meta.userId, documentId: meta.documentId }
    const observation = { key, id: 'observation' }
    const capture = { key, writer: { writeEpoch: 4, writerId: 'next' }, draftSeq: 8, baseRevision: 12, writtenBy: meta.writtenBy, format: meta.format, formulasPending: false, bytes: new Uint8Array([1]) }
    const writer = createDraftWriter({ store: fakeDraftStore().store, now: () => 1_000 })
    const pending = deferred<void>()
    const observe = vi.spyOn(writer, 'observe').mockImplementation(async () => {
      await pending.promise
      return { kind: 'observed', observation, record: { kind: 'absent' }, writer: undefined }
    })
    const adopt = vi.spyOn(writer, 'adopt').mockImplementation(async () => {
      await pending.promise
      return { kind: 'written', gzip: new Uint8Array([1]), digest: 'digest', mirror: { kind: 'off' } }
    })
    const remove = vi.spyOn(writer, 'removeObserved').mockImplementation(async () => {
      await pending.promise
      return { kind: 'removed', mirror: { kind: 'removed' } }
    })
    const clock = fakeLeaseClock()
    const host = createInProcessOutboxHost(writer, clock.clock, 1_000)
    const results = [host.writer.observe(key), host.writer.adopt(observation, capture), host.writer.removeObserved(observation)]
    await settle()
    expect(observe).toHaveBeenCalledWith(key)
    expect(adopt).toHaveBeenCalledWith(observation, capture)
    expect(remove).toHaveBeenCalledWith(observation)
    if (stop === 'timeout')
      await clock.advance(1_000)
    else
      host.dispose()
    for (const result of await Promise.all(results))
      expect(result).toMatchObject({ kind: 'failed' })
    pending.resolve()
    await settle()
    expect(host.broken()).toBe(true)
    expect(await host.writer.observe(key)).toMatchObject({ kind: 'failed' })
    expect(observe).toHaveBeenCalledTimes(1)
    expect(clock.pending()).toBe(0)
  })
})
