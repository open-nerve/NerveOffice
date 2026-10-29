// 持久会话状态的接口。状态转移由调用方放在完整的同源发件箱操作锁内；网络不持锁。
import type { DraftSessionPermit, LocalSessionState, SessionCheckFailure, SessionCheckTicket, SessionRejectionResult, SessionSource, UserCleanupCause, UserCleanupPermit } from './session-fence.ts'
import type { SessionInvalid, StoreOptions, StoreProblem } from './store-transaction.ts'
import { SESSION_SLOT, SESSIONS_STORE } from './database.ts'
import { acceptSessionCheck, beginSessionChange, beginUserCleanup, createUnconfirmedSession, expireSessionChange, failSessionChange, finishUserCleanup, rejectSessionCheck, sessionCheckTicket, suspendSession } from './session-fence.ts'
import { readStoredSession, sessionRecord } from './session-record.ts'
import { createStoreTransactions } from './store-transaction.ts'

export type SessionStoreResult<T> = Promise<T | StoreProblem>

export interface SessionStore {
  readonly readState: () => SessionStoreResult<{ readonly kind: 'state', readonly state: LocalSessionState | undefined }>
  readonly beginSessionCheck: (kind: SessionCheckTicket['kind']) => SessionStoreResult<{ readonly kind: 'ticket', readonly ticket: SessionCheckTicket }>
  /** 同步否决在真实事务的状态决定处执行，只能拒绝接受，不能换票或授予资格。 */
  readonly acceptSessionCheck: (ticket: SessionCheckTicket, source: SessionSource, allow?: () => boolean) => SessionStoreResult<{ readonly kind: 'active', readonly permit: DraftSessionPermit }>
  readonly failSessionChange: (ticket: SessionCheckTicket) => SessionStoreResult<{ readonly kind: 'released' }>
  readonly rejectSessionCheck: (ticket: SessionCheckTicket, failure: SessionCheckFailure) => SessionStoreResult<SessionRejectionResult | { readonly kind: 'invalidated' }>
  readonly suspendSession: (permit: DraftSessionPermit) => SessionStoreResult<{ readonly kind: 'suspended' }>
  readonly beginUserCleanup: (permit: DraftSessionPermit, cause: UserCleanupCause) => SessionStoreResult<{ readonly kind: 'clearing', readonly permit: UserCleanupPermit }>
  readonly finishUserCleanup: (permit: UserCleanupPermit) => SessionStoreResult<{ readonly kind: 'cleared' }>
  readonly close: () => void
}

export interface SessionStoreOptions extends StoreOptions {
  readonly now?: () => number
  readonly newGeneration?: () => string
}

/** 所有转移先比较同一行，再在同一个 strict 事务内写入；只有提交成功才交回资格。 */
export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const transactions = createStoreTransactions(options)
  const now = options.now ?? Date.now
  const newGeneration = options.newGeneration ?? (() => crypto.randomUUID())

  async function transition<T>(decide: (state: LocalSessionState) => { readonly state: LocalSessionState, readonly value: T } | undefined): SessionStoreResult<T> {
    return transactions.run<T | SessionInvalid>([SESSIONS_STORE], 'readwrite', (scope) => {
      const store = scope.tx.objectStore(SESSIONS_STORE)
      scope.then(store.get(SESSION_SLOT) as IDBRequest<unknown>, (raw) => {
        const state = readStoredSession(raw)
        const next = state === undefined ? undefined : decide(state)
        if (next === undefined) {
          scope.finish({ kind: 'session-invalid' })
          return
        }
        if (next.state !== state)
          store.put(sessionRecord(next.state))
        scope.finish(next.value)
      })
    })
  }

  return {
    readState: async () => transactions.run([SESSIONS_STORE], 'readonly', (scope) => {
      scope.then(scope.tx.objectStore(SESSIONS_STORE).get(SESSION_SLOT) as IDBRequest<unknown>, (raw) => {
        scope.finish({ kind: 'state', state: readStoredSession(raw) })
      })
    }),
    beginSessionCheck: async kind => transactions.run([SESSIONS_STORE], 'readwrite', (scope) => {
      const store = scope.tx.objectStore(SESSIONS_STORE)
      scope.then(store.get(SESSION_SLOT) as IDBRequest<unknown>, (raw) => {
        const previous = readStoredSession(raw)
        const state = previous ?? createUnconfirmedSession(newGeneration())
        if (kind === 'mutation') {
          const next = beginSessionChange(state, newGeneration(), now())
          store.put(sessionRecord(next.state))
          scope.finish({ kind: 'ticket', ticket: next.ticket })
          return
        }
        const current = expireSessionChange(state, now(), newGeneration()) ?? state
        if (current !== previous)
          store.put(sessionRecord(current))
        scope.finish({ kind: 'ticket', ticket: sessionCheckTicket(current) })
      })
    }),
    acceptSessionCheck: async (ticket, source, allow) => transition((state) => {
      if (allow?.() === false)
        return undefined
      const next = acceptSessionCheck(state, ticket, source, newGeneration(), now())
      return next === undefined ? undefined : { state: next.state, value: { kind: 'active', permit: next.permit } }
    }),
    failSessionChange: async ticket => transition((state) => {
      const next = failSessionChange(state, ticket, newGeneration())
      return next === undefined ? undefined : { state: next, value: { kind: 'released' } }
    }),
    suspendSession: async permit => transition((state) => {
      const next = suspendSession(state, permit, newGeneration())
      return next === undefined ? undefined : { state: next, value: { kind: 'suspended' } }
    }),
    rejectSessionCheck: async (ticket, failure) => {
      const result = await transition((state) => {
        const next = rejectSessionCheck(state, ticket, failure, newGeneration())
        return next === undefined ? undefined : { state: next.state, value: next.result }
      })
      return result.kind === 'session-invalid' ? { kind: 'invalidated' } : result
    },
    beginUserCleanup: async (permit, cause) => transition((state) => {
      const next = beginUserCleanup(state, permit, cause, newGeneration())
      return next === undefined ? undefined : { state: next.state, value: { kind: 'clearing', permit: next.permit } }
    }),
    finishUserCleanup: async permit => transition((state) => {
      const next = finishUserCleanup(state, permit, newGeneration())
      return next === undefined ? undefined : { state: next, value: { kind: 'cleared' } }
    }),
    close: () => transactions.close(),
  }
}
