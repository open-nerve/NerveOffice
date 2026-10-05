/**
 * 按键（例如账户）限制同时占用的份数（M3-P3 审查 A2）：一个键至多 limit 份，占满之后这个键再来的立即被拒，别的键不受影响。
 * 与 Semaphore 搭配用：Semaphore 限制总的并发与排队，KeyedQuota 限制每个键在其中占的份数——占一份从进入排队算起、到有结果为止，
 * 执行中与排队中的都算，所以一个键挤不满整个排队。只在一个进程的内存里计数
 */
export class KeyedQuota {
  readonly #limit: number
  readonly #held = new Map<string, number>()

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError(`每个键的份数上限必须是正整数：${limit}`)
    this.#limit = limit
  }

  /** 这个键现在占着几份 */
  heldBy(key: string): number {
    return this.#held.get(key) ?? 0
  }

  /** 占一份：拿到时返回交回的函数（多次调用只交回一次），这个键已经占满时返回 undefined */
  tryAcquire(key: string): (() => void) | undefined {
    const held = this.heldBy(key)
    if (held >= this.#limit)
      return undefined
    this.#held.set(key, held + 1)
    let returned = false
    return () => {
      if (returned)
        return
      returned = true
      const remaining = this.heldBy(key) - 1
      if (remaining > 0)
        this.#held.set(key, remaining)
      else
        this.#held.delete(key)
    }
  }
}
