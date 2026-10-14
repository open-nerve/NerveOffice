import type { SessionResponse } from '@nerve-office/contracts'

// 只保存本页实际采纳的原响应；这里不请求会话，也不授予本机资格。
let current: SessionResponse | undefined
const listeners = new Set<(session: SessionResponse | undefined) => void>()

export function currentApiSession(): SessionResponse | undefined {
  return current
}

export function recordApiSession(session: SessionResponse | undefined): void {
  current = session
  for (const listener of [...listeners]) {
    try {
      listener(session)
    }
    catch { /* 已关闭的宿主不能阻止其余订阅者清除旧来源。 */ }
  }
}

export function subscribeApiSession(listener: (session: SessionResponse | undefined) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
