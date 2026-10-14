// 会话状态使用生产仓库与同源锁；测试只替换墙上时间，并可模拟无法访问 IndexedDB。
import type { DraftSessionPermit, SessionCheckFailure, SessionCheckTicket, SessionSource, UserCleanupCause, UserCleanupPermit } from '../../../../shared/outbox/session-fence.ts'
import type { SessionStore } from '../../../../shared/outbox/session-store.ts'
import type { ProbeStoreOptions } from './outbox-probe.ts'
import { withOutboxLock } from '../../../../shared/outbox/outbox-lock.ts'
import { createSessionStore } from '../../../../shared/outbox/session-store.ts'
import { plain } from './probe-result.ts'

export function createSessionFenceProbe() {
  let now = Date.now()
  const create = (options: ProbeStoreOptions = {}): SessionStore => createSessionStore({
    now: () => now,
    blockedTimeoutMs: options.blockedTimeoutMs ?? 1000,
    factory: () => {
      if (options.factory === 'missing')
        return undefined
      if (options.factory === 'throws')
        throw new DOMException('探针：无法取得 IndexedDB', 'SecurityError')
      return globalThis.indexedDB
    },
  })
  let store = create()
  async function run<T extends { readonly kind: string }>(task: (current: SessionStore) => Promise<T>) {
    const current = store
    try {
      return plain(await withOutboxLock(async () => task(current)))
    }
    catch (error) {
      return plain({ kind: 'failed' as const, error })
    }
  }
  return {
    read: async () => run(async current => current.readState()),
    begin: async (kind: SessionCheckTicket['kind']) => run(async current => current.beginSessionCheck(kind)),
    accept: async (ticket: SessionCheckTicket, source: SessionSource) => run(async current => current.acceptSessionCheck(ticket, source)),
    fail: async (ticket: SessionCheckTicket) => run(async current => current.failSessionChange(ticket)),
    reject: async (ticket: SessionCheckTicket, failure: SessionCheckFailure) => run(async current => current.rejectSessionCheck(ticket, failure)),
    suspend: async (permit: DraftSessionPermit) => run(async current => current.suspendSession(permit)),
    beginCleanup: async (permit: DraftSessionPermit, cause: UserCleanupCause) => run(async current => current.beginUserCleanup(permit, cause)),
    finishCleanup: async (permit: UserCleanupPermit) => run(async current => current.finishUserCleanup(permit)),
    advance: (milliseconds: number) => { now += milliseconds },
    reset: (options: ProbeStoreOptions = {}) => {
      store.close()
      store = create(options)
    },
    close: () => store.close(),
  }
}
