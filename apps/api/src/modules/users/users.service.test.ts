import type { User } from './user.ts'
import type { UserCredentials, UsersRepository } from './users.repository.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { PasswordHasher, PasswordHashingBusyError } from './password-hasher.ts'
import { UsersService } from './users.service.ts'

/** 假的哈希：hash(p) = "hash:p"，记下每次验证用的哈希与交给它的现存参数。 */
class FakeHasher extends PasswordHasher {
  readonly verified: string[] = []
  readonly observed: (readonly string[])[] = []
  hashes = 0
  stale = false
  /** observe 失败的次数（例如校准时等待哈希的请求太多） */
  observeFailures = 0

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

  async observe(parameterSegments: readonly string[]): Promise<void> {
    if (this.observeFailures > 0) {
      this.observeFailures -= 1
      throw new Error('等待密码哈希的请求太多')
    }
    this.observed.push(parameterSegments)
  }
}

const ALICE: User = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: 'Alice', systemRole: 'member', status: 'active' }

/** 库里现存哈希的参数段 */
const STORED_PARAMETERS = ['m=19456,t=2,p=1', 'm=12288,t=3,p=1']

function setup(credentials?: UserCredentials) {
  const repository = {
    findCredentialsByUsername: vi.fn(async (_username: string) => credentials),
    replacePasswordHash: vi.fn(async (_id: string, _expectedVersion: number, _next: string) => {}),
    findById: vi.fn(async (_id: string) => credentials?.user),
    passwordHashParameters: vi.fn(async () => STORED_PARAMETERS),
  }
  const hasher = new FakeHasher()
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  const warn = vi.spyOn(AppLogger.prototype, 'warn')
  return { repository, hasher, warn, service: new UsersService(repository as unknown as UsersRepository, hasher, logger) }
}

describe('UsersService.verifyCredentials', () => {
  it('用户名不区分大小写，密码正确时通过', async () => {
    const { service, repository } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    expect(await service.verifyCredentials('  Alice ', 'secret')).toEqual({ valid: true, credentials: { user: ALICE, passwordVersion: 1 } })
    expect(repository.findCredentialsByUsername).toHaveBeenCalledWith('alice')
  })

  it('密码错误：不通过，带上账户（审计的对象）', async () => {
    const { service } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    expect(await service.verifyCredentials('alice', 'wrong')).toEqual({ valid: false, user: ALICE })
  })

  it('停用的账户：密码对也不通过；对假哈希验证，密码对不对耗时都一样（审查 A8）', async () => {
    const disabled = { ...ALICE, status: 'disabled' as const }
    const { service, hasher } = setup({ user: disabled, passwordHash: 'hash:secret', passwordVersion: 1 })
    expect(await service.verifyCredentials('alice', 'secret')).toEqual({ valid: false, user: disabled })
    expect(await service.verifyCredentials('alice', 'wrong')).toEqual({ valid: false, user: disabled })
    expect(hasher.verified).toHaveLength(2)
    expect(hasher.verified).not.toContain('hash:secret')
  })

  it('用户名不存在：不通过，仍然算一次哈希；假哈希只生成一次', async () => {
    const { service, hasher } = setup(undefined)
    expect(await service.verifyCredentials('nobody', 'secret')).toEqual({ valid: false })
    expect(await service.verifyCredentials('nobody', 'secret')).toEqual({ valid: false })
    expect(hasher.verified).toHaveLength(2)
    expect(hasher.hashes).toBe(1)
  })

  it('假哈希在模块初始化时就生成：第一个不存在的用户名也只算一次验证，不多算一次哈希', async () => {
    const { service, hasher } = setup(undefined)
    await service.onModuleInit()
    expect(hasher.hashes).toBe(1)
    await service.verifyCredentials('nobody', 'secret')
    expect(hasher.hashes).toBe(1)
    expect(hasher.verified).toHaveLength(1)
  })

  it('假哈希生成失败（例如等待哈希的请求太多）：不缓存失败，下次重新生成', async () => {
    const { service, hasher } = setup(undefined)
    const hash = vi.spyOn(hasher, 'hash').mockRejectedValueOnce(new Error('等待哈希的请求太多'))
    await expect(service.verifyCredentials('nobody', 'secret')).rejects.toThrow('等待哈希的请求太多')
    expect(await service.verifyCredentials('nobody', 'secret')).toEqual({ valid: false })
    expect(await service.verifyCredentials('nobody', 'secret')).toEqual({ valid: false })
    expect(hash).toHaveBeenCalledTimes(2)
  })

  it('用户名的写法不合法：不查库，同样算一次哈希', async () => {
    const { service, repository, hasher } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    expect(await service.verifyCredentials('a b', 'secret')).toEqual({ valid: false })
    expect(repository.findCredentialsByUsername).not.toHaveBeenCalled()
    expect(hasher.verified).toHaveLength(1)
  })

  it('哈希的参数过时：验证通过后按当前参数重新编码，只在凭据的版本还是验证时的那个时才换（审查 A3）；版本不变，凭据照旧带它', async () => {
    const { service, repository, hasher } = setup({ user: ALICE, passwordHash: 'old:secret', passwordVersion: 3 })
    vi.spyOn(hasher, 'verify').mockResolvedValue(true)
    hasher.stale = true
    expect(await service.verifyCredentials('alice', 'secret')).toEqual({ valid: true, credentials: { user: ALICE, passwordVersion: 3 } })
    expect(repository.replacePasswordHash).toHaveBeenCalledWith(ALICE.id, 3, 'hash:secret')
  })

  it('重新哈希算不了（例如等待哈希的请求太多）：这次不换，只记警告，这次登录照常（复验 X1）', async () => {
    const { service, repository, hasher, warn } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    hasher.stale = true
    vi.spyOn(hasher, 'hash').mockRejectedValueOnce(new PasswordHashingBusyError(3))
    expect(await service.verifyCredentials('alice', 'secret')).toEqual({ valid: true, credentials: { user: ALICE, passwordVersion: 1 } })
    expect(repository.replacePasswordHash).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('重新哈希'), expect.objectContaining({ userId: ALICE.id }))
  })

  it('重新哈希的更新失败只记警告，不影响这次登录', async () => {
    const { service, repository, hasher, warn } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    hasher.stale = true
    repository.replacePasswordHash.mockRejectedValueOnce(new Error('数据库不可用'))
    expect(await service.verifyCredentials('alice', 'secret')).toEqual({ valid: true, credentials: { user: ALICE, passwordVersion: 1 } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('重新哈希'), expect.objectContaining({ userId: ALICE.id }))
  })

  it('密码错误时不重新哈希', async () => {
    const { service, repository, hasher } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    hasher.stale = true
    await service.verifyCredentials('alice', 'wrong')
    expect(repository.replacePasswordHash).not.toHaveBeenCalled()
  })
})

describe('库里现存哈希的参数（Codex 评审 CX4）', () => {
  it('模块初始化时读出，交给哈希器；不等它读完', async () => {
    const { service, repository, hasher } = setup(undefined)
    let finish: (segments: string[]) => void = () => {}
    repository.passwordHashParameters.mockReturnValueOnce(new Promise((resolve) => {
      finish = resolve
    }))
    await service.onModuleInit()
    expect(repository.passwordHashParameters).toHaveBeenCalledTimes(1)
    expect(hasher.observed).toEqual([])
    finish(STORED_PARAMETERS)
    await vi.waitFor(() => expect(hasher.observed).toEqual([STORED_PARAMETERS]))
  })

  it('验证之前先交给哈希器（第一次验证时还没读完就等它）；读过一次之后不再读', async () => {
    const { service, repository, hasher } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    const verify = vi.spyOn(hasher, 'verify')
    await service.verifyCredentials('alice', 'wrong')
    expect(hasher.observed).toEqual([STORED_PARAMETERS])
    expect(verify).toHaveBeenCalledTimes(1)
    await service.verifyCredentials('nobody', 'wrong')
    await service.verifyCredentials('alice', 'secret')
    expect(repository.passwordHashParameters).toHaveBeenCalledTimes(1)
  })

  it('读不出来：只记警告，启动与这次验证照常；下次验证时再读', async () => {
    const { service, repository, hasher, warn } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    repository.passwordHashParameters.mockRejectedValueOnce(new Error('数据库不可用')).mockRejectedValueOnce(new Error('数据库不可用'))
    await service.onModuleInit()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('现存密码哈希的参数'), expect.anything()))
    expect(await service.verifyCredentials('alice', 'secret')).toMatchObject({ valid: true })
    expect(hasher.observed).toEqual([])
    expect(await service.verifyCredentials('alice', 'wrong')).toMatchObject({ valid: false })
    expect(hasher.observed).toEqual([STORED_PARAMETERS])
    expect(repository.passwordHashParameters).toHaveBeenCalledTimes(3)
  })

  it('校准失败（等待哈希的请求太多）：同样只记警告，这次验证照常，下次验证时再做（独立复验 N2）', async () => {
    const { service, repository, hasher, warn } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    hasher.observeFailures = 1
    expect(await service.verifyCredentials('alice', 'wrong')).toMatchObject({ valid: false })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('现存密码哈希的参数'), expect.anything())
    expect(hasher.observed).toEqual([])
    expect(await service.verifyCredentials('alice', 'secret')).toMatchObject({ valid: true })
    expect(hasher.observed).toEqual([STORED_PARAMETERS])
    expect(repository.passwordHashParameters).toHaveBeenCalledTimes(2)
  })
})

describe('UsersService.findActiveById', () => {
  it('只返回状态为 active 的账户', async () => {
    expect(await setup({ user: ALICE, passwordHash: 'x', passwordVersion: 1 }).service.findActiveById(ALICE.id)).toEqual(ALICE)
    expect(await setup(undefined).service.findActiveById(ALICE.id)).toBeUndefined()
  })
})
