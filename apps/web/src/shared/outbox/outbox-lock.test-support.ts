import type { OutboxLockApi } from './outbox-lock.ts'

export function deferred<T>(): { readonly promise: Promise<T>, readonly resolve: (value: T | PromiseLike<T>) => void, readonly reject: (reason?: unknown) => void } {
  let resolve: (value: T | PromiseLike<T>) => void = () => {}
  let reject: (reason?: unknown) => void = () => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

/** jsdom 没有 Web Locks；同名锁排队，尚未开始的请求可取消，已开始的回调以实际完成为释放边界。 */
export function fakeOutboxLocks(): OutboxLockApi {
  const tails = new Map<string, Promise<void>>()
  return {
    request: async (name, { signal }, task) => {
      const result = deferred<Awaited<ReturnType<typeof task>>>()
      const abort = (): void => result.reject(new DOMException('等待锁时已取消', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
      const run = (tails.get(name) ?? Promise.resolve()).then(async () => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) {
          abort()
          return
        }
        try {
          result.resolve(await task())
        }
        catch (error) {
          result.reject(error)
        }
      })
      tails.set(name, run)
      return result.promise
    },
  }
}
