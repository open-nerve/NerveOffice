/** 排队的上限（DEF-015）：不设时不限。 */
export interface SemaphoreLimits {
  /** 同时排队的任务数的上限：满了之后再来的立即失败 */
  readonly maxWaiting?: number
  /** 排队等待的上限（毫秒）：等满了还没轮到就失败，并离开队列 */
  readonly maxWaitMs?: number
}

/** 排队满了或等待超时：任务没有执行 */
export class SemaphoreBusyError extends Error {
  constructor(readonly reason: 'queue-full' | 'wait-timeout') {
    super(reason === 'queue-full' ? '排队已满' : '排队等待超时')
    this.name = 'SemaphoreBusyError'
  }
}

interface Waiter {
  readonly grant: () => void
  readonly timer: ReturnType<typeof setTimeout> | undefined
}

/** 限制同时进行的异步任务数：超出的按先来后到排队；可以限制排队的长度与等待的时长。 */
export class Semaphore {
  #available: number
  readonly #waiting: Waiter[] = []
  readonly #limits: SemaphoreLimits

  constructor(permits: number, limits: SemaphoreLimits = {}) {
    if (!Number.isInteger(permits) || permits < 1)
      throw new RangeError(`并发上限必须是正整数：${permits}`)
    this.#available = permits
    this.#limits = limits
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire()
    try {
      return await task()
    }
    finally {
      this.#release()
    }
  }

  async #acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available -= 1
      return
    }
    const { maxWaiting, maxWaitMs } = this.#limits
    if (maxWaiting !== undefined && this.#waiting.length >= maxWaiting)
      throw new SemaphoreBusyError('queue-full')
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: resolve,
        timer: maxWaitMs === undefined
          ? undefined
          : setTimeout(() => {
              this.#waiting.splice(this.#waiting.indexOf(waiter), 1)
              reject(new SemaphoreBusyError('wait-timeout'))
            }, maxWaitMs),
      }
      this.#waiting.push(waiter)
    })
  }

  /** 有人排队时名额直接交给下一个，不经过 #available：免得后来的任务插队。 */
  #release(): void {
    const next = this.#waiting.shift()
    if (next === undefined) {
      this.#available += 1
      return
    }
    clearTimeout(next.timer)
    next.grant()
  }
}
