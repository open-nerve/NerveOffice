import type { SessionResponse } from '@nerve-office/contracts'
import type { SessionChannel } from '../lib/session-channel.ts'
import type { DraftSessionPermit } from '../outbox/session-fence.ts'
import type { DraftMaintenance } from './draft-maintenance.ts'
import { associatedSessionPermit } from '../api/session-association.ts'
import { currentApiSession, subscribeApiSession } from '../api/session-context.ts'
import { readDraftSessionPermit } from '../outbox/session-fence.ts'
import { subscribeLocalSession } from './session-events.ts'

interface MaintenanceSignalsOptions {
  readonly model: Pick<DraftMaintenance, 'activate' | 'refresh'>
  readonly target: EventTarget
  readonly visibility: EventTarget
  readonly visible: () => boolean
  readonly channel: Pick<SessionChannel, 'subscribe'>
}

/** 只消费原响应与事实信号；公开链接页不因维护多一次认证请求。 */
export function watchMaintenanceSignals({ model, target, visibility, visible, channel }: MaintenanceSignalsOptions): () => void {
  let permit: DraftSessionPermit | undefined
  function adopt(response: SessionResponse | undefined): void {
    permit = response === undefined ? undefined : readDraftSessionPermit(associatedSessionPermit(response))
    model.activate(permit)
  }
  const refresh = () => {
    void model.refresh()
  }
  const onVisible = () => {
    if (visible())
      refresh()
  }
  const onHide = () => model.activate(undefined)
  const onShow = () => {
    adopt(currentApiSession())
    refresh()
  }
  const stopSession = subscribeApiSession(adopt)
  const stopLocal = subscribeLocalSession((event) => {
    if (event.kind === 'stopped' && permit?.userId === event.previous.userId && permit.generation === event.previous.generation) {
      permit = undefined
      model.activate(undefined)
    }
    if (event.kind === 'cleanup')
      refresh()
  })
  const stopChannel = channel.subscribe(refresh)
  target.addEventListener('focus', refresh)
  target.addEventListener('online', refresh)
  target.addEventListener('pagehide', onHide)
  target.addEventListener('pageshow', onShow)
  visibility.addEventListener('visibilitychange', onVisible)
  adopt(currentApiSession())
  refresh()
  return () => {
    stopSession()
    stopLocal()
    stopChannel()
    target.removeEventListener('focus', refresh)
    target.removeEventListener('online', refresh)
    target.removeEventListener('pagehide', onHide)
    target.removeEventListener('pageshow', onShow)
    visibility.removeEventListener('visibilitychange', onVisible)
  }
}
