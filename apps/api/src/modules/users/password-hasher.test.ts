import { describe, expect, it } from 'vitest'
import { Argon2PasswordHasher } from './password-hasher.ts'

const PARAMETERS = { memoryKib: 8_192, iterations: 1, parallelism: 1 }

describe('Argon2PasswordHasher', () => {
  const hasher = new Argon2PasswordHasher(PARAMETERS)

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
    expect(new Argon2PasswordHasher({ ...PARAMETERS, memoryKib: 9_216 }).needsRehash(passwordHash)).toBe(true)
    expect(new Argon2PasswordHasher({ ...PARAMETERS, iterations: 2 }).needsRehash(passwordHash)).toBe(true)
    expect(new Argon2PasswordHasher({ ...PARAMETERS, parallelism: 2 }).needsRehash(passwordHash)).toBe(true)
  })
})
