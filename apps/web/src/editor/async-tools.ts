// 编辑器就绪与等待用的几个小工具：可以在外部完成的 Promise、带时限的等待、按间隔轮询
export interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  // Promise 的执行函数同步运行，构造完成时这两个已经换成真正的回调
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

/** 到时限还没完成就以 onTimeout 给出的错误失败；无论结果如何都清掉计时器 */
export async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 每隔 intervalMs 检查一次 condition，成立就返回 true；超过 timeoutMs 仍不成立返回 false。
 * 先检查一次再等待，所以条件本来就成立时立即返回
 */
export async function pollUntil(condition: () => boolean, options: { timeoutMs: number, intervalMs: number, now?: () => number }): Promise<boolean> {
  const now = options.now ?? (() => performance.now())
  const deadline = now() + options.timeoutMs
  for (;;) {
    if (condition())
      return true
    const left = deadline - now()
    if (left <= 0)
      return false
    await new Promise(resolve => setTimeout(resolve, Math.min(options.intervalMs, left)))
  }
}
