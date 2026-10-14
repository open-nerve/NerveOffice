import type { SessionResponse } from '@nerve-office/contracts'
import type { DraftSessionPermit, LocalSessionState, SessionSource, UserCleanupPermit } from '../outbox/session-fence.ts'
import type { SessionStore } from '../outbox/session-store.ts'
import type { LogoutQualification } from './logout-flow.ts'
import { canCleanUserSession, canUseDraftSession, readDraftSessionPermit, readUserCleanupPermit } from '../outbox/session-fence.ts'
import { sessionSourceOf } from './session-activation.ts'

/** 只检查原确认，不从当前持久行生成新许可。完成清理后的代次虽已推进，来源仍必须精确匹配。 */
export function qualifyLogoutState(state: LocalSessionState | undefined, source: SessionSource, permit: DraftSessionPermit, cleanup: UserCleanupPermit | undefined): LogoutQualification {
  if (state?.source?.userId !== source.userId || state.source.sourceHash !== source.sourceHash || permit.userId !== source.userId)
    return 'invalidated'
  if (cleanup === undefined)
    return canUseDraftSession(state, permit, source.userId) ? 'active' : 'invalidated'
  if (readUserCleanupPermit(cleanup) === undefined || cleanup.userId !== source.userId || cleanup.cause !== 'logout')
    return 'invalidated'
  if (canCleanUserSession(state, cleanup))
    return 'clearing'
  return state.phase === 'cleared' && state.cause === cleanup.cause ? 'cleared' : 'invalidated'
}

export interface LogoutQualificationOptions {
  readonly session: SessionResponse
  readonly permit: DraftSessionPermit | undefined
  readonly sessions: Pick<SessionStore, 'readState'>
  readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>
}

export function createLogoutQualification(options: LogoutQualificationOptions) {
  const permit = readDraftSessionPermit(options.permit)
  // sourceOf 在第一次 await 前读取原账户与 CSRF；后来的采纳/对象变化不能替旧确认换来源。
  const original = permit === undefined ? Promise.resolve(undefined) : sessionSourceOf(options.session).catch(() => undefined)
  return async (cleanup: UserCleanupPermit | undefined): Promise<LogoutQualification> => {
    const source = await original
    if (permit === undefined || source === undefined)
      return 'unavailable'
    try {
      return await options.exclusive(async () => {
        const current = await options.sessions.readState()
        return current.kind === 'state' ? qualifyLogoutState(current.state, source, permit, cleanup) : 'unavailable'
      })
    }
    catch {
      return 'unavailable'
    }
  }
}
