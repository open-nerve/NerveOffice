// 真实请求的本机来源资格；网络与摘要计算不持发件箱锁，认证结果不被存储故障替换。
import type { SessionResponse } from '@nerve-office/contracts'
import type { SessionCheckTicket, SessionSource } from '../outbox/session-fence.ts'
import type { SessionStore } from '../outbox/session-store.ts'
import { associatedSessionPermit, rememberSessionPermit } from '../api/session-association.ts'
import { sha256Hex } from '../outbox/draft-codec.ts'
import { withOutboxLock } from '../outbox/outbox-lock.ts'
import { readDraftSessionPermit } from '../outbox/session-fence.ts'
import { createSessionStore } from '../outbox/session-store.ts'

export interface SessionActivationOptions {
  readonly store: Pick<SessionStore, 'beginSessionCheck' | 'acceptSessionCheck' | 'failSessionChange'>
  readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>
  readonly source: (response: SessionResponse) => Promise<SessionSource>
  readonly rejected: (error: unknown, ticket: SessionCheckTicket) => Promise<void>
}

export function draftSessionPermitOf(response: object) {
  return readDraftSessionPermit(associatedSessionPermit(response))
}

export async function sessionSourceOf(response: SessionResponse): Promise<SessionSource> {
  const purpose = new TextEncoder().encode(JSON.stringify(['nerve-office/local-session/v1', response.user.id, response.csrfToken]))
  return { userId: response.user.id, sourceHash: await sha256Hex(purpose) }
}

export function createSessionActivation(options: SessionActivationOptions) {
  /** 只隔离本机步骤的故障；网络请求在这个边界之外，原失败不会被重试或吞掉。 */
  async function local<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await options.exclusive(work)
    }
    catch {
      return undefined
    }
  }

  return {
    track: async <T extends SessionResponse>(kind: SessionCheckTicket['kind'], request: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
      const started = await local(async () => options.store.beginSessionCheck(kind))
      const ticket = started?.kind === 'ticket' ? started.ticket : undefined
      let response: T
      try {
        response = await request()
      }
      catch (error) {
        if (ticket?.kind === 'mutation')
          await local(async () => options.store.failSessionChange(ticket))
        if (ticket?.kind === 'query' && !(signal?.aborted === true && error === signal.reason)) {
          try {
            await options.rejected(error, ticket)
          }
          catch { /* 失效处理失败也只能抛原错误，不重发请求。 */ }
        }
        throw error
      }
      rememberSessionPermit(response, undefined)
      if (ticket === undefined)
        return response
      let source: SessionSource
      try {
        source = await options.source(response)
      }
      catch {
        return response
      }
      const accepted = await local(async () => options.store.acceptSessionCheck(ticket, source))
      if (accepted?.kind === 'active')
        rememberSessionPermit(response, Object.freeze({ ...accepted.permit }))
      return response
    },
  }
}

const store = createSessionStore({ blockedTimeoutMs: 3_000 })

/** 请求层传入自己的错误处理端口；资格模块与探针不静态引入契约校验或反向引用请求层。 */
export async function trackSessionRequest<T extends SessionResponse>(kind: SessionCheckTicket['kind'], request: () => Promise<T>, signal: AbortSignal | undefined, rejected: SessionActivationOptions['rejected']): Promise<T> {
  return createSessionActivation({ store, exclusive: withOutboxLock, source: sessionSourceOf, rejected }).track(kind, request, signal)
}
