import type { OutboxConnection, OutboxUnavailable } from '../../../shared/outbox/database.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as database from '../../../shared/outbox/database.ts'
import { createDraftStore } from '../../../shared/outbox/draft-store.ts'
import { createDraftWriter } from '../../../shared/outbox/draft-writer.ts'
import { deferred, fakeOutboxLocks } from '../../../shared/outbox/outbox-lock.test-support.ts'
import { withOutboxLock } from '../../../shared/outbox/outbox-lock.ts'
import { fakeLeaseClock, settle } from '../fake-lease-clock.test-support.ts'
import { createOutboxHost } from './outbox-host.ts'

afterEach(() => vi.restoreAllMocks())

/** 只控制打开与只读事务的完成时刻；栅栏和持久性仍由真实浏览器测试，不在这里模拟。 */
function delayedReadConnection() {
  let closed = false
  let request: IDBRequest
  let transaction: IDBTransaction
  const close = vi.fn(() => {
    closed = true
  })
  const start = vi.fn(() => {
    request = { result: undefined } as IDBRequest
    transaction = {
      objectStore: () => ({
        get: () => request,
        openCursor: () => {
          Object.defineProperty(request, 'result', { value: null })
          return request
        },
      }),
    } as unknown as IDBTransaction
    return transaction
  })
  const connection: OutboxConnection = { kind: 'connected', db: { transaction: start } as unknown as IDBDatabase, close, isClosed: () => closed }
  return {
    connection,
    close,
    start,
    finish: () => {
      request.onsuccess?.(new Event('success'))
      transaction.oncomplete?.(new Event('complete'))
    },
  }
}

describe('进程内宿主终止后的真实管道收尾', () => {
  for (const operation of ['read', 'notices'] as const) {
    it.each(['timeout', 'dispose'] as const)(`${operation} 的 IDB 打开晚于 %s：仍等实际操作完成再关闭新连接`, async (stop) => {
      const opening = deferred<OutboxConnection | OutboxUnavailable>()
      const open = vi.spyOn(database, 'openOutboxDatabase').mockReturnValue(opening.promise)
      const local = delayedReadConnection()
      const time = fakeLeaseClock()
      vi.stubGlobal('navigator', { locks: fakeOutboxLocks() })
      const writer = createDraftWriter({ store: createDraftStore({ blockedTimeoutMs: 3_000 }), now: () => 1_000 })
      const host = await createOutboxHost({ createWorker: () => {
        throw new Error('测试初始 Worker 启动失败')
      }, createFallback: () => writer, clock: time.clock })
      const result = operation === 'read' ? host.writer.read({ userId: 'user', documentId: 'doc' }) : host.writer.notices('user')
      await settle()
      expect(open).toHaveBeenCalledTimes(1)
      if (stop === 'timeout')
        await time.advance(15_000)
      else
        host.dispose()
      expect(await result).toMatchObject({ kind: 'failed', error: { name: stop === 'timeout' ? 'OutboxHostTimeout' : 'InvalidStateError' } })
      expect(host.broken()).toBe(true)
      expect(time.pending()).toBe(0)
      const nextOperation = vi.fn(() => local.close.mock.calls.length)
      const next = operation === 'read' ? withOutboxLock(async () => nextOperation()) : Promise.resolve()
      await settle()
      expect(nextOperation).not.toHaveBeenCalled()
      opening.resolve(local.connection)
      await settle()
      expect(local.start).toHaveBeenCalledTimes(1)
      expect(local.close).not.toHaveBeenCalled()
      expect(nextOperation).not.toHaveBeenCalled()
      local.finish()
      await settle()
      await next
      expect(local.close).toHaveBeenCalledTimes(1)
      expect(open).toHaveBeenCalledTimes(1)
      expect(nextOperation).toHaveBeenCalledTimes(operation === 'read' ? 1 : 0)
      if (operation === 'read')
        expect(nextOperation).toHaveReturnedWith(1)
      host.dispose()
      expect(local.close).toHaveBeenCalledTimes(1)
    })
  }
})
