import type { DraftKey } from '../../../shared/outbox/draft-record.ts'
import type { WriterIdentity } from '../../../shared/outbox/writer-fence.ts'
import type { HeldLock, LockApi } from '../same-browser.ts'
import type { ReloadMarker, ReloadMarkerPort, ReloadStorage } from './reload-marker.ts'
import { tryHoldExclusive } from '../same-browser.ts'
import { clearInheritedReloadMarkers, reloadMarker } from './reload-marker.ts'

export interface ReloadNavigation {
  readonly type: string | undefined
  readonly wasDiscarded: boolean
}

export interface ReloadIdentity {
  readonly clientInstanceId: string
  readonly candidate?: ReloadMarker
  readonly remember: (writer: WriterIdentity) => void
  readonly clear: () => void
  /** 卸载保留记号；先 clear 再 dispose 表示主动失效。 */
  readonly dispose: () => void
}

export interface ReloadIdentityOptions {
  readonly key: DraftKey
  readonly freshId: string
  readonly navigation: ReloadNavigation
  readonly marker: ReloadMarkerPort
  readonly locks: LockApi | undefined
  readonly matches: (candidate: ReloadMarker) => Promise<boolean>
  readonly still: () => boolean
}

/** 组装即消费导航事实，认证/正文失败也不能留下复制页继承的身份；异步预检仍在页面确认后。 */
export function reloadIdentitySelector(options: { readonly navigation: ReloadNavigation, readonly storage: () => ReloadStorage, readonly locks: LockApi | undefined }): (input: Omit<ReloadIdentityOptions, 'navigation' | 'marker' | 'locks'>) => Promise<ReloadIdentity> {
  if (options.navigation.type !== 'reload' && !options.navigation.wasDiscarded)
    clearInheritedReloadMarkers(options.storage)
  return async input => selectReloadIdentity({ ...input, navigation: options.navigation, locks: options.locks, marker: reloadMarker(input.key, { storage: options.storage }) })
}

export function reloadInstanceLock(key: DraftKey, clientInstanceId: string): string {
  return `nerve-office:instance:${key.userId.toLowerCase()}:${key.documentId.toLowerCase()}:${clientInstanceId.toLowerCase()}`
}

/** 持有者跨越整个页面生命周期；主动失效与卸载分别清记号、放锁。 */
function owner(options: ReloadIdentityOptions, clientInstanceId: string, lock: HeldLock | undefined, candidate?: ReloadMarker): { readonly identity: ReloadIdentity, readonly held: () => boolean } {
  let held = lock !== undefined
  let disposed = false
  let recorded = candidate
  const clear = (): void => {
    if (recorded !== undefined)
      options.marker.clear(recorded)
    recorded = undefined
  }
  if (lock !== undefined) {
    void lock.stolen.then(() => {
      if (!disposed) {
        held = false
        // WebKit 导航卸载也可能以 AbortError 结束持锁请求；退出的旧页不能删留给重载页的记号。
        if (options.still())
          clear()
        lock.release()
      }
    })
  }
  return {
    held: () => held,
    identity: {
      clientInstanceId,
      ...(candidate === undefined ? {} : { candidate }),
      remember: (writer) => {
        if (held && !disposed && options.still())
          recorded = options.marker.write({ clientInstanceId, writeEpoch: writer.writeEpoch, writerId: writer.writerId }) ?? recorded
      },
      clear,
      dispose: () => {
        if (disposed)
          return
        disposed = true
        held = false
        lock?.release()
      },
    },
  }
}

/** 只选择可证明的原实例身份；服务端申请与恢复正文仍由页面/统一恢复入口完成。 */
export async function selectReloadIdentity(options: ReloadIdentityOptions): Promise<ReloadIdentity> {
  const { marker, key, locks, still } = options
  if (!still())
    return owner(options, options.freshId, undefined).identity
  const reload = options.navigation.type === 'reload' || options.navigation.wasDiscarded
  const candidate = reload ? marker.read() : undefined
  // 只在本轮开始的同步段无条件失效；跨 await 的旧操作只能按原身份清理。
  if (candidate === undefined)
    marker.clear()
  if (candidate !== undefined) {
    if (candidate.userId === key.userId.toLowerCase() && candidate.documentId === key.documentId.toLowerCase()) {
      const lock = await tryHoldExclusive(locks, reloadInstanceLock(key, candidate.clientInstanceId))
      if (lock !== undefined) {
        const previous = owner(options, candidate.clientInstanceId, lock, candidate)
        let matches = false
        try {
          if (still() && previous.held())
            matches = await options.matches(candidate)
        }
        catch {
          // 归属读失败不等于没有原件，也不允许借旧身份普通申请。
        }
        if (matches && still() && previous.held())
          return previous.identity
        previous.identity.dispose()
      }
    }
  }
  if (candidate !== undefined)
    marker.clear(candidate)
  if (!still())
    return owner(options, options.freshId, undefined).identity
  const lock = await tryHoldExclusive(locks, reloadInstanceLock(key, options.freshId))
  if (!still()) {
    lock?.release()
    return owner(options, options.freshId, undefined).identity
  }
  return owner(options, options.freshId, lock).identity
}
