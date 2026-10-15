import type { MetadataCleanupOutcome } from '../outbox/local-cleanup.ts'
import { EDIT_REQUEST_PREFIX, PENDING_SAVE_PREFIX, RELOAD_PREFIX } from '../lib/editor-storage-keys.ts'

type LegacyStorage = Pick<Storage, 'length' | 'key' | 'removeItem'>
interface LegacyStorageOptions {
  readonly localStorage: () => LegacyStorage
  readonly sessionStorage: () => LegacyStorage
  readonly indexedDB: () => Pick<IDBFactory, 'deleteDatabase'>
  readonly timeoutMs?: number
}

const SDK_DATABASE = 'UniverLocalStorage'
const SDK_PREFIX = 'UniverLocalStorage/'
const MOBILE_RECENT = 'univer-mobile-recent-formula-functions'
const deleting = new WeakMap<Pick<IDBFactory, 'deleteDatabase'>, Promise<MetadataCleanupOutcome>>()

function retiredIntent(key: string): boolean {
  return key.startsWith(RELOAD_PREFIX) || key.startsWith(EDIT_REQUEST_PREFIX)
}

function pendingMarker(key: string, userId: string): boolean {
  if (!key.startsWith(PENDING_SAVE_PREFIX))
    return false
  const rest = key.slice(PENDING_SAVE_PREFIX.length)
  return key.startsWith(`${PENDING_SAVE_PREFIX}${userId}:`) || (rest.length > 0 && !rest.includes(':'))
}

function removeMatching(storage: LegacyStorage, matches: (key: string) => boolean): void {
  // removeItem 可以重排其余键；先固定清单，不能在枚举索引时边读边删。
  const keys: string[] = []
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index)
    if (key !== null && matches(key))
      keys.push(key)
  }
  for (const key of keys)
    storage.removeItem(key)
}

/** 不读取旧身份/意图；普通启动的调用者可忽略异常，明确清理必须报告。 */
export function clearLegacySessionMarkers(storage: LegacyStorage): void {
  removeMatching(storage, retiredIntent)
}

async function deleteSdkDatabase(factory: Pick<IDBFactory, 'deleteDatabase'>, timeoutMs: number): Promise<MetadataCleanupOutcome> {
  const pending = deleting.get(factory)
  if (pending !== undefined)
    return pending
  const request = factory.deleteDatabase(SDK_DATABASE)
  const result = new Promise<MetadataCleanupOutcome>((resolve) => {
    let resolved = false
    const timer = setTimeout(finish, timeoutMs, { kind: 'pending' })
    function finish(outcome: MetadataCleanupOutcome): void {
      if (resolved)
        return
      resolved = true
      clearTimeout(timer)
      resolve(outcome)
    }
    function completed(): void {
      deleting.delete(factory)
      request.removeEventListener('success', success)
      request.removeEventListener('error', error)
      request.removeEventListener('blocked', blocked)
    }
    function success(): void {
      completed()
      finish({ kind: 'cleared' })
    }
    function error(): void {
      completed()
      finish({ kind: 'failed', error: request.error })
    }
    function blocked(): void {
      finish({ kind: 'pending' })
    }
    request.addEventListener('success', success)
    request.addEventListener('error', error)
    request.addEventListener('blocked', blocked)
  })
  // blocked/超时之后原请求仍可能完成，只忘掉这份退役库请求；绝不在回调里继续删用户键。
  deleting.set(factory, result)
  return result
}

export async function clearLegacyStorage(userId: string, options: LegacyStorageOptions): Promise<MetadataCleanupOutcome> {
  let problem: { readonly kind: 'failed', readonly error: unknown } | undefined
  for (const [storage, sdk] of [[options.localStorage, true], [options.sessionStorage, false]] as const) {
    try {
      removeMatching(storage(), key => retiredIntent(key) || pendingMarker(key, userId) || (sdk && (key.startsWith(SDK_PREFIX) || key === MOBILE_RECENT)))
    }
    catch (error) {
      problem ??= { kind: 'failed', error }
    }
  }
  try {
    const database = await deleteSdkDatabase(options.indexedDB(), options.timeoutMs ?? 3_000)
    return problem ?? database
  }
  catch (error) {
    return problem ?? { kind: 'failed', error }
  }
}
