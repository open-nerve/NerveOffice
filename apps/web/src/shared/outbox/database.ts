// 本机发件箱的库（M4-P1 设计 §3.3、§3.4.1、§3.8）：IndexedDB 的库 nerve-office-outbox，三个对象仓库（草稿、写入者、比对镜像留下的提示），
// 键路径都是 ['userId', 'documentId']，没有索引。某个用户的全部记录用键范围 [userId] 到 [userId, []] 取（IndexedDB 的键序里数组排在字符串之后）。
// 结构以后有变，只做加法的升级（加仓库、加索引），旧的页面打开更新过的库得到 VersionError，按"不可用"退化。
// 连接上 versionchange 时立即关掉，让别的标签页的升级与删库继续（M0 审查 S5：打开着的页面挡住了升级）；被浏览器断开时记下，
// 之后由调用方重新打开（draft-store.ts）。
// 平台页面的列表标记（draft-index.ts）也引用这里：这个文件保持小，只引用记录的类型
import type { DraftKey } from './draft-record.ts'

export const OUTBOX_DATABASE_NAME = 'nerve-office-outbox'

/** 库的版本：结构有变时加一，升级只做加法 */
export const OUTBOX_DATABASE_VERSION = 1

/** 草稿：StoredDraft */
export const DRAFTS_STORE = 'drafts'

/** 写入者：WriterRecord */
export const WRITERS_STORE = 'writers'

/**
 * 比对 OPFS 镜像与库留下的提示：RecoveryNotice（recovery-notice.ts），一份文档一条。S9 加的；库还没有真实用户，直接放进版本 1 的结构，
 * 不另升级（开发时浏览器里留着没有它的旧库的，清掉站点数据）
 */
export const NOTICES_STORE = 'notices'

/** 三个仓库共用的键路径：记录里的 userId 与 documentId 就是它的键 */
export const OUTBOX_KEY_PATH: readonly (keyof DraftKey)[] = ['userId', 'documentId']

/**
 * 发件箱用不了的原因（§3.4.1）：调用方退化为内存实现，并如实说明（P2，US-M4-11）。
 * - unsupported：没有 IndexedDB，或者没有 crypto.subtle（非安全上下文）；
 * - denied：打不开（浏览器的策略禁止、私密模式的限制、磁盘出错）；
 * - newer-version：库被更新的页面升级过（VersionError）——本页过旧；
 * - blocked：升级被别的标签页挡住、等过了时限
 */
export type OutboxUnavailableReason = 'unsupported' | 'denied' | 'newer-version' | 'blocked'

export interface OutboxUnavailable {
  readonly kind: 'unavailable'
  readonly reason: OutboxUnavailableReason
}

/** 打开着的连接 */
export interface OutboxConnection {
  readonly kind: 'connected'
  readonly db: IDBDatabase
  /** 已经关了：versionchange 时自己关的、被浏览器断开的、调用方关的——之后要重新打开 */
  readonly isClosed: () => boolean
  readonly close: () => void
}

/**
 * 取 IndexedDB 的工厂：页面与 Worker 里都是 globalThis.indexedDB。取它本身就可能抛出（浏览器的策略禁止站点数据），
 * 由调用方在 try 里取，抛出算 denied
 */
export function browserIndexedDb(): IDBFactory | undefined {
  return globalThis.indexedDB
}

export interface OpenOutboxOptions {
  /** 取 IndexedDB 的工厂（见 browserIndexedDb）：没有算 unsupported，抛出算 denied */
  readonly factory: () => IDBFactory | undefined
  /** 升级被别的标签页挡住时等多久（毫秒）：到点交回 blocked，那次打开之后成功了也随即关掉 */
  readonly blockedTimeoutMs: number
  /** 打开的版本：生产一律是 OUTBOX_DATABASE_VERSION；浏览器层的用例用更高的版本扮演更新的页面（升级被挡住、库比代码新） */
  readonly version?: number
}

function unavailable(reason: OutboxUnavailableReason): OutboxUnavailable {
  return { kind: 'unavailable', reason }
}

function connectionOf(db: IDBDatabase): OutboxConnection {
  let closed = false
  const close = (): void => {
    if (closed)
      return
    closed = true
    db.close()
  }
  // 别的标签页要升级或删库：立即关掉，让它继续；之后的操作重新打开（打不开更新过的库时按 newer-version）
  db.onversionchange = close
  // 浏览器断开了连接（清除站点数据、Safari 的"Connection to Indexed Database server lost"）：关闭事件之后这个连接不能再用
  db.onclose = () => {
    closed = true
  }
  return { kind: 'connected', db, isClosed: () => closed, close }
}

/** 只做加法的升级：补上缺的仓库（v1 是三个仓库，键路径相同，没有索引）。按"有没有"判断，不按旧版本号：以后的版本照样只补缺的 */
function upgrade(db: IDBDatabase): void {
  for (const name of [DRAFTS_STORE, WRITERS_STORE, NOTICES_STORE]) {
    if (!db.objectStoreNames.contains(name))
      db.createObjectStore(name, { keyPath: [...OUTBOX_KEY_PATH] })
  }
}

/**
 * 打开发件箱的库（§3.4.1）：没有 IndexedDB → unsupported；取工厂或打开时抛出、打开出错 → denied；VersionError（库被更新的页面升级过）
 * → newer-version；升级被挡住、等过了时限 → blocked（blocked 只是通知，先等着；到点之后那次打开成功了也随即关掉，免得一直挡着别人）
 */
export async function openOutboxDatabase(options: OpenOutboxOptions): Promise<OutboxConnection | OutboxUnavailable> {
  let factory: IDBFactory | undefined
  try {
    factory = options.factory()
  }
  catch {
    return unavailable('denied')
  }
  if (factory === undefined)
    return unavailable('unsupported')
  const opener = factory
  return new Promise((resolve) => {
    let settled = false
    let blockedTimer: ReturnType<typeof setTimeout> | undefined
    const settle = (result: OutboxConnection | OutboxUnavailable): boolean => {
      if (settled)
        return false
      settled = true
      clearTimeout(blockedTimer)
      resolve(result)
      return true
    }
    let request: IDBOpenDBRequest
    try {
      request = opener.open(OUTBOX_DATABASE_NAME, options.version ?? OUTBOX_DATABASE_VERSION)
    }
    catch {
      settle(unavailable('denied'))
      return
    }
    request.onupgradeneeded = () => upgrade(request.result)
    request.onblocked = () => {
      blockedTimer ??= setTimeout(() => settle(unavailable('blocked')), options.blockedTimeoutMs)
    }
    request.onsuccess = () => {
      const connection = connectionOf(request.result)
      if (!settle(connection))
        connection.close()
    }
    request.onerror = () => {
      settle(unavailable(request.error?.name === 'VersionError' ? 'newer-version' : 'denied'))
    }
  })
}

/**
 * 只打开已经存在的库，不建它（平台页面的列表标记，draft-index.ts）：不带版本打开——库不存在时浏览器要建，在升级的事务里中止它，
 * 库随之不留下；打不开、等过了时限都交回 undefined（等过时限之后那次打开成功了也随即关掉）
 */
export async function openExistingOutboxDatabase(options: { readonly factory: () => IDBFactory | undefined, readonly timeoutMs: number }): Promise<OutboxConnection | undefined> {
  let factory: IDBFactory | undefined
  try {
    factory = options.factory()
  }
  catch {
    return undefined
  }
  if (factory === undefined)
    return undefined
  const opener = factory
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (result: OutboxConnection | undefined): boolean => {
      if (settled)
        return false
      settled = true
      clearTimeout(timer)
      resolve(result)
      return true
    }
    timer = setTimeout(settle, options.timeoutMs, undefined)
    let request: IDBOpenDBRequest
    try {
      request = opener.open(OUTBOX_DATABASE_NAME)
    }
    catch {
      settle(undefined)
      return
    }
    // 库还不存在：不建它（中止升级的事务，打开随之以 AbortError 失败，库不留下）
    request.onupgradeneeded = () => request.transaction?.abort()
    request.onsuccess = () => {
      const connection = connectionOf(request.result)
      if (!settle(connection))
        connection.close()
    }
    request.onerror = () => {
      settle(undefined)
    }
  })
}

/** 某个用户的全部记录：键 [userId, …]，从 [userId] 到 [userId, []]（键序里数组排在字符串、数字、日期之后） */
export function userKeyRange(userId: string): IDBKeyRange {
  return IDBKeyRange.bound([userId], [userId, []])
}

/** 记录的键 */
export function draftKeyPath(key: DraftKey): [string, string] {
  return [key.userId, key.documentId]
}
