import { describe, expect, it } from 'vitest'
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
})
