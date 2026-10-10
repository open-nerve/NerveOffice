// 同源发件箱的短期互斥：完整的主库 + 镜像操作与清理不能交错。OPFS 的长期句柄不持这把锁；内部 store/mirror/recovery 不重复加锁。
// 等待可以超时，已经开始的操作必须真正结束才释放（不能用 Promise.race 提前释放）。Worker 结束时浏览器也会释放它持有的锁。
export const OUTBOX_OPERATION_LOCK = 'nerve-office-outbox-operation'
export const OUTBOX_LOCK_WAIT_MS = 10_000

/** 页面与 Worker 的 navigator.locks 都满足；单元测试注入等价的排队接口。 */
export interface OutboxLockApi {
  readonly request: <T>(name: string, options: { readonly mode: 'exclusive', readonly signal: AbortSignal }, task: () => Promise<T>) => Promise<T>
}

export async function withOutboxLock<T>(task: () => Promise<T>, locks: OutboxLockApi | undefined = globalThis.navigator?.locks): Promise<T> {
  if (locks === undefined)
    throw new DOMException('本机发件箱需要 Web Locks 才能安全恢复、写入与清理', 'NotSupportedError')
  const waiting = new AbortController()
  const timeout = setTimeout(() => waiting.abort(), OUTBOX_LOCK_WAIT_MS)
  try {
    return await locks.request(OUTBOX_OPERATION_LOCK, { mode: 'exclusive', signal: waiting.signal }, async () => {
      clearTimeout(timeout)
      return task()
    })
  }
  finally {
    clearTimeout(timeout)
  }
}
