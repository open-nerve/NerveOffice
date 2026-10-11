// 测试构建与 Node 崩溃驱动共用的元数据白名单；不引入任何模块、正文或凭据。
export interface DiagnosticMarker {
  readonly userId: string
  readonly documentId: string
  readonly clientInstanceId: string
  readonly writeEpoch: number
  readonly writerId: string
}

export interface DiagnosticNavigation {
  readonly timeOrigin: number
  readonly type: 'navigate' | 'reload' | 'back_forward' | 'prerender' | null
  readonly discarded: 'yes' | 'no' | 'unsupported'
  readonly key: string | null
  readonly id: string | null
  readonly activation: 'push' | 'replace' | 'reload' | 'traverse' | null
  readonly fromKey: string | null
  readonly fromId: string | null
}

export interface DiagnosticPoint {
  readonly navigation: DiagnosticNavigation | null
  readonly storage: {
    readonly status: 'available' | 'unavailable'
    readonly markers: readonly DiagnosticMarker[]
    readonly invalid: number
    readonly truncated: boolean
  }
}

export type DiagnosticEvent
  = | { readonly kind: 'lock', readonly clientInstanceId: string, readonly result: 'held' | 'busy' | 'error' }
    | { readonly kind: 'match', readonly clientInstanceId: string, readonly result: 'match' | 'miss' | 'error' }
    | { readonly kind: 'selected', readonly clientInstanceId: string, readonly candidate: boolean }

export interface ReloadDiagnostics {
  readonly initial: DiagnosticPoint
  readonly current: DiagnosticPoint
  readonly events: readonly DiagnosticEvent[]
  readonly truncated: boolean
}

export function diagnosticObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function diagnosticKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

export function diagnosticUuid(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(value)
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

export function isDiagnosticMarker(value: unknown): value is DiagnosticMarker {
  return diagnosticObject(value) && diagnosticKeys(value, ['userId', 'documentId', 'clientInstanceId', 'writeEpoch', 'writerId'])
    && [value.userId, value.documentId, value.clientInstanceId, value.writerId].every(diagnosticUuid)
    && integer(value.writeEpoch, 1, Number.MAX_SAFE_INTEGER)
}

function navigation(value: unknown): value is DiagnosticNavigation | null {
  return value === null || (diagnosticObject(value)
    && diagnosticKeys(value, ['timeOrigin', 'type', 'discarded', 'key', 'id', 'activation', 'fromKey', 'fromId'])
    && typeof value.timeOrigin === 'number' && Number.isFinite(value.timeOrigin) && value.timeOrigin >= 0
    && ['navigate', 'reload', 'back_forward', 'prerender', null].includes(value.type as string | null)
    && ['yes', 'no', 'unsupported'].includes(value.discarded as string)
    && ['push', 'replace', 'reload', 'traverse', null].includes(value.activation as string | null)
    && [value.key, value.id, value.fromKey, value.fromId].every(id => id === null || diagnosticUuid(id)))
}

function point(value: unknown): value is DiagnosticPoint {
  if (!diagnosticObject(value) || !diagnosticKeys(value, ['navigation', 'storage']) || !navigation(value.navigation))
    return false
  const storage = value.storage
  return diagnosticObject(storage) && diagnosticKeys(storage, ['status', 'markers', 'invalid', 'truncated'])
    && ['available', 'unavailable'].includes(storage.status as string)
    && Array.isArray(storage.markers) && storage.markers.length <= 4 && storage.markers.every(isDiagnosticMarker)
    && integer(storage.invalid, 0, 64) && typeof storage.truncated === 'boolean'
}

function event(value: unknown): value is DiagnosticEvent {
  if (!diagnosticObject(value) || !diagnosticUuid(value.clientInstanceId))
    return false
  if (value.kind === 'selected')
    return diagnosticKeys(value, ['kind', 'clientInstanceId', 'candidate']) && typeof value.candidate === 'boolean'
  return diagnosticKeys(value, ['kind', 'clientInstanceId', 'result'])
    && ((value.kind === 'lock' && ['held', 'busy', 'error'].includes(value.result as string))
      || (value.kind === 'match' && ['match', 'miss', 'error'].includes(value.result as string)))
}

export function isReloadDiagnostics(value: unknown): value is ReloadDiagnostics {
  return diagnosticObject(value) && diagnosticKeys(value, ['initial', 'current', 'events', 'truncated'])
    && point(value.initial) && point(value.current) && typeof value.truncated === 'boolean'
    && Array.isArray(value.events) && value.events.length <= 8 && value.events.every(event)
}
