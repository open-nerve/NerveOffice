/** 限制同时进行的异步任务数：超出的按先来后到排队。 */
export class Semaphore {
  #available: number
  readonly #waiting: (() => void)[] = []

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1)
      throw new RangeError(`并发上限必须是正整数：${permits}`)
    this.#available = permits
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
    await new Promise<void>(resolve => this.#waiting.push(resolve))
  }

  /** 有人排队时名额直接交给下一个，不经过 #available：免得后来的任务插队。 */
  #release(): void {
    const next = this.#waiting.shift()
    if (next === undefined)
      this.#available += 1
    else
      next()
  }
}
