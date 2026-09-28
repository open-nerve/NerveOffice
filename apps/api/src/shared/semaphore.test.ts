import { describe, expect, it, vi } from 'vitest'
import { Semaphore } from './semaphore.ts'

function deferred(): { promise: Promise<void>, resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** 等排队中的微任务都跑完 */
async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

describe('Semaphore', () => {
  it('同时进行的任务不超过上限，超出的按先来后到执行', async () => {
    const semaphore = new Semaphore(2)
    const gates = [deferred(), deferred(), deferred(), deferred()]
    const started: number[] = []
    let running = 0
    let peak = 0
    const tasks = gates.map(async (gate, index) => semaphore.run(async () => {
      started.push(index)
      running += 1
      peak = Math.max(peak, running)
      await gate.promise
      running -= 1
      return index
    }))
    await flush()
    expect(started).toEqual([0, 1])
    gates[1]?.resolve()
    await flush()
    expect(started).toEqual([0, 1, 2])
    for (const gate of gates)
      gate.resolve()
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3])
    expect(started).toEqual([0, 1, 2, 3])
    expect(peak).toBe(2)
  })

  it('任务失败也归还名额，错误原样抛出', async () => {
    const semaphore = new Semaphore(1)
    await expect(semaphore.run(async () => {
      throw new Error('失败')
    })).rejects.toThrow('失败')
    expect(await semaphore.run(async () => 'ok')).toBe('ok')
  })

  it('上限必须是正整数', () => {
    for (const permits of [0, -1, 1.5, Number.NaN])
      expect(() => new Semaphore(permits), String(permits)).toThrow(RangeError)
  })

  it('排队满了：再来的立即失败，任务不执行；名额空出来之后照常排队（DEF-015）', async () => {
    const semaphore = new Semaphore(1, { maxWaiting: 1 })
    const gate = deferred()
    const first = semaphore.run(async () => gate.promise)
    const second = semaphore.run(async () => 'second')
    let ran = false
    await expect(semaphore.run(async () => {
      ran = true
    })).rejects.toMatchObject({ name: 'SemaphoreBusyError', reason: 'queue-full' })
    expect(ran).toBe(false)
    gate.resolve()
    await first
    expect(await second).toBe('second')
    expect(await semaphore.run(async () => 'later')).toBe('later')
  })

  it('排队超时：离开队列并失败，不占名额；轮到之前被释放的名额交给后面的任务（DEF-015）', async () => {
    vi.useFakeTimers()
    try {
      const semaphore = new Semaphore(1, { maxWaitMs: 100 })
      const gate = deferred()
      const first = semaphore.run(async () => gate.promise)
      const timedOut = semaphore.run(async () => 'never')
      const outcome = expect(timedOut).rejects.toMatchObject({ reason: 'wait-timeout' })
      await vi.advanceTimersByTimeAsync(100)
      await outcome
      const third = semaphore.run(async () => 'third')
      gate.resolve()
      await first
      expect(await third).toBe('third')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('名额交出之后，原来的计时点到了也不影响后来排队的任务（审查 A3）', async () => {
    vi.useFakeTimers()
    try {
      const semaphore = new Semaphore(1, { maxWaitMs: 100 })
      const gate = deferred()
      const first = semaphore.run(async () => gate.promise)
      const slow = deferred()
      // 在 0 毫秒排队，计时点是 100 毫秒；50 毫秒时轮到
      const second = semaphore.run(async () => slow.promise)
      await vi.advanceTimersByTimeAsync(50)
      gate.resolve()
      await first
      // 在 50 毫秒排队，计时点是 150 毫秒；越过第二个任务原来的计时点（100 毫秒）
      const third = semaphore.run(async () => 'third')
      await vi.advanceTimersByTimeAsync(60)
      slow.resolve()
      await second
      expect(await third).toBe('third')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('轮到之后不再计时：排队的任务执行得再久也不超时', async () => {
    vi.useFakeTimers()
    try {
      const semaphore = new Semaphore(1, { maxWaitMs: 100 })
      const gate = deferred()
      const first = semaphore.run(async () => gate.promise)
      const slow = deferred()
      const second = semaphore.run(async () => {
        await slow.promise
        return 'second'
      })
      await vi.advanceTimersByTimeAsync(50)
      gate.resolve()
      await first
      await vi.advanceTimersByTimeAsync(500)
      slow.resolve()
      expect(await second).toBe('second')
    }
    finally {
      vi.useRealTimers()
    }
  })
})
