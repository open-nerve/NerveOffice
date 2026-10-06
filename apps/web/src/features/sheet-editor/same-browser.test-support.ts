// 测试用：一个"浏览器"里的 Web Locks 与 BroadcastChannel（same-browser.ts 注入的 LockApi、ChannelApi 的假实现）。同一个 fakeBrowser 交出的
// apis 给几个"标签页"共用，就像同一个浏览器上下文里的几个页面（探索 §3.2 实测的行为）：
// - 锁：同名的锁同时只有一个持有者；ifAvailable 被占着时以 null 调用回调；steal 立即拿到，原来的持有者的请求以 AbortError 拒绝；
//   普通的请求排队，带 signal 时可以撤销（S6 等锁用）。回调交回的 Promise 结束时放开；拿到、放开都在微任务里，与浏览器一样不在调用的同步段里；
// - 频道：同名的各个端点之间广播，发出的一方自己收不到；结构化克隆之后在下一个宏任务里送到（settle 之后就到了），关掉之后不再收；
//   关掉之后再发抛出 InvalidStateError（与浏览器相同，适配层不该这样做）。
import type { ChannelApi, LockApi, LockRequestOptions, SameBrowserApis } from './same-browser.ts'

interface Holder {
  /** 请求者的标识：query 里给出，测试据此看是谁 */
  readonly client: string
  readonly reject: (error: unknown) => void
}

interface Waiter {
  readonly client: string
  readonly grant: () => void
  readonly abort: (error: unknown) => void
}

export interface FakeBrowser {
  readonly apis: SameBrowserApis
  /** 另一个标签页的 apis：锁与频道与 apis 共用，query 里的 clientId 不同 */
  readonly tab: (client: string) => SameBrowserApis
  /** 现在持有这把锁的标签页（没有时 undefined） */
  readonly holderOf: (name: string) => string | undefined
  /** 某个频道上还开着的端点数 */
  readonly openChannels: (name: string) => number
  /** 某个频道上发过的消息（按先后，克隆之后的） */
  readonly posted: (name: string) => readonly unknown[]
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

export function fakeBrowser(): FakeBrowser {
  const holders = new Map<string, Holder>()
  const queues = new Map<string, Waiter[]>()
  const endpoints = new Map<string, Set<(data: unknown) => void>>()
  const history = new Map<string, unknown[]>()

  /** 放开之后轮到排着的第一个 */
  function next(name: string): void {
    const waiter = queues.get(name)?.shift()
    waiter?.grant()
  }

  function locksFor(client: string): LockApi {
    return {
      request: async (name: string, options: LockRequestOptions, callback: (lock: unknown) => Promise<void>) => {
        await Promise.resolve()
        return new Promise<unknown>((resolve, reject) => {
          let ended = false
          const holder: Holder = {
            client,
            reject: (error) => {
              ended = true
              reject(error)
            },
          }
          const run = (): void => {
            holders.set(name, holder)
            void Promise.resolve().then(async () => callback({ name, mode: 'exclusive' })).then(
              (value) => {
                if (holders.get(name) === holder) {
                  holders.delete(name)
                  next(name)
                }
                if (!ended)
                  resolve(value)
              },
              (error: unknown) => {
                if (holders.get(name) === holder) {
                  holders.delete(name)
                  next(name)
                }
                if (!ended)
                  reject(error)
              },
            )
          }
          const current = holders.get(name)
          if (options.steal === true) {
            current?.reject(abortError('Lock broken by another request with the \'steal\' option.'))
            run()
            return
          }
          if (current === undefined) {
            run()
            return
          }
          if (options.ifAvailable === true) {
            void Promise.resolve().then(async () => callback(null)).then(resolve, reject)
            return
          }
          const queue = queues.get(name) ?? []
          queues.set(name, queue)
          const waiter: Waiter = { client, grant: run, abort: reject }
          queue.push(waiter)
          options.signal?.addEventListener('abort', () => {
            const index = queue.indexOf(waiter)
            if (index >= 0) {
              queue.splice(index, 1)
              waiter.abort(options.signal?.reason ?? abortError('The request was aborted.'))
            }
          })
        })
      },
      query: async () => ({
        held: [...holders].map(([name, holder]) => ({ name, mode: 'exclusive', clientId: holder.client })),
        pending: [...queues].flatMap(([name, queue]) => queue.map(waiter => ({ name, mode: 'exclusive', clientId: waiter.client }))),
      }),
    }
  }

  function openChannel(name: string): ChannelApi {
    const listeners = new Set<(event: MessageEvent<unknown>) => void>()
    let closed = false
    const deliver = (data: unknown): void => {
      if (closed)
        return
      for (const listener of [...listeners])
        listener(new MessageEvent('message', { data }))
    }
    const peers = endpoints.get(name) ?? new Set()
    endpoints.set(name, peers)
    peers.add(deliver)
    return {
      postMessage: (message) => {
        if (closed)
          throw new DOMException('BroadcastChannel is closed.', 'InvalidStateError')
        const cloned = structuredClone(message)
        const log = history.get(name) ?? []
        history.set(name, log)
        log.push(cloned)
        for (const peer of [...peers]) {
          if (peer !== deliver)
            setTimeout(() => peer(structuredClone(cloned)), 0)
        }
      },
      addEventListener: (_type, listener) => {
        listeners.add(listener)
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener)
      },
      close: () => {
        closed = true
        peers.delete(deliver)
      },
    }
  }

  const tab = (client: string): SameBrowserApis => ({ locks: locksFor(client), openChannel })
  return {
    apis: tab('tab-1'),
    tab,
    holderOf: name => holders.get(name)?.client,
    openChannels: name => endpoints.get(name)?.size ?? 0,
    posted: name => history.get(name) ?? [],
  }
}
