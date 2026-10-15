import type { UserCleanupOutcome } from '../outbox/local-cleanup.ts'
import type { DraftSessionPermit, UserCleanupPermit } from '../outbox/session-fence.ts'

/** 本页的事实通知；跨页广播仍不携带身份，接收者自行核对持久资格。 */
export type LocalSessionEvent
  = | { readonly kind: 'stopped', readonly previous: DraftSessionPermit, readonly cleanup: UserCleanupPermit | undefined }
    | { readonly kind: 'cleanup', readonly permit: UserCleanupPermit, readonly outcome: UserCleanupOutcome }
const listeners = new Set<(event: LocalSessionEvent) => void>()

export function subscribeLocalSession(listener: (event: LocalSessionEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishLocalSession(event: LocalSessionEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    }
    catch { /* 某个页面组件已关闭或抛错不能阻止其余宿主停写、释放密钥。 */ }
  }
}
