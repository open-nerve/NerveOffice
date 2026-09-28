import type { Options } from '@node-rs/argon2'
import type { Argon2Runtime } from './password-hasher.ts'
import { hash } from '@node-rs/argon2'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Argon2PasswordHasher, PasswordHashingBusyError } from './password-hasher.ts'

/** 记下库函数同时在算的个数：并发上限要限制的正是它 */
const inFlight = vi.hoisted(() => ({ running: 0, peak: 0 }))

vi.mock('@node-rs/argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@node-rs/argon2')>()
  function tracked<A extends unknown[], R>(compute: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args) => {
      inFlight.running += 1
      inFlight.peak = Math.max(inFlight.peak, inFlight.running)
      try {
        return await compute(...args)
      }
      finally {
        inFlight.running -= 1
      }
    }
  }
  return { ...actual, hash: tracked(actual.hash), verify: tracked(actual.verify) }
})

/** 单元测试只验证行为，用最小的参数（配置的交叉检查不允许生产这么设） */
const PARAMETERS = { memoryKib: 8_192, iterations: 1, parallelism: 1 }

describe('Argon2PasswordHasher', () => {
  const hasher = new Argon2PasswordHasher(PARAMETERS, 2)

  it('哈希是 Argon2id 的 PHC 字符串，带着参数；同一个密码每次的盐不同', async () => {
    const first = await hasher.hash('correct horse battery staple')
    const second = await hasher.hash('correct horse battery staple')
    expect(first).toMatch(/^\$argon2id\$v=19\$m=8192,t=1,p=1\$/)
    expect(first).not.toBe(second)
  })

  it('验证：正确的密码通过，错误的不通过', async () => {
    const passwordHash = await hasher.hash('correct horse battery staple')
    expect(await hasher.verify(passwordHash, 'correct horse battery staple')).toBe(true)
    expect(await hasher.verify(passwordHash, 'Correct horse battery staple')).toBe(false)
  })

  it('存的哈希格式不对时抛出，不当作密码错误', async () => {
    await expect(hasher.verify('not-a-hash', 'x')).rejects.toThrow()
  })

  it('参数与当前配置不同时需要重新哈希', async () => {
    const passwordHash = await hasher.hash('correct horse battery staple')
    expect(hasher.needsRehash(passwordHash)).toBe(false)
    expect(new Argon2PasswordHasher({ ...PARAMETERS, memoryKib: 9_216 }, 1).needsRehash(passwordHash)).toBe(true)
    expect(new Argon2PasswordHasher({ ...PARAMETERS, iterations: 2 }, 1).needsRehash(passwordHash)).toBe(true)
    expect(new Argon2PasswordHasher({ ...PARAMETERS, parallelism: 2 }, 1).needsRehash(passwordHash)).toBe(true)
  })

  describe('并发上限', () => {
    beforeEach(() => {
      inFlight.peak = 0
    })

    it.each([1, 2])('上限为 %i 时，同时在算的不超过它；超出的排队，结果都正确', async (limit) => {
      const limited = new Argon2PasswordHasher(PARAMETERS, limit)
      const passwordHash = await limited.hash('correct horse battery staple')
      inFlight.peak = 0
      const results = await Promise.all(Array.from({ length: 6 }, async (_unused, index) => (index % 2 === 0
        ? limited.verify(passwordHash, 'correct horse battery staple')
        : (await limited.hash('x')).startsWith('$argon2id$'))))
      expect(results).toEqual([true, true, true, true, true, true])
      expect(inFlight.peak).toBe(limit)
    })

    it('计算失败也归还名额', async () => {
      const limited = new Argon2PasswordHasher(PARAMETERS, 1)
      await expect(limited.verify('not-a-hash', 'x')).rejects.toThrow()
      expect((await limited.hash('x')).startsWith('$argon2id$')).toBe(true)
    })
  })

  describe('排队的上限（DEF-015）', () => {
    it('排队满了：哈希与验证都立即失败，建议的重试时间是等待时限（向上取整到秒）；已经排上的照常算完', async () => {
      // 2.1 秒：向上取整是 3，四舍五入会是 2
      const limited = new Argon2PasswordHasher(PARAMETERS, 1, { maxWaiting: 1, maxWaitMs: 2_100 })
      const running = limited.hash('a')
      const waiting = limited.hash('b')
      await expect(limited.hash('c')).rejects.toMatchObject({ name: 'PasswordHashingBusyError', retryAfterSeconds: 3 })
      await expect(limited.verify(await running, 'a')).resolves.toBe(true)
      expect((await waiting).startsWith('$argon2id$')).toBe(true)
    })

    it('没有等待时限时建议 1 秒后再试；计算本身的错误不算繁忙', async () => {
      const limited = new Argon2PasswordHasher(PARAMETERS, 1, { maxWaiting: 0 })
      const running = limited.hash('a')
      const busy = await limited.verify('not-a-hash', 'x').catch((error: unknown) => error)
      expect(busy).toBeInstanceOf(PasswordHashingBusyError)
      expect(busy).toMatchObject({ retryAfterSeconds: 1 })
      await running
      await expect(limited.verify('not-a-hash', 'x')).rejects.not.toBeInstanceOf(PasswordHashingBusyError)
    })
  })
})

describe('失败的验证补齐耗时（Codex 评审 CX4，独立复验 N2）', () => {
  const CURRENT = { memoryKib: 8_192, iterations: 2, parallelism: 1 }

  /** 真实的 PHC 字符串（parseOptions 要能解析），参数由测试给出 */
  async function storedHash(memoryCost: number, timeCost: number): Promise<string> {
    return hash('correct horse battery staple', { memoryCost, timeCost, parallelism: 1 })
  }

  /**
   * 假的计算与时钟：每组参数的一次计算用多少毫秒由 costs 给出（按"m=…,t=…,p=…"），计算与睡眠都推进假的时钟；
   * 记下每次睡眠（补齐）的时长
   */
  function fakeRuntime(costs: Record<string, number>, matches = false) {
    let clock = 0
    const sleeps: number[] = []
    const cost = (options: Options | null | undefined): number => costs[`m=${options?.memoryCost},t=${options?.timeCost},p=${options?.parallelism}`] ?? 0
    const runtime: Partial<Argon2Runtime> = {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
      hash: vi.fn(async (_password: string | Uint8Array, options?: Options | null) => {
        clock += cost(options)
        return 'hashed'
      }),
      verify: vi.fn(async (passwordHash: string | Uint8Array) => {
        const [, , , segment = ''] = String(passwordHash).split('$')
        clock += costs[segment] ?? 0
        return matches
      }),
    }
    return { runtime, sleeps, elapsed: () => clock }
  }

  it('只有当前参数：失败补到耗时中位数的 1.2 倍（余量），通过时不补', async () => {
    const current = await storedHash(8_192, 2)
    const failing = fakeRuntime({ 'm=8192,t=2,p=1': 10 })
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, failing.runtime)
    expect(await hasher.verify(current, 'wrong')).toBe(false)
    expect(failing.sleeps).toEqual([2])
    expect(failing.elapsed()).toBe(12)

    const passing = fakeRuntime({ 'm=8192,t=2,p=1': 10 }, true)
    expect(await new Argon2PasswordHasher(CURRENT, 1, {}, passing.runtime).verify(current, 'right')).toBe(true)
    expect(passing.sleeps).toEqual([])
  })

  it('参数调高之后的旧哈希更快：失败补到当前参数的耗时（启动时的假哈希已经记下它）', async () => {
    const { runtime, sleeps, elapsed } = fakeRuntime({ 'm=8192,t=2,p=1': 20, 'm=8192,t=1,p=1': 7 })
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, runtime)
    await hasher.hash('假哈希')
    const started = elapsed()
    expect(await hasher.verify(await storedHash(8_192, 1), 'wrong')).toBe(false)
    expect(elapsed() - started).toBe(24)
    expect(sleeps).toEqual([17])
  })

  it('改的是内存：同样按实测的耗时补齐，不按"内存 × 迭代次数"换算', async () => {
    // 内存小了很多、迭代次数没变：按计算量换算会补得不准（N2），按耗时补齐与换算无关
    const { runtime, elapsed } = fakeRuntime({ 'm=65536,t=2,p=1': 90, 'm=8192,t=2,p=1': 10 })
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, runtime)
    await hasher.observe(['m=65536,t=2,p=1'])
    const started = elapsed()
    await hasher.verify(await storedHash(8_192, 2), 'wrong')
    expect(elapsed() - started).toBe(108)
  })

  it('参数调低之后：库里现存的更慢的参数组各算 3 次校准，之后当前参数的失败（包括用户名不存在的假哈希）都补到它', async () => {
    const { runtime, sleeps, elapsed } = fakeRuntime({ 'm=8192,t=2,p=1': 10, 'm=16384,t=4,p=1': 40 })
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, runtime)
    await hasher.observe(['m=16384,t=4,p=1', 'not-parameters', 'm=x,t=9,p=1', '', 'm=16384,t=4,p=1'])
    expect(runtime.hash).toHaveBeenCalledTimes(3)
    const started = elapsed()
    await hasher.verify(await storedHash(8_192, 2), 'wrong')
    expect(elapsed() - started).toBe(48)
    expect(sleeps).toEqual([38])
  })

  it('见过的参数组不再校准；验证到没见过的更慢的哈希时，之后的失败也补到它', async () => {
    const { runtime, elapsed } = fakeRuntime({ 'm=8192,t=2,p=1': 10, 'm=8192,t=5,p=1': 30 })
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, runtime)
    await hasher.verify(await storedHash(8_192, 2), 'wrong')
    await hasher.observe(['m=8192,t=2,p=1'])
    expect(runtime.hash).not.toHaveBeenCalled()
    // 旧哈希（更慢）的失败：补到它自己耗时的 1.2 倍
    let started = elapsed()
    await hasher.verify(await storedHash(8_192, 5), 'wrong')
    expect(elapsed() - started).toBe(36)
    started = elapsed()
    await hasher.verify(await storedHash(8_192, 2), 'wrong')
    expect(elapsed() - started).toBe(36)
  })

  it('按中位数估计：一次偶然的慢不抬高时限', async () => {
    let slow = false
    const base = fakeRuntime({ 'm=8192,t=2,p=1': 10 })
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, {
      ...base.runtime,
      verify: vi.fn(async (passwordHash: string | Uint8Array, password: string | Uint8Array) => {
        const result = await base.runtime.verify?.(passwordHash, password)
        if (slow)
          await base.runtime.sleep?.(490)
        return result ?? false
      }),
    })
    const current = await storedHash(8_192, 2)
    await hasher.verify(current, 'wrong')
    await hasher.verify(current, 'wrong')
    slow = true
    await hasher.verify(current, 'wrong')
    slow = false
    const started = base.elapsed()
    await hasher.verify(current, 'wrong')
    expect(base.elapsed() - started).toBe(12)
  })

  it('补齐与验证在同一个名额里：并发上限为 1 时，补完之前别的计算不开始', async () => {
    const order: string[] = []
    let releaseSleep: () => void = () => {}
    const base = fakeRuntime({ 'm=8192,t=2,p=1': 10 })
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, {
      ...base.runtime,
      sleep: vi.fn(async () => {
        order.push('pad:start')
        await new Promise<void>((resolve) => {
          releaseSleep = resolve
        })
        order.push('pad:end')
      }),
      hash: vi.fn(async () => {
        order.push('next:start')
        return 'hashed'
      }),
    })
    const failing = hasher.verify(await storedHash(8_192, 2), 'wrong')
    const next = hasher.hash('next')
    await vi.waitFor(() => expect(order).toEqual(['pad:start']))
    releaseSleep()
    await failing
    await next
    expect(order).toEqual(['pad:start', 'pad:end', 'next:start'])
  })
})
