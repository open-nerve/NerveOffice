import type { SessionResponse } from '@nerve-office/contracts'
import { sessionFailureOf } from './session-failure-facts.ts'

/** 平台首屏不静态装入存储；仅加载失败时直接请求，不能捕获网络失败后重发登录。 */
export async function requestWithLocalSession<T extends SessionResponse>(kind: 'query' | 'mutation', request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const activation = await import('../local-drafts/session-activation.ts').catch(() => undefined)
  return activation === undefined
    ? request()
    : activation.trackSessionRequest(kind, request, signal, async (error, ticket) => {
        const facts = sessionFailureOf(error)
        if (facts !== undefined) {
          const failure = await import('../local-drafts/browser-session-failure.ts')
          await failure.handleQuerySessionFailure(facts, ticket)
        }
      })
}

/** 原网络错误由请求层照常交回；这里只转交已固定来源，不读取页面当前登录。 */
export async function reportRequestSessionFailure(error: unknown, permit: unknown): Promise<void> {
  const facts = sessionFailureOf(error)
  if (facts === undefined)
    return
  const failure = await import('../local-drafts/browser-session-failure.ts')
  await failure.handleRequestSessionFailure(facts, permit)
}
