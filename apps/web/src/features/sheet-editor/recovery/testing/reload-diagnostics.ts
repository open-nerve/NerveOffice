/* eslint-disable ts/promise-function-async -- 只读包装必须原样交回 Promise 与同步异常；async 会改变此契约。 */
import type { DiagnosticEvent, DiagnosticMarker, DiagnosticNavigation, DiagnosticPoint, ReloadDiagnostics } from '../../../../editor/testing/selftest-reload-diagnostics.ts'
import type { LockApi } from '../../same-browser.ts'
import type { reloadIdentitySelector } from '../reload-identity.ts'
import type { ReloadStorage } from '../reload-marker.ts'
import { diagnosticObject, diagnosticUuid, isDiagnosticMarker } from '../../../../editor/testing/selftest-reload-diagnostics.ts'

const PREFIX = 'nerve-office:reload:'
const unavailable = (): DiagnosticPoint['storage'] => ({ status: 'unavailable', markers: [], invalid: 0, truncated: false })

/** 只读白名单；不调用产品 marker.read/clear，原始坏值与其他 sessionStorage 值不进入报告。 */
function readMarkers(storage: () => ReloadStorage): DiagnosticPoint['storage'] {
  try {
    const target = storage()
    const markers: DiagnosticMarker[] = []
    const length = target.length
    let invalid = 0
    let truncated = length > 64
    for (let index = 0; index < Math.min(length, 64); index++) {
      const name = target.key(index)
      if (!name?.startsWith(PREFIX))
        continue
      const raw = target.getItem(name)
      try {
        const parsed: unknown = raw !== null && raw.length <= 1024 ? JSON.parse(raw) : undefined
        if (!diagnosticObject(parsed) || parsed.v !== 1)
          throw new Error('invalid')
        const { v: _version, ...marker } = parsed
        if (!isDiagnosticMarker(marker) || name !== `${PREFIX}${marker.userId.toLowerCase()}:${marker.documentId.toLowerCase()}`)
          throw new Error('invalid')
        if (markers.length < 4)
          markers.push({ userId: marker.userId.toLowerCase(), documentId: marker.documentId.toLowerCase(), clientInstanceId: marker.clientInstanceId.toLowerCase(), writeEpoch: marker.writeEpoch, writerId: marker.writerId.toLowerCase() })
        else
          truncated = true
      }
      catch {
        invalid += 1
      }
    }
    return { status: 'available', markers, invalid, truncated }
  }
  catch {
    return unavailable()
  }
}

interface NavigationEntry { readonly key?: string, readonly id?: string }
interface BrowserNavigation { readonly currentEntry?: NavigationEntry, readonly activation?: { readonly navigationType?: string, readonly from?: NavigationEntry | null } }

/** 不触碰 history/state/name，不模拟 wasDiscarded，也不更新 Navigation API。 */
function browserNavigation(target: Window): DiagnosticNavigation | null {
  try {
    const entry = target.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const navigation = (target as Window & { readonly navigation?: BrowserNavigation }).navigation
    const type = entry?.type
    const activation = navigation?.activation?.navigationType
    const id = (value: unknown): string | null => diagnosticUuid(value) ? value : null
    return {
      timeOrigin: target.performance.timeOrigin,
      type: type !== undefined && ['navigate', 'reload', 'back_forward', 'prerender'].includes(type) ? type : null,
      discarded: 'wasDiscarded' in target.document ? target.document.wasDiscarded === true ? 'yes' : 'no' : 'unsupported',
      key: id(navigation?.currentEntry?.key),
      id: id(navigation?.currentEntry?.id),
      activation: activation !== undefined && ['push', 'replace', 'reload', 'traverse'].includes(activation) ? activation : null,
      fromKey: id(navigation?.activation?.from?.key),
      fromId: id(navigation?.activation?.from?.id),
    }
  }
  catch {
    return null
  }
}

/** 仅测试构建调用。真实工厂仍决定何时清记号、取锁、匹配与选身份。 */
export function observeReloadIdentity(factory: typeof reloadIdentitySelector, navigation: () => DiagnosticNavigation | null = () => browserNavigation(window)): { readonly selector: typeof reloadIdentitySelector, readonly snapshot: () => ReloadDiagnostics } {
  let storage: (() => ReloadStorage) | undefined
  let initial: DiagnosticPoint | undefined
  const events: DiagnosticEvent[] = []
  let truncated = false
  const record = (event: DiagnosticEvent): void => {
    if (!diagnosticUuid(event.clientInstanceId))
      return
    if (events.length < 8)
      events.push(event)
    else
      truncated = true
  }
  const point = (): DiagnosticPoint => {
    let captured: DiagnosticNavigation | null = null
    try {
      captured = navigation()
    }
    catch {
      // 诊断读取失败不能影响原选择器。
    }
    return { navigation: captured, storage: storage === undefined ? unavailable() : readMarkers(storage) }
  }
  const observeLocks = (locks: LockApi | undefined): LockApi | undefined => locks === undefined
    ? undefined
    : {
        request: (name, options, callback) => {
          const parts = name.split(':')
          const clientInstanceId = parts.length === 5 && parts[0] === 'nerve-office' && parts[1] === 'instance' && parts.slice(2).every(diagnosticUuid) ? parts[4] : undefined
          const result = (value: 'held' | 'busy' | 'error'): void => {
            if (clientInstanceId !== undefined)
              record({ kind: 'lock', clientInstanceId, result: value })
          }
          try {
            // 保留原 receiver、options、回调的 Promise 与原 request 的 Promise；旁路观察拒绝。
            const pending = locks.request(name, options, (lock) => {
              result(lock === null ? 'busy' : 'held')
              return callback(lock)
            })
            void pending.catch(() => result('error'))
            return pending
          }
          catch (error) {
            result('error')
            throw error
          }
        },
        query: () => locks.query(),
      }
  return {
    selector: (options) => {
      storage = options.storage
      initial = structuredClone(point())
      const select = factory({ ...options, locks: observeLocks(options.locks) })
      return async (input) => {
        const identity = await select({
          ...input,
          matches: (candidate) => {
            const recordMatch = (result: 'match' | 'miss' | 'error'): void => record({ kind: 'match', clientInstanceId: candidate.clientInstanceId, result })
            try {
              const pending = input.matches(candidate)
              void pending.then(value => recordMatch(value ? 'match' : 'miss'), () => recordMatch('error'))
              return pending
            }
            catch (error) {
              recordMatch('error')
              throw error
            }
          },
        })
        record({ kind: 'selected', clientInstanceId: identity.clientInstanceId, candidate: identity.candidate !== undefined })
        return identity
      }
    },
    snapshot: () => structuredClone({ initial: initial ?? point(), current: point(), events, truncated }),
  }
}
