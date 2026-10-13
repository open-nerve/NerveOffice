import type { SessionResponse } from '@nerve-office/contracts'

/** 平台首屏不静态装入存储；仅加载失败时直接请求，不能捕获网络失败后重发登录。 */
export async function requestWithLocalSession<T extends SessionResponse>(kind: 'query' | 'mutation', request: () => Promise<T>): Promise<T> {
  const activation = await import('../local-drafts/session-activation.ts').catch(() => undefined)
  return activation === undefined ? request() : activation.trackSessionRequest(kind, request)
}
