import type { SessionResponse } from '@nerve-office/contracts'
import type { SessionChannel } from '../lib/session-channel.ts'
import type { DraftSessionPermit } from '../outbox/session-fence.ts'
import { associatedSessionPermit } from '../api/session-association.ts'
import { currentApiSession, subscribeApiSession } from '../api/session-context.ts'
import { readDraftSessionPermit } from '../outbox/session-fence.ts'

interface LogoutSourceOptions {
  readonly session: SessionResponse
  readonly permit: DraftSessionPermit | undefined
  readonly ended: () => boolean
  readonly invalidate: () => void
  readonly recheck: () => Promise<void>
  readonly channel: SessionChannel
  readonly target: EventTarget
  readonly visibility: EventTarget
  readonly visible: () => boolean
}

/** 通知只能结束旧确认或促使核对；没有任何信号可以给退出补发新来源。 */
export function watchLogoutSource(options: LogoutSourceOptions): () => void {
  const { user: { id }, csrfToken } = options.session
  const permit = readDraftSessionPermit(options.permit)
  const adopted = (next: SessionResponse | undefined): void => {
    if (next === undefined && options.ended())
      return
    const candidate = next === undefined ? undefined : readDraftSessionPermit(associatedSessionPermit(next))
    if (next?.user.id !== id || next.csrfToken !== csrfToken || candidate?.userId !== permit?.userId || candidate?.generation !== permit?.generation)
      options.invalidate()
  }
  const refresh = (): void => {
    void options.recheck()
  }
  const visible = (): void => {
    if (options.visible())
      refresh()
  }
  const stopSession = subscribeApiSession(adopted)
  const stopChannel = options.channel.subscribe(options.invalidate)
  const events = ['focus', 'online', 'pageshow']
  for (const event of events)
    options.target.addEventListener(event, refresh)
  options.target.addEventListener('pagehide', options.invalidate)
  options.visibility.addEventListener('visibilitychange', visible)
  adopted(currentApiSession())
  return () => {
    stopSession()
    stopChannel()
    for (const event of events)
      options.target.removeEventListener(event, refresh)
    options.target.removeEventListener('pagehide', options.invalidate)
    options.visibility.removeEventListener('visibilitychange', visible)
  }
}
