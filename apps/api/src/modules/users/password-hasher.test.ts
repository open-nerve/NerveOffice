import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Argon2PasswordHasher } from './password-hasher.ts'

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
})
