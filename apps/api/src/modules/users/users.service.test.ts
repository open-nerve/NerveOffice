import type { User } from './user.ts'
import type { UserCredentials, UsersRepository } from './users.repository.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { PasswordHasher } from './password-hasher.ts'
import { UsersService } from './users.service.ts'

/** 假的哈希：hash(p) = "hash:p"，记下每次验证用的哈希。 */
class FakeHasher extends PasswordHasher {
  readonly verified: string[] = []
  hashes = 0
  stale = false

  async hash(password: string): Promise<string> {
    this.hashes += 1
    return `hash:${password}`
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    this.verified.push(passwordHash)
    return passwordHash === `hash:${password}`
  }

  needsRehash(): boolean {
    return this.stale
  }
}

const ALICE: User = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: 'Alice', systemRole: 'member', status: 'active' }

function setup(credentials?: UserCredentials) {
  const repository = {
    findCredentialsByUsername: vi.fn(async (_username: string) => credentials),
    updatePasswordHash: vi.fn(async (_id: string, _hash: string) => {}),
    findById: vi.fn(async (_id: string) => credentials?.user),
  }
  const hasher = new FakeHasher()
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  const warn = vi.spyOn(AppLogger.prototype, 'warn')
  return { repository, hasher, warn, service: new UsersService(repository as unknown as UsersRepository, hasher, logger) }
}

describe('UsersService.verifyCredentials', () => {
  it('用户名不区分大小写，密码正确时通过', async () => {
    const { service, repository } = setup({ user: ALICE, passwordHash: 'hash:secret' })
    expect(await service.verifyCredentials('  Alice ', 'secret')).toEqual({ valid: true, user: ALICE })
    expect(repository.findCredentialsByUsername).toHaveBeenCalledWith('alice')
  })

  it('密码错误：不通过，带上账户（审计的对象）', async () => {
    const { service } = setup({ user: ALICE, passwordHash: 'hash:secret' })
    expect(await service.verifyCredentials('alice', 'wrong')).toEqual({ valid: false, user: ALICE })
  })

  it('用户名不存在：不通过，仍然算一次哈希；假哈希只生成一次', async () => {
    const { service, hasher } = setup(undefined)
    expect(await service.verifyCredentials('nobody', 'secret')).toEqual({ valid: false })
    expect(await service.verifyCredentials('nobody', 'secret')).toEqual({ valid: false })
    expect(hasher.verified).toHaveLength(2)
    expect(hasher.hashes).toBe(1)
  })

  it('用户名的写法不合法：不查库，同样算一次哈希', async () => {
    const { service, repository, hasher } = setup({ user: ALICE, passwordHash: 'hash:secret' })
    expect(await service.verifyCredentials('a b', 'secret')).toEqual({ valid: false })
    expect(repository.findCredentialsByUsername).not.toHaveBeenCalled()
    expect(hasher.verified).toHaveLength(1)
  })

  it('哈希的参数过时：验证通过后用当前参数重新哈希', async () => {
    const { service, repository, hasher } = setup({ user: ALICE, passwordHash: 'hash:secret' })
    hasher.stale = true
    expect(await service.verifyCredentials('alice', 'secret')).toMatchObject({ valid: true })
    expect(repository.updatePasswordHash).toHaveBeenCalledWith(ALICE.id, 'hash:secret')
  })

  it('重新哈希失败只记警告，不影响这次登录', async () => {
    const { service, repository, hasher, warn } = setup({ user: ALICE, passwordHash: 'hash:secret' })
    hasher.stale = true
    repository.updatePasswordHash.mockRejectedValueOnce(new Error('数据库不可用'))
    expect(await service.verifyCredentials('alice', 'secret')).toMatchObject({ valid: true })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('重新哈希'), expect.objectContaining({ userId: ALICE.id }))
  })

  it('密码错误时不重新哈希', async () => {
    const { service, repository, hasher } = setup({ user: ALICE, passwordHash: 'hash:secret' })
    hasher.stale = true
    await service.verifyCredentials('alice', 'wrong')
    expect(repository.updatePasswordHash).not.toHaveBeenCalled()
  })
})

describe('UsersService.findActiveById', () => {
  it('只返回状态为 active 的账户', async () => {
    expect(await setup({ user: ALICE, passwordHash: 'x' }).service.findActiveById(ALICE.id)).toEqual(ALICE)
    expect(await setup(undefined).service.findActiveById(ALICE.id)).toBeUndefined()
  })
})
