import type { ConnectionView } from '../../shared/lib/connection-state.ts'

/** 只观察请求层已经登记的失败，不主动发请求，不改变连接或保存状态。 */
export function localSaveTransportFailed(view: ConnectionView, generation: number, preparedAt: number): boolean {
  return view.browserOnline && !view.available && view.problem === 'unresponsive'
    && view.generation > generation && view.since !== undefined && view.since >= preparedAt
}
