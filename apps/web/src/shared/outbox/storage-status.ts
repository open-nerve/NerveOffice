// 本机存储的状态（M4-P1 设计 §3.1、§3.5，M4 总设计 §6.1、§6.7）：包住 navigator.storage 的 persisted()、persist()、estimate()。
// 只在页面里用（Worker 里没有 persist）：P2 在第一次进入编辑时申请持久保存，P4 的本机草稿页显示是否获准持久保存、用量与配额。
// 结果一律带 kind，不抛异常：没有接口 → unsupported；浏览器不给持久保存 → denied；出错 → failed（只带名字与消息）

/** 出错时的说明：名字与消息（不带别的，可以照原样显示、上报） */
export interface StorageError {
  readonly name: string
  readonly message: string
}

type Unavailable
  = | { readonly kind: 'unsupported' }
    | { readonly kind: 'failed', readonly error: StorageError }

/** 是否已获准持久保存（浏览器存储空间紧张时也不清掉这个站点的数据） */
export type PersistedState
  = | { readonly kind: 'persisted' }
    | { readonly kind: 'not-persisted' }
    | Unavailable

/** 申请持久保存的结果 */
export type PersistOutcome
  = | { readonly kind: 'granted' }
    | { readonly kind: 'denied' }
    | Unavailable

/** 用量与配额（字节）：浏览器没给的、不是有限的非负数的为 undefined */
export type EstimateOutcome
  = | { readonly kind: 'estimated', readonly usage: number | undefined, readonly quota: number | undefined }
    | Unavailable

/** 页面里的 StorageManager；没有、或者取它本身就抛出（沙箱的限制）时为 undefined */
export function browserStorageManager(): StorageManager | undefined {
  try {
    return typeof navigator === 'undefined' ? undefined : (navigator as { readonly storage?: StorageManager }).storage
  }
  catch {
    return undefined
  }
}

function storageErrorOf(error: unknown): StorageError {
  if (typeof error === 'object' && error !== null && 'name' in error && 'message' in error)
    return { name: String(error.name), message: String(error.message) }
  return { name: 'Error', message: String(error) }
}

/** 调 StorageManager 的一个方法：没有这个方法是 unsupported，抛出与拒绝都是 failed */
async function call<T>(manager: StorageManager | undefined, method: 'persisted' | 'persist' | 'estimate', read: (value: unknown) => T): Promise<T | Unavailable> {
  const target: unknown = manager === undefined ? undefined : (manager as unknown as Record<string, unknown>)[method]
  if (manager === undefined || typeof target !== 'function')
    return { kind: 'unsupported' }
  try {
    return read(await (target as () => Promise<unknown>).call(manager))
  }
  catch (error) {
    return { kind: 'failed', error: storageErrorOf(error) }
  }
}

function byteCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export async function storagePersisted(manager: StorageManager | undefined = browserStorageManager()): Promise<PersistedState> {
  return call(manager, 'persisted', value => value === true ? { kind: 'persisted' } : { kind: 'not-persisted' })
}

/** 申请持久保存（浏览器可能直接给、按使用情况给，或者不给；Safari 与 Chromium 的判断各不相同） */
export async function requestPersistence(manager: StorageManager | undefined = browserStorageManager()): Promise<PersistOutcome> {
  return call(manager, 'persist', value => value === true ? { kind: 'granted' } : { kind: 'denied' })
}

export async function storageEstimate(manager: StorageManager | undefined = browserStorageManager()): Promise<EstimateOutcome> {
  return call(manager, 'estimate', (value) => {
    const estimate = typeof value === 'object' && value !== null ? value as { readonly usage?: unknown, readonly quota?: unknown } : {}
    return { kind: 'estimated', usage: byteCount(estimate.usage), quota: byteCount(estimate.quota) }
  })
}
