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

/**
 * 失败的耗时不暴露账户是否存在（Codex 评审 CX4，ADR-007）：失败的验证与 reject（用户名不存在、账户已停用）按同样的顺序
 * 把同样的几组参数各算一次，两条路径的计算相同，耗时的分布就相同。原来按实测耗时的中位数补齐（等待），负载起落时守不住
 * （M2-P6 第 6 片合并之后 CI 上耗时之比 0.67）；这里核对的是"计算相同"本身，与快慢无关
 */
describe('失败的验证与"没有账户"做同样的计算（Codex 评审 CX4，ADR-007）', () => {
  const CURRENT = { memoryKib: 8_192, iterations: 2, parallelism: 1 }
  const C = 'm=8192,t=2,p=1'

  /** 真实的 PHC 字符串（parseOptions 要能解析），参数由测试给出 */
  async function storedHash(memoryCost: number, timeCost: number): Promise<string> {
    return hash('correct horse battery staple', { memoryCost, timeCost, parallelism: 1 })
  }

  /** 假的计算：按先后记下每次算的是哪组参数，陪算（hash）记参数，真的比对（verify）另加"（比对）"；matches 是比对的结果 */
  function fakeRuntime(matches = false) {
    const computed: string[] = []
    const runtime: Partial<Argon2Runtime> = {
      hash: vi.fn(async (_password: string | Uint8Array, options?: Options | null) => {
        computed.push(`m=${options?.memoryCost},t=${options?.timeCost},p=${options?.parallelism}`)
        return 'hashed'
      }),
      verify: vi.fn(async (passwordHash: string | Uint8Array) => {
        const [, , , segment = ''] = String(passwordHash).split('$')
        computed.push(`${segment}（比对）`)
        return matches
      }),
    }
    return { runtime, computed }
  }

  /** 只看算了哪几组、按什么顺序（不分陪算与比对） */
  const groupsOf = (computed: readonly string[]): string[] => computed.map(entry => entry.replace('（比对）', ''))

  /** reject 算的：用同一个哈希器、另记一份 */
  async function rejected(hasher: Argon2PasswordHasher, computed: string[]): Promise<string[]> {
    computed.length = 0
    expect(await hasher.reject('wrong')).toBe(false)
    return [...computed]
  }

  it('只有当前参数：失败比对一次，reject 算一次当前参数，两者相同；通过时只比对一次；observe 不计算', async () => {
    const current = await storedHash(8_192, 2)
    const { runtime, computed } = fakeRuntime()
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, runtime)
    hasher.observe([C])
    expect(computed).toEqual([])
    expect(await hasher.verify(current, 'wrong')).toBe(false)
    expect(computed).toEqual([`${C}（比对）`])
    expect(await rejected(hasher, computed)).toEqual([C])

    const passing = fakeRuntime(true)
    expect(await new Argon2PasswordHasher(CURRENT, 1, {}, passing.runtime).verify(current, 'right')).toBe(true)
    expect(passing.computed).toEqual([`${C}（比对）`])
  })

  it('参数调高之后的旧哈希（更快）：失败时先陪算当前参数、再比对旧参数，与 reject 的顺序与组数相同；当前参数的账户失败同样如此', async () => {
    const { runtime, computed } = fakeRuntime()
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, runtime)
    hasher.observe(['m=8192,t=1,p=1'])
    expect(await hasher.verify(await storedHash(8_192, 1), 'wrong')).toBe(false)
    expect(computed).toEqual([C, 'm=8192,t=1,p=1（比对）'])
    const stale = groupsOf(computed)
    computed.length = 0
    expect(await hasher.verify(await storedHash(8_192, 2), 'wrong')).toBe(false)
    expect(computed).toEqual([`${C}（比对）`, 'm=8192,t=1,p=1'])
    expect(groupsOf(computed)).toEqual(stale)
    expect(await rejected(hasher, computed)).toEqual(stale)
  })

  it('参数调低之后（库里现存更慢的一组）：用户名不存在也把它算一次；认不出的参数段忽略，重复的只算一组', async () => {
    const { runtime, computed } = fakeRuntime()
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, runtime)
    hasher.observe(['m=16384,t=4,p=1', 'not-parameters', 'm=x,t=9,p=1', '', 'm=16384,t=4,p=1'])
    expect(await rejected(hasher, computed)).toEqual([C, 'm=16384,t=4,p=1'])
    computed.length = 0
    expect(await hasher.verify(await storedHash(16_384, 4), 'wrong')).toBe(false)
    expect(computed).toEqual([C, 'm=16384,t=4,p=1（比对）'])
  })

  it('验证到没见过的参数组（例如读库里的参数失败了）：记下它，之后的失败与 reject 都把它算一次', async () => {
    const { runtime, computed } = fakeRuntime()
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, runtime)
    expect(await rejected(hasher, computed)).toEqual([C])
    computed.length = 0
    expect(await hasher.verify(await storedHash(8_192, 5), 'wrong')).toBe(false)
    expect(computed).toEqual([C, 'm=8192,t=5,p=1（比对）'])
    expect(await rejected(hasher, computed)).toEqual([C, 'm=8192,t=5,p=1'])
  })

  it('三组参数：当前参数在前、其余按键排序；任何一组的账户失败时，算的与 reject 完全相同（每组恰好一次）', async () => {
    const { runtime, computed } = fakeRuntime()
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, runtime)
    hasher.observe(['m=8192,t=5,p=1', 'm=16384,t=1,p=1'])
    const expected = await rejected(hasher, computed)
    expect(expected).toEqual([C, 'm=16384,t=1,p=1', 'm=8192,t=5,p=1'])
    for (const [memory, iterations] of [[8_192, 2], [16_384, 1], [8_192, 5]] as const) {
      computed.length = 0
      expect(await hasher.verify(await storedHash(memory, iterations), 'wrong')).toBe(false)
      expect(groupsOf(computed), `m=${memory},t=${iterations}`).toEqual(expected)
      expect(computed.filter(entry => entry.endsWith('（比对）'))).toEqual([`m=${memory},t=${iterations},p=1（比对）`])
    }
  })

  it('通过时到自己那组为止：当前参数的账户只比对一次；旧参数的账户先陪算排在它前面的各组', async () => {
    const { runtime, computed } = fakeRuntime(true)
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, runtime)
    hasher.observe(['m=8192,t=5,p=1', 'm=16384,t=1,p=1'])
    expect(await hasher.verify(await storedHash(8_192, 2), 'right')).toBe(true)
    expect(computed).toEqual([`${C}（比对）`])
    computed.length = 0
    expect(await hasher.verify(await storedHash(16_384, 1), 'right')).toBe(true)
    expect(computed).toEqual([C, 'm=16384,t=1,p=1（比对）'])
  })

  it('reject 与验证一样受并发上限与排队上限的约束（复验 R3）：前一个计算没完不开始，排队满了立即繁忙', async () => {
    let release: () => void = () => {}
    const order: string[] = []
    const hasher = new Argon2PasswordHasher(CURRENT, 1, { maxWaiting: 1 }, {
      hash: vi.fn(async (password: string | Uint8Array, _options?: Options | null) => {
        order.push(`${String(password)}:start`)
        if (password === 'first') {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        order.push(`${String(password)}:end`)
        return 'hashed'
      }),
      verify: vi.fn(async () => false),
    })
    const first = hasher.hash('first')
    const rejected = hasher.reject('second')
    await expect(hasher.reject('third')).rejects.toBeInstanceOf(PasswordHashingBusyError)
    await vi.waitFor(() => expect(order).toEqual(['first:start']))
    release()
    await first
    expect(await rejected).toBe(false)
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('各组在同一个名额里算完：并发上限为 1 时，失败的验证算完之前别的计算不开始', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const { runtime } = fakeRuntime()
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, {
      ...runtime,
      hash: vi.fn(async (_password: string | Uint8Array, options?: Options | null) => {
        const label = options?.timeCost === 5 ? 'other' : 'next'
        order.push(`${label}:start`)
        if (label === 'other') {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        order.push(`${label}:end`)
        return 'hashed'
      }),
    })
    hasher.observe(['m=8192,t=5,p=1'])
    const failing = hasher.verify(await storedHash(8_192, 2), 'wrong')
    const next = hasher.hash('next')
    await vi.waitFor(() => expect(order).toEqual(['other:start']))
    release()
    expect(await failing).toBe(false)
    await next
    expect(order).toEqual(['other:start', 'other:end', 'next:start', 'next:end'])
  })
})
