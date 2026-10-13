import type { OutboxConnection, OutboxUnavailable } from './database.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as database from './database.ts'
import { USER_ID } from './draft-record.test-support.ts'
import { createDraftStore } from './draft-store.ts'
import { createDraftWriter } from './draft-writer.ts'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'
import { createOutboxHost } from './outbox-host.ts'
import { deferred, fakeOutboxLocks } from './outbox-lock.test-support.ts'
import { withOutboxLock } from './outbox-lock.ts'

afterEach(() => vi.restoreAllMocks())

const PERMIT = { userId: USER_ID, generation: '0199b0c4-7d3e-7a3b-9c4e-000000000001' }
const SESSION = { slot: database.SESSION_SLOT, state: { phase: 'active', generation: PERMIT.generation, activatedFrom: '0199b0c4-7d3e-7a3b-9c4e-000000000002', source: { userId: USER_ID, sourceHash: 'a'.repeat(64) } } }

/** 只控制打开与只读事务的完成时刻；栅栏和持久性仍由真实浏览器测试，不在这里模拟。 */
function delayedReadConnection() {
  let closed = false
  const requests: IDBRequest[] = []
  let transaction: IDBTransaction
  const close = vi.fn(() => {
    closed = true
  })
  const start = vi.fn(() => {
    transaction = {
      objectStore: (name: string) => ({
        get: () => {
          const request = { result: name === database.SESSIONS_STORE ? SESSION : undefined } as IDBRequest
          requests.push(request)
          return request
        },
        openCursor: () => {
          const request = { result: null } as IDBRequest
          requests.push(request)
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
      while (requests.length > 0)
        requests.shift()?.onsuccess?.(new Event('success'))
      transaction.oncomplete?.(new Event('complete'))
    },
  }
}

describe('进程内宿主终止后的真实管道收尾', () => {
  for (const operation of ['read', 'notices'] as const) {
    it.each(['timeout', 'dispose'] as const)(`${operation} 的 IDB 打开晚于 %s：仍等实际操作完成再关闭新连接`, async (stop) => {
      const opening = deferred<OutboxConnection | OutboxUnavailable>()
      const open = vi.spyOn(database, 'openOutboxDatabase').mockReturnValue(opening.promise)
      const initial = delayedReadConnection()
      open.mockResolvedValueOnce(initial.connection)
      const store = createDraftStore({ blockedTimeoutMs: 3_000 })
      const binding = store.bindSession(PERMIT)
      await settle()
      initial.finish()
      expect(await binding).toEqual({ kind: 'bound' })
      store.close()
      open.mockClear()
      const local = delayedReadConnection()
      const time = fakeLeaseClock()
      vi.stubGlobal('navigator', { locks: fakeOutboxLocks() })
      const writer = createDraftWriter({ store, now: () => 1_000 })
      const host = await createOutboxHost({ createWorker: () => {
        throw new Error('测试初始 Worker 启动失败')
      }, createFallback: () => writer, clock: time.clock })
      const result = operation === 'read' ? host.writer.read({ userId: USER_ID, documentId: 'doc' }) : host.writer.notices(USER_ID)
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
      const next = withOutboxLock(async () => nextOperation())
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
      expect(nextOperation).toHaveBeenCalledTimes(1)
      expect(nextOperation).toHaveReturnedWith(1)
      host.dispose()
      expect(local.close).toHaveBeenCalledTimes(1)
    })
  }
})
