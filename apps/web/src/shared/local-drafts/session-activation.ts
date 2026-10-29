// 真实请求的本机来源资格；网络与摘要计算不持发件箱锁，认证结果不被存储故障替换。
import type { SessionResponse } from '@nerve-office/contracts'
import type { SessionCheckTicket, SessionSource } from '../outbox/session-fence.ts'
import type { SessionStore } from '../outbox/session-store.ts'
import { associatedSessionPermit, rememberSessionPermit } from '../api/session-association.ts'
import { sha256Hex } from '../outbox/draft-codec.ts'
import { withOutboxLock } from '../outbox/outbox-lock.ts'
import { readDraftSessionPermit } from '../outbox/session-fence.ts'
import { createSessionStore } from '../outbox/session-store.ts'
import { allowFailureConfirmation, finishFailureConfirmation, registerRequestFailure, waitForRequestFailure } from './session-failure-coordination.ts'

export interface SessionActivationOptions {
  readonly store: Pick<SessionStore, 'beginSessionCheck' | 'acceptSessionCheck' | 'failSessionChange'>
  readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>
  readonly source: (response: SessionResponse) => Promise<SessionSource>
  readonly rejected: (error: unknown, ticket: SessionCheckTicket) => Promise<void>
  /** 已登记却未完成的原来源失效可以否决激活；不能借此授予许可或换发票据。 */
  readonly allow?: (response: SessionResponse) => boolean
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
      signal?.throwIfAborted()
      const started = await local(async () => options.store.beginSessionCheck(kind))
      const ticket = started?.kind === 'ticket' ? started.ticket : undefined
      let response: T
      try {
        signal?.throwIfAborted()
        response = await request()
        signal?.throwIfAborted()
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
      if (ticket === undefined || options.allow?.(response) === false)
        return response
      let source: SessionSource
      try {
        source = await options.source(response)
      }
      catch {
        signal?.throwIfAborted()
        return response
      }
      signal?.throwIfAborted()
      const accepted = await local(async () => {
        // 等锁期间也可能取消；检查必须位于真正开始接受原票据之前。
        signal?.throwIfAborted()
        if (options.allow?.(response) === false)
          return undefined
        return options.store.acceptSessionCheck(ticket, source, () => {
          // 入锁后 IDB 仍要异步读取；真正决定前再次同步核对，不能先 put 再剥响应关联。
          signal?.throwIfAborted()
          return options.allow?.(response) !== false
        })
      })
      // local 只降级存储故障；取消不能随它一起被吞掉或变成成功响应。
      signal?.throwIfAborted()
      if (accepted?.kind === 'active') {
        const permit = Object.freeze({ ...accepted.permit })
        rememberSessionPermit(response, permit, async facts => registerRequestFailure(facts, permit))
      }
      return response
    },
  }
}

const store = createSessionStore({ blockedTimeoutMs: 3_000 })

/** 请求层传入自己的错误处理端口；资格模块与探针不静态引入契约校验或反向引用请求层。 */
export async function trackSessionRequest<T extends SessionResponse>(kind: SessionCheckTicket['kind'], request: () => Promise<T>, signal: AbortSignal | undefined, rejected: SessionActivationOptions['rejected']): Promise<T> {
  if (kind === 'query')
    await waitForRequestFailure(signal)
  const response = await createSessionActivation({ store, exclusive: withOutboxLock, source: sessionSourceOf, rejected, allow: kind === 'query' ? allowFailureConfirmation : undefined }).track(kind, request, signal)
  if (kind === 'query')
    finishFailureConfirmation(response)
  return response
}
