// 一次完整请求的取消与时限；覆盖 fetch、正文读取及契约校验，结果未知不能被误写成确定拒绝。
import { RequestTimeoutError } from './api-errors.ts'

export interface RequestDeadlineOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
}

export async function withinRequestDeadline<T>({ timeoutMs, signal }: RequestDeadlineOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const until = performance.now() + timeoutMs
  let rejectCancellation: (reason: unknown) => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })

  function cancel(reason: unknown): void {
    if (controller.signal.aborted)
      return
    // 先确定对外结果，再让 fetch/正文流因 abort 失败；后者不能抢先将超时归成格式错误或普通 4xx。
    rejectCancellation(reason)
    controller.abort(reason)
  }

  function timedOut(): void {
    cancel(new RequestTimeoutError(timeoutMs))
  }

  function checkDeadline(): void {
    // 同步解析可能跨过截止时刻，而计时器还没轮到执行；成功和失败都核对，不能交回超时之后才形成的 4xx。
    if (performance.now() >= until)
      timedOut()
    controller.signal.throwIfAborted()
  }

  const onAbort = () => cancel(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(timedOut, timeoutMs)
  try {
    // 包住同步抛错，并给迟到的兑现/拒绝都安装处理器；底层不理 abort 时调用方仍能按时结束。
    const work = (async () => run(controller.signal))()
    const checked = work.then((value) => {
      checkDeadline()
      return value
    }, (error: unknown) => {
      checkDeadline()
      throw error
    })
    return await Promise.race([cancelled, checked])
  }
  finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
