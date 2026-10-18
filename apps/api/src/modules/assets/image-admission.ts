import { AppError } from '../../shared/errors/app-error.ts'
import { IMAGE_LIMITS } from './image-types.ts'

interface Waiting {
  start: () => void
  cancel: (error: Error) => void
}

export function imageBusy(): AppError {
  return new AppError('ASSET_BUSY', undefined, { headers: { 'Retry-After': '10' } })
}

export function imageAborted(): DOMException {
  // AbortSignal.reason 可能含调用方私有数据，不放进错误或日志。
  return new DOMException('图片请求已取消', 'AbortError')
}

/** 在读请求体之前排队；运行中的名额只在整个 task（含进程回收、存储）结束后释放。 */
export class ImageAdmission {
  readonly #accounts = new Map<string, number>()
  readonly #waiting: Waiting[] = []
  #running = false
  #closed = false

  async run<T>(accountId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (this.#closed)
      throw imageBusy()
    if (signal.aborted)
      throw imageAborted()
    const count = this.#accounts.get(accountId) ?? 0
    if (count >= IMAGE_LIMITS.perAccount || (this.#running && this.#waiting.length >= IMAGE_LIMITS.maxWaiting))
      throw imageBusy()
    this.#accounts.set(accountId, count + 1)
    if (!this.#running)
      return this.#execute(accountId, task)
    return new Promise<T>((resolve, reject) => {
      let pending = true
      let timer: ReturnType<typeof setTimeout>
      let entry: Waiting
      const abort = (): void => entry.cancel(imageAborted())
      const clean = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
      entry = {
        start: () => {
          if (!pending)
            return
          pending = false
          clean()
          this.#execute(accountId, task).then(resolve, reject)
        },
        cancel: (error) => {
          if (!pending)
            return
          pending = false
          clean()
          const index = this.#waiting.indexOf(entry)
          if (index !== -1)
            this.#waiting.splice(index, 1)
          this.#releaseAccount(accountId)
          reject(error)
        },
      }
      timer = setTimeout(() => entry.cancel(imageBusy()), IMAGE_LIMITS.maxWaitMs)
      timer.unref()
      this.#waiting.push(entry)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  /** 在途任务的 abort 与 reap 由上传服务/runner 完成，不能在这里提前释放槽。 */
  close(): void {
    this.#closed = true
    for (const entry of [...this.#waiting])
      entry.cancel(imageBusy())
  }

  async #execute<T>(accountId: string, task: () => Promise<T>): Promise<T> {
    this.#running = true
    try {
      return await task()
    }
    finally {
      this.#releaseAccount(accountId)
      this.#running = false
      this.#waiting.shift()?.start()
    }
  }

  #releaseAccount(accountId: string): void {
    const count = (this.#accounts.get(accountId) ?? 0) - 1
    if (count > 0)
      this.#accounts.set(accountId, count)
    else
      this.#accounts.delete(accountId)
  }
}
