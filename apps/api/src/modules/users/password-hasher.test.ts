import type { Options } from '@node-rs/argon2'
import type { Argon2Functions } from './password-hasher.ts'
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

describe('失败的验证补齐计算量（Codex 评审 CX4）', () => {
  /** 计算量 = 内存（KiB）× 迭代次数 */
  const CURRENT = { memoryKib: 8_192, iterations: 2, parallelism: 1 }

  /** 真实的 PHC 字符串（parseOptions 要能解析），参数由测试给出 */
  async function storedHash(memoryCost: number, timeCost: number): Promise<string> {
    return hash('correct horse battery staple', { memoryCost, timeCost, parallelism: 1 })
  }

  /** 假的 Argon2：verify 按 matches 返回，记下每次 hash 的参数（补的计算） */
  function fakeArgon2(matches: boolean) {
    const padded: { memoryCost?: number, timeCost?: number, parallelism?: number }[] = []
    const functions: Argon2Functions = {
      hash: vi.fn(async (_password: string | Uint8Array, options?: Options | null) => {
        padded.push({ memoryCost: options?.memoryCost, timeCost: options?.timeCost, parallelism: options?.parallelism })
        return 'padded'
      }),
      verify: vi.fn(async () => matches),
    }
    return { functions, padded }
  }

  it('哈希是当前参数的：失败时不补；验证通过时也不补', async () => {
    const current = await storedHash(8_192, 2)
    for (const matches of [false, true]) {
      const { functions, padded } = fakeArgon2(matches)
      expect(await new Argon2PasswordHasher(CURRENT, 1, {}, functions).verify(current, 'x')).toBe(matches)
      expect(padded).toEqual([])
    }
  })

  it('参数调高之后的旧哈希：失败时补到当前参数的计算量（按当前的内存补迭代）；通过时不补', async () => {
    const old = await storedHash(8_192, 1)
    const failing = fakeArgon2(false)
    expect(await new Argon2PasswordHasher(CURRENT, 1, {}, failing.functions).verify(old, 'wrong')).toBe(false)
    expect(failing.padded).toEqual([{ memoryCost: 8_192, timeCost: 1, parallelism: 1 }])
    const passing = fakeArgon2(true)
    expect(await new Argon2PasswordHasher(CURRENT, 1, {}, passing.functions).verify(old, 'right')).toBe(true)
    expect(passing.padded).toEqual([])
  })

  it('补不满整次迭代的余数：另做一次余数大小的内存、一次迭代；内存都不超过当前参数的内存', async () => {
    // 当前 10240 × 2 = 20480；旧哈希 8192 × 1 = 8192；要补 12288 = 10240 × 1 + 2048
    const { functions, padded } = fakeArgon2(false)
    const hasher = new Argon2PasswordHasher({ memoryKib: 10_240, iterations: 2, parallelism: 1 }, 1, {}, functions)
    await hasher.verify(await storedHash(8_192, 1), 'wrong')
    expect(padded).toEqual([{ memoryCost: 10_240, timeCost: 1, parallelism: 1 }, { memoryCost: 2_048, timeCost: 1, parallelism: 1 }])
  })

  it('参数调低之后：验证过的旧哈希计算量更大，之后当前参数的失败（包括用户名不存在的假哈希）都补到它', async () => {
    const { functions, padded } = fakeArgon2(false)
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, functions)
    // 旧哈希 8192 × 5 = 40960：它自己的失败不补
    await hasher.verify(await storedHash(8_192, 5), 'wrong')
    expect(padded).toEqual([])
    // 当前参数 8192 × 2 = 16384：补 24576 = 8192 × 3
    await hasher.verify(await storedHash(8_192, 2), 'wrong')
    expect(padded).toEqual([{ memoryCost: 8_192, timeCost: 3, parallelism: 1 }])
  })

  it('库里现存哈希的参数：失败都补到其中最大的；认不出的参数段忽略', async () => {
    const { functions, padded } = fakeArgon2(false)
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, functions)
    hasher.observe(['m=8192,t=1,p=1', 'not-parameters', 'm=16384,t=4,p=1', 'm=x,t=9,p=1', ''])
    // 最大的是 16384 × 4 = 65536；当前参数的失败要补 65536 - 16384 = 49152 = 8192 × 6
    await hasher.verify(await storedHash(8_192, 2), 'wrong')
    expect(padded).toEqual([{ memoryCost: 8_192, timeCost: 6, parallelism: 1 }])
  })

  it('补的计算与验证在同一个名额里：并发上限为 1 时，补完之前别的计算不开始', async () => {
    const order: string[] = []
    let releasePad: () => void = () => {}
    const functions: Argon2Functions = {
      hash: vi.fn(async (password: string | Uint8Array) => {
        order.push(password === 'next' ? 'next:start' : 'pad:start')
        if (password !== 'next') {
          await new Promise<void>((resolve) => {
            releasePad = resolve
          })
          order.push('pad:end')
        }
        return 'hashed'
      }),
      verify: vi.fn(async () => false),
    }
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, functions)
    const failing = hasher.verify(await storedHash(8_192, 1), 'wrong')
    const next = hasher.hash('next')
    await vi.waitFor(() => expect(order).toEqual(['pad:start']))
    releasePad()
    await failing
    await next
    expect(order).toEqual(['pad:start', 'pad:end', 'next:start'])
  })
})
