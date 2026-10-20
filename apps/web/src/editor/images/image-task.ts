/** 图片异步任务必须及时响应退役；忽略取消的底层仍会被消费，晚分配的资源交回释放。 */
export async function runImageTask<T>(signal: AbortSignal, start: () => Promise<T>, discard?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const abort = (): void => {
      if (settled)
        return
      settled = true
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    const finish = (): void => {
      settled = true
      signal.removeEventListener('abort', abort)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    let task: Promise<T>
    try {
      task = start()
    }
    catch (error) {
      finish()
      reject(error)
      return
    }
    void task.then((value) => {
      if (settled) {
        discard?.(value)
        return
      }
      finish()
      resolve(value)
    }, (error: unknown) => {
      if (settled)
        return
      finish()
      reject(error)
    })
  })
}
