// 用户草稿、维护与会话状态共用的连接和 strict 事务；事务体只使用 IDB 回调，不等待外部异步。
import type { OutboxConnection, OutboxUnavailable } from './database.ts'
import { browserIndexedDb, openOutboxDatabase } from './database.ts'
import { canSealDrafts } from './draft-codec.ts'

/**
 * 存储这一侧的问题：
 * - quota：写满（QuotaExceededError，put 上或提交时），整个事务回滚，原记录与高水位都不变（US-M4-11）；
 * - unavailable：库用不了（database.ts 的四种原因），调用方退化为内存实现；
 * - failed：别的错误，带上原样的错误（跨 Worker 时由协议折成名字与消息）
 */
export interface SessionInvalid { readonly kind: 'session-invalid' }

export type StoreProblem
  = | { readonly kind: 'quota' }
    | SessionInvalid
    | OutboxUnavailable
    | { readonly kind: 'failed', readonly error: unknown }

export function isStoreProblem(value: { readonly kind: string }): value is StoreProblem {
  return value.kind === 'quota' || value.kind === 'session-invalid' || value.kind === 'unavailable' || value.kind === 'failed'
}

export interface StoreOptions {
  /** 取 IndexedDB 的工厂（database.ts 的 browserIndexedDb，页面与 Worker 里都是 globalThis.indexedDB） */
  readonly factory?: () => IDBFactory | undefined
  /** 升级被别的标签页挡住时等多久（毫秒） */
  readonly blockedTimeoutMs: number
}

/** 一次事务的结局：提交了（带判定的结果），或者中止了（带错误：写满、连接断开……，提交时写满同样在这里） */
type Settled<T>
  = | { readonly kind: 'committed', readonly value: T }
    | { readonly kind: 'aborted', readonly error: unknown }

/** 事务里的写法：结果经 finish 记下，提交之后才交回；请求的回调经 then 挂上——回调里抛出的错误中止事务、交回这个错误 */
export interface TransactionScope<T> {
  readonly tx: IDBTransaction
  readonly finish: (value: T) => void
  readonly then: <R>(request: IDBRequest<R>, callback: (value: R) => void) => void
}

function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : undefined
}

/** 写满：put 上或提交时的 QuotaExceededError，整个事务回滚 */
function isQuota(error: unknown): boolean {
  return errorName(error) === 'QuotaExceededError'
}

/**
 * 连接断了：连接正在关闭时开事务（InvalidStateError）、Safari 的"Connection to Indexed Database server lost"（UnknownError）。
 * 中止了的事务什么也没写，重开一次再试；写入的重试是幂等的（同一写入者同一序号按 duplicate）
 */
function isConnectionLost(error: unknown): boolean {
  const name = errorName(error)
  return name === 'InvalidStateError' || name === 'UnknownError'
}

/**
 * 在 stores 上开一个事务：读写的一律 strict（报告写完之前要求落盘，00 号计划书 §7.5）。body 里只用请求的回调，
 * 不 await 别的异步（否则事务自动提交，判定与写入之间就能插进别的标签页）。开事务本身抛出（连接正在关闭）由调用方接住
 */
async function transact<T>(db: IDBDatabase, mode: IDBTransactionMode, stores: readonly string[], body: (scope: TransactionScope<T>) => void): Promise<Settled<T>> {
  const tx = mode === 'readwrite' ? db.transaction([...stores], mode, { durability: 'strict' }) : db.transaction([...stores], mode)
  return new Promise((resolve) => {
    let result: { readonly value: T } | undefined
    let failure: { readonly error: unknown } | undefined
    const fail = (error: unknown): void => {
      failure ??= { error }
      try {
        tx.abort()
      }
      catch {
        // 事务已经结束（提交或中止过了）：结局由 complete 或 abort 交回
      }
    }
    tx.oncomplete = () => resolve(result === undefined ? { kind: 'aborted', error: new Error('事务提交无结果') } : { kind: 'committed', value: result.value })
    tx.onabort = () => resolve({ kind: 'aborted', error: failure?.error ?? tx.error ?? new DOMException('事务被中止', 'AbortError') })
    const scope: TransactionScope<T> = {
      tx,
      finish: (value) => {
        result = { value }
      },
      then: (request, callback) => {
        request.onsuccess = () => {
          try {
            callback(request.result)
          }
          catch (error) {
            fail(error)
          }
        }
      },
    }
    try {
      body(scope)
    }
    catch (error) {
      fail(error)
    }
  })
}

export function createStoreTransactions(options: StoreOptions) {
  const factory = options.factory ?? browserIndexedDb
  let connection: OutboxConnection | undefined
  let opening: Promise<OutboxConnection | OutboxUnavailable> | undefined

  async function connect(): Promise<OutboxConnection | OutboxUnavailable> {
    if (connection !== undefined && !connection.isClosed())
      return connection
    // 非安全上下文里没有 crypto.subtle：草稿封不了，发件箱整个用不了（判断在 draft-codec.ts，单元测试覆盖）
    if (!canSealDrafts(globalThis))
      return { kind: 'unavailable', reason: 'unsupported' }
    opening ??= openOutboxDatabase({ factory, blockedTimeoutMs: options.blockedTimeoutMs }).then((result) => {
      opening = undefined
      if (result.kind === 'connected')
        connection = result
      return result
    })
    return opening
  }

  async function run<T>(stores: readonly string[], mode: IDBTransactionMode, body: (scope: TransactionScope<T>) => void): Promise<T | StoreProblem> {
    for (let attempt = 1; ; attempt += 1) {
      const current = await connect()
      if (current.kind === 'unavailable')
        return current
      let settled: Settled<T>
      try {
        settled = await transact(current.db, mode, stores, body)
      }
      catch (error) {
        settled = { kind: 'aborted', error }
      }
      if (settled.kind === 'committed')
        return settled.value
      if (isQuota(settled.error))
        return { kind: 'quota' }
      if (attempt === 1 && isConnectionLost(settled.error)) {
        current.close()
        continue
      }
      return { kind: 'failed', error: settled.error }
    }
  }

  return {
    run,
    close: () => {
      connection?.close()
      connection = undefined
    },
  }
}
