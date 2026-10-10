// 记下发件箱 Worker 里 OPFS 镜像的同步访问句柄的操作（截断、写、flush 与 flush 返回），经以 Worker 的名字为名的 BroadcastChannel
// 发给页面里的崩溃探针（crash-probe.ts）；按页面的要求在写镜像的某一步之后停住 Worker，等测试进程冻住、结束整个浏览器（S9 第 5 项：
// 写镜像途中结束）。镜像在 IndexedDB 提交之后写：截断 → 写内容（在头之后）→ 写头（在开头）→ flush（设计 §3.8）。写 3.8 MiB 只要几毫秒，
// 比"报到页面、页面通知测试进程、测试进程冻住"还快，按时机冻不到半途，所以在要测的那一步之后让 Worker 忙等（至多 PAUSE_MS），测试进程收到
// "停住了"就冻住、结束：槽位就停在那一步写完的样子（进程被结束时已经写进文件的还在）。
// 与记下事务的 transaction-recorder.ts 同一个频道、同一种写法；不经 Worker 自己的消息（那是协议的通道）。包的是 FileSystemSyncAccessHandle
// 的原型（专用 Worker 里才有；没有时什么也不包）。只在测试构建里（crash-probe.worker.ts 引入它）

/** 写镜像时停住的那一步之后：截断、写内容、写头、flush */
export type MirrorPausePoint = 'after-truncate' | 'after-content' | 'after-header' | 'after-flush'

/** 报给页面的：一次操作（flushed：flush 返回之后）；armed：收到了停住的要求；paused：停在了那一步之后 */
export type ProbeMirrorOperation
  = | { readonly mirror: 'truncate' | 'write' | 'flush' | 'flushed' }
    | { readonly mirror: 'armed' | 'paused', readonly point: MirrorPausePoint }

/** 页面发来的：下一次写镜像时在这一步之后停住 */
export interface ProbeMirrorPause {
  readonly pauseMirror: MirrorPausePoint
}

/** 停住的上限（毫秒）：测试进程几十毫秒内就冻住、结束整个浏览器；到点没结束（例如没人在等）就接着写，不挂住 */
const PAUSE_MS = 10_000

const OPERATIONS = ['truncate', 'write', 'flush'] as const

/** Worker 的名字（new Worker 的 name）：DOM 的类型里全局的 name 是 void（防误用），Worker 里它是创建时给的名字 */
const workerName = (globalThis as unknown as { readonly name: string }).name
const channel = new BroadcastChannel(workerName)
const prototype = (globalThis as unknown as { readonly FileSystemSyncAccessHandle?: { readonly prototype: object } }).FileSystemSyncAccessHandle?.prototype

/** 下一次写镜像时要停住的那一步（停过就清掉） */
let pauseAt: MirrorPausePoint | undefined

function report(operation: ProbeMirrorOperation): void {
  channel.postMessage(operation)
}

channel.onmessage = (event: MessageEvent<unknown>) => {
  const data = event.data
  if (typeof data === 'object' && data !== null && 'pauseMirror' in data) {
    pauseAt = (data as ProbeMirrorPause).pauseMirror
    report({ mirror: 'armed', point: pauseAt })
  }
}

/** 到了要停的那一步：报给页面，忙等（Worker 停在这一刻），到点接着走 */
function pauseIfAsked(point: MirrorPausePoint): void {
  if (pauseAt !== point)
    return
  pauseAt = undefined
  report({ mirror: 'paused', point })
  const deadline = performance.now() + PAUSE_MS
  while (performance.now() < deadline) {
    // 忙等：等测试进程冻住、结束整个浏览器
  }
}

/** 这一次操作做完之后是不是要停的那一步：写在开头的是头，写在后面的是内容 */
function pointAfter(operation: typeof OPERATIONS[number], args: readonly unknown[]): MirrorPausePoint {
  if (operation === 'truncate')
    return 'after-truncate'
  if (operation === 'flush')
    return 'after-flush'
  const options = args[1] as { readonly at?: number } | undefined
  return (options?.at ?? 0) === 0 ? 'after-header' : 'after-content'
}

if (prototype !== undefined) {
  for (const operation of OPERATIONS) {
    const original: unknown = Reflect.get(prototype, operation)
    if (typeof original !== 'function')
      throw new TypeError(`FileSystemSyncAccessHandle.prototype.${operation} 不是函数`)
    Object.defineProperty(prototype, operation, {
      configurable: true,
      writable: true,
      value: function recorded(this: unknown, ...args: unknown[]): unknown {
        report({ mirror: operation })
        const result: unknown = Reflect.apply(original, this, args)
        if (operation === 'flush')
          report({ mirror: 'flushed' })
        pauseIfAsked(pointAfter(operation, args))
        return result
      },
    })
  }
}
