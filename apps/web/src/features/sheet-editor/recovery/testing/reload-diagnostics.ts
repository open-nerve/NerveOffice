import type { DiagnosticMarker, DiagnosticNavigation, DiagnosticPoint, ReloadDiagnostics } from '../../../../editor/testing/selftest-reload-diagnostics.ts'
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

/** 仅测试构建调用；只观察启动前后的导航与旧记号，不参与产品身份选择。 */
export function observeReloadStart(storage: () => ReloadStorage, navigation: () => DiagnosticNavigation | null = () => browserNavigation(window)): { readonly snapshot: () => ReloadDiagnostics } {
  const point = (): DiagnosticPoint => {
    let captured: DiagnosticNavigation | null = null
    try {
      captured = navigation()
    }
    catch {
      // 诊断读取失败不能影响页面启动。
    }
    return { navigation: captured, storage: readMarkers(storage) }
  }
  const initial = structuredClone(point())
  return { snapshot: () => structuredClone({ initial, current: point(), events: [], truncated: false }) }
}
