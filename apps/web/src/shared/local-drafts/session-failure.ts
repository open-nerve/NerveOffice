import type { DraftSessionPermit, SessionCheckFailure, SessionCheckTicket, UserCleanupPermit } from '../outbox/session-fence.ts'
import type { SessionStore } from '../outbox/session-store.ts'
import { readDraftSessionPermit } from '../outbox/session-fence.ts'

export interface SessionFailureOptions {
  readonly sessions: Pick<SessionStore, 'beginUserCleanup' | 'suspendSession' | 'rejectSessionCheck'>
  readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>
  /** 持久资格已提交、同源锁已释放；此处才通知停写，并按原清理许可安排后续。 */
  readonly stopped: (previous: DraftSessionPermit, cleanup: UserCleanupPermit | undefined) => void | Promise<void>
}

export function createSessionFailure(options: SessionFailureOptions) {
  async function attempt(work: () => Promise<void>): Promise<void> {
    try {
      await work()
    }
    catch { /* 本机副作用不能替换或重试原网络请求；持久 clearing 留给维护重试。 */ }
  }
  return {
    request: async (failure: SessionCheckFailure | undefined, original: unknown): Promise<void> => attempt(async () => {
      const permit = readDraftSessionPermit(original)
      if (permit === undefined || failure === undefined || (failure.kind === 'disabled' && failure.userId !== permit.userId))
        return
      const result = await options.exclusive(async () => failure.kind === 'disabled'
        ? options.sessions.beginUserCleanup(permit, 'account_disabled')
        : options.sessions.suspendSession(permit))
      if (result.kind === 'clearing' || result.kind === 'suspended')
        await options.stopped(permit, result.kind === 'clearing' ? result.permit : undefined)
    }),
    query: async (failure: SessionCheckFailure | undefined, ticket: SessionCheckTicket): Promise<void> => attempt(async () => {
      if (failure === undefined)
        return
      const result = await options.exclusive(async () => options.sessions.rejectSessionCheck(ticket, failure))
      if (result.kind === 'clearing' || result.kind === 'stopped')
        await options.stopped(result.previous, result.kind === 'clearing' ? result.permit : undefined)
    }),
  }
}
