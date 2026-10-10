import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOCUMENT_ID, NOW, USER_ID, WRITER_ID } from './draft-record.test-support.ts'
import { pageReconciliation } from './draft-recovery.ts'
import { fakeDraftStore } from './draft-store.test-support.ts'
import { createDraftWriter } from './draft-writer.ts'
import { createLocalCleanup } from './local-cleanup.ts'
import { fakeMirrorDirectory } from './mirror-directory.test-support.ts'
import { deferred, fakeOutboxLocks } from './outbox-lock.test-support.ts'
import { OUTBOX_LOCK_WAIT_MS, withOutboxLock } from './outbox-lock.ts'

afterEach(() => vi.useRealTimers())

describe('发件箱的短期互斥', () => {
  it('等待超时后不执行取消的任务，持锁任务不会被等待者超时提前释放', async () => {
    vi.useFakeTimers()
    const locks = fakeOutboxLocks()
    const held = deferred<void>()
    const reached = deferred<void>()
    const first = withOutboxLock(async () => {
      reached.resolve()
      await held.promise
      return 'first'
    }, locks)
    await reached.promise
    const cancelled = vi.fn(async () => 'cancelled')
    const pending = withOutboxLock(cancelled, locks)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(OUTBOX_LOCK_WAIT_MS + 1)
    await rejected
    const last = vi.fn(async () => 'last')
    const following = withOutboxLock(last, locks)
    await vi.advanceTimersByTimeAsync(1)
    expect(last).not.toHaveBeenCalled()
    held.resolve()
    expect(await first).toBe('first')
    expect(await following).toBe('last')
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('任务失败后释放锁，下一次可以继续', async () => {
    const locks = fakeOutboxLocks()
    await expect(withOutboxLock(async () => {
      throw new TypeError('failed')
    }, locks)).rejects.toThrow('failed')
    expect(await withOutboxLock(async () => 'ok', locks)).toBe('ok')
  })

  it('没有 Web Locks：登记、平台恢复与清理明确失败，存储和镜像都不动', async () => {
    vi.stubGlobal('navigator', {})
    const store = fakeDraftStore()
    const files = fakeMirrorDirectory()
    const key = { userId: USER_ID, documentId: DOCUMENT_ID }
    const writer = createDraftWriter({ store: store.store, now: () => NOW })
    expect(await writer.register(key, { writerId: WRITER_ID, writeEpoch: 1 }, false)).toMatchObject({ kind: 'failed', error: { name: 'NotSupportedError' } })
    expect(await pageReconciliation({ store: store.store, directory: files.directory, now: () => NOW }).reconcile(key)).toMatchObject({ kind: 'failed', error: { name: 'NotSupportedError' } })
    const cleanup = createLocalCleanup({ store: store.store, directory: files.directory, now: () => NOW })
    expect(await cleanup.removeUser(USER_ID)).toMatchObject({ kind: 'failed', error: { name: 'NotSupportedError' } })
    expect(await cleanup.abandon(key)).toMatchObject({ kind: 'failed', error: { name: 'NotSupportedError' } })
    expect(await cleanup.purgeExpired(NOW)).toMatchObject({ kind: 'failed', error: { name: 'NotSupportedError' } })
    expect(store.calls).toEqual([])
    expect(files.opens()).toBe(0)
  })
})
