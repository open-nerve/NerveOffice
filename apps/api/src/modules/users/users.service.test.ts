import type { Options } from '@node-rs/argon2'
import type { Transaction, TransactionRunner } from '../database/index.ts'
import type { User } from './user.ts'
import type { UserCredentials, UsersRepository } from './users.repository.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { hash } from '@node-rs/argon2'
import { describe, expect, it, vi } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { Argon2PasswordHasher, PasswordHasher, PasswordHashingBusyError } from './password-hasher.ts'
import { UsersService } from './users.service.ts'

/** 假的哈希：hash(p) = "hash:p"，记下每次验证用的哈希、reject 的次数与交给它的现存参数。 */
class FakeHasher extends PasswordHasher {
  readonly verified: string[] = []
  readonly observed: (readonly string[])[] = []
  /** 按先后记下 observe、verify、reject */
  readonly events: string[] = []
  hashes = 0
  /** reject 的次数（没有可以比对的哈希：用户名不存在、账户已停用） */
  rejected = 0
  stale = false

  async hash(password: string): Promise<string> {
    this.hashes += 1
    return `hash:${password}`
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    this.events.push('verify')
    this.verified.push(passwordHash)
    return passwordHash === `hash:${password}`
  }

  async reject(): Promise<false> {
    this.events.push('reject')
    this.rejected += 1
    return false
  }

  needsRehash(): boolean {
    return this.stale
  }

  observe(parameterSegments: readonly string[]): void {
    this.events.push('observe')
    this.observed.push(parameterSegments)
  }
}

/** 假的事务运行器：只读快照直接执行（这里的用例都不经它） */
const TRANSACTIONS = { readSnapshot: vi.fn(async <T>(work: (transaction: Transaction) => Promise<T>) => work({} as Transaction)) } as unknown as TransactionRunner

const ALICE: User = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: 'Alice', systemRole: 'member', status: 'active' }

/** 库里现存哈希的参数段 */
const STORED_PARAMETERS = ['m=19456,t=2,p=1', 'm=12288,t=3,p=1']

function setup(credentials?: UserCredentials) {
  const repository = {
    findCredentialsByUsername: vi.fn(async (_username: string) => credentials),
    reencodePassword: vi.fn(async (_id: string, _expectedVersion: number, _next: string) => {}),
    findById: vi.fn(async (_id: string) => credentials?.user),
    passwordHashParameters: vi.fn(async () => STORED_PARAMETERS),
  }
  const hasher = new FakeHasher()
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  const warn = vi.spyOn(AppLogger.prototype, 'warn')
  return { repository, hasher, warn, service: new UsersService(repository as unknown as UsersRepository, hasher, TRANSACTIONS, logger) }
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

  it('停用的账户：密码对也不通过；按没有账户的做法计算（reject），不比对它的哈希，密码对不对都一样（审查 A8）', async () => {
    const disabled = { ...ALICE, status: 'disabled' as const }
    const { service, hasher } = setup({ user: disabled, passwordHash: 'hash:secret', passwordVersion: 1 })
    expect(await service.verifyCredentials('alice', 'secret')).toEqual({ valid: false, user: disabled })
    expect(await service.verifyCredentials('alice', 'wrong')).toEqual({ valid: false, user: disabled })
    expect(hasher.rejected).toBe(2)
    expect(hasher.verified).toEqual([])
  })

  it('用户名不存在：不通过，按没有账户的做法计算（reject，与密码错误的计算相同）；不另外生成假哈希', async () => {
    const { service, hasher } = setup(undefined)
    expect(await service.verifyCredentials('nobody', 'secret')).toEqual({ valid: false })
    expect(await service.verifyCredentials('nobody', 'secret')).toEqual({ valid: false })
    expect(hasher.rejected).toBe(2)
    expect(hasher.verified).toEqual([])
    expect(hasher.hashes).toBe(0)
  })

  it('模块初始化不算哈希（原来要先生成假哈希，P3 审查 A13；现在不存在的用户名由 reject 直接计算）', () => {
    const { service, hasher } = setup(undefined)
    service.onModuleInit()
    expect(hasher.hashes).toBe(0)
    expect(hasher.rejected).toBe(0)
  })

  it('reject 时等待哈希的请求太多：照样抛出（调用方按服务繁忙处理、退回名额），下次照常', async () => {
    const { service, hasher } = setup(undefined)
    vi.spyOn(hasher, 'reject').mockRejectedValueOnce(new PasswordHashingBusyError(3))
    await expect(service.verifyCredentials('nobody', 'secret')).rejects.toBeInstanceOf(PasswordHashingBusyError)
    expect(await service.verifyCredentials('nobody', 'secret')).toEqual({ valid: false })
  })

  it('用户名的写法不合法：不查库，同样按没有账户的做法计算', async () => {
    const { service, repository, hasher } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    expect(await service.verifyCredentials('a b', 'secret')).toEqual({ valid: false })
    expect(repository.findCredentialsByUsername).not.toHaveBeenCalled()
    expect(hasher.rejected).toBe(1)
  })

  it('哈希的参数过时：验证通过后按当前参数重新编码，只在凭据的版本还是验证时的那个时才换（审查 A3）；版本不变，凭据照旧带它', async () => {
    const { service, repository, hasher } = setup({ user: ALICE, passwordHash: 'old:secret', passwordVersion: 3 })
    vi.spyOn(hasher, 'verify').mockResolvedValue(true)
    hasher.stale = true
    expect(await service.verifyCredentials('alice', 'secret')).toEqual({ valid: true, credentials: { user: ALICE, passwordVersion: 3 } })
    expect(repository.reencodePassword).toHaveBeenCalledWith(ALICE.id, 3, 'hash:secret')
  })

  it('重新哈希算不了（例如等待哈希的请求太多）：这次不换，只记警告，这次登录照常（复验 X1）', async () => {
    const { service, repository, hasher, warn } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    hasher.stale = true
    vi.spyOn(hasher, 'hash').mockRejectedValueOnce(new PasswordHashingBusyError(3))
    expect(await service.verifyCredentials('alice', 'secret')).toEqual({ valid: true, credentials: { user: ALICE, passwordVersion: 1 } })
    expect(repository.reencodePassword).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('重新哈希'), expect.objectContaining({ userId: ALICE.id }))
  })

  it('重新哈希的更新失败只记警告，不影响这次登录', async () => {
    const { service, repository, hasher, warn } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    hasher.stale = true
    repository.reencodePassword.mockRejectedValueOnce(new Error('数据库不可用'))
    expect(await service.verifyCredentials('alice', 'secret')).toEqual({ valid: true, credentials: { user: ALICE, passwordVersion: 1 } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('重新哈希'), expect.objectContaining({ userId: ALICE.id }))
  })

  it('密码错误时不重新哈希', async () => {
    const { service, repository, hasher } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    hasher.stale = true
    await service.verifyCredentials('alice', 'wrong')
    expect(repository.reencodePassword).not.toHaveBeenCalled()
  })

  it.each([
    ['密码错误', { user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 }, 'alice'],
    ['账户已停用', { user: { ...ALICE, status: 'disabled' as const }, passwordHash: 'hash:secret', passwordVersion: 1 }, 'alice'],
    ['用户名不存在', undefined, 'nobody'],
  ] as const)('%s：比对之后不再访问数据库——调用方据此把这里抛出的数据库繁忙当作"还没有比对"、退回名额（M2-P6 第 3 片复验）', async (_name, credentials, username) => {
    const { service, repository, hasher } = setup(credentials)
    hasher.stale = true
    const accesses = (): number => Object.values(repository).reduce((total, method) => total + method.mock.calls.length, 0)
    const compare = hasher.verify.bind(hasher)
    let accessesWhenCompared: number | undefined
    vi.spyOn(hasher, 'verify').mockImplementation(async (passwordHash, password) => {
      accessesWhenCompared = accesses()
      return compare(passwordHash, password)
    })
    vi.spyOn(hasher, 'reject').mockImplementation(async () => {
      accessesWhenCompared = accesses()
      return false
    })
    expect(await service.verifyCredentials(username, 'wrong')).toMatchObject({ valid: false })
    expect(accessesWhenCompared).toBeGreaterThan(0)
    expect(accesses()).toBe(accessesWhenCompared)
  })
})

describe('库里现存哈希的参数（Codex 评审 CX4）', () => {
  it('模块初始化时读出，交给哈希器；不等它读完', async () => {
    const { service, repository, hasher } = setup(undefined)
    let finish: (segments: string[]) => void = () => {}
    repository.passwordHashParameters.mockReturnValueOnce(new Promise((resolve) => {
      finish = resolve
    }))
    service.onModuleInit()
    expect(repository.passwordHashParameters).toHaveBeenCalledTimes(1)
    expect(hasher.observed).toEqual([])
    finish(STORED_PARAMETERS)
    await vi.waitFor(() => expect(hasher.observed).toEqual([STORED_PARAMETERS]))
  })

  it('第一次验证时库里的参数还没读完：等它读完、交给哈希器之后才计算（复验 R5：不等的话，刚启动时不存在的用户名少算库里的参数组）', async () => {
    const { service, repository, hasher } = setup(undefined)
    let finish: (segments: string[]) => void = () => {}
    repository.passwordHashParameters.mockReturnValueOnce(new Promise((resolve) => {
      finish = resolve
    }))
    service.onModuleInit()
    const pending = service.verifyCredentials('nobody', 'secret')
    await delay(20)
    expect(hasher.events).toEqual([])
    finish(STORED_PARAMETERS)
    expect(await pending).toEqual({ valid: false })
    expect(hasher.events).toEqual(['observe', 'reject'])
  })

  it('验证之前先交给哈希器；读过一次之后不再读', async () => {
    const { service, repository, hasher } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    const verify = vi.spyOn(hasher, 'verify')
    await service.verifyCredentials('alice', 'wrong')
    expect(hasher.observed).toEqual([STORED_PARAMETERS])
    expect(verify).toHaveBeenCalledTimes(1)
    await service.verifyCredentials('nobody', 'wrong')
    await service.verifyCredentials('alice', 'secret')
    expect(repository.passwordHashParameters).toHaveBeenCalledTimes(1)
  })

  it('启动时读不出来：只记警告，启动照常（不抛出）；第一次验证时再读', async () => {
    const { service, repository, hasher, warn } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    repository.passwordHashParameters.mockRejectedValueOnce(new Error('数据库不可用'))
    service.onModuleInit()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('现存密码哈希的参数'), expect.anything()))
    expect(await service.verifyCredentials('alice', 'secret')).toMatchObject({ valid: true })
    expect(hasher.observed).toEqual([STORED_PARAMETERS])
    expect(repository.passwordHashParameters).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['登录（verifyCredentials）', async (service: UsersService) => service.verifyCredentials('alice', 'secret')],
    ['修改密码时验证旧密码（verifyPasswordOf）', async (service: UsersService) => service.verifyPasswordOf(ALICE.id, 'secret')],
  ])('%s：参数组读不出来时这次验证照样抛出，哈希器一次也没被调用、凭据也不读（M2 Codex 评审 CX2）；下次再读，读成功之后缓存', async (_name, verify) => {
    const { service, repository, hasher } = setup({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 })
    const findCredentialsById = vi.fn(async (_id: string): Promise<UserCredentials> => ({ user: ALICE, passwordHash: 'hash:secret', passwordVersion: 1 }))
    Object.assign(repository, { findCredentialsById })
    const unavailable = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014', severity: 'ERROR' })
    repository.passwordHashParameters.mockRejectedValueOnce(unavailable)
    await expect(verify(service)).rejects.toBe(unavailable)
    expect(hasher.events).toEqual([])
    expect(hasher.hashes).toBe(0)
    expect(repository.findCredentialsByUsername).not.toHaveBeenCalled()
    expect(findCredentialsById).not.toHaveBeenCalled()

    expect(await verify(service)).toBeTruthy()
    expect(hasher.events).toEqual(['observe', 'verify'])
    await verify(service)
    expect(repository.passwordHashParameters).toHaveBeenCalledTimes(2)
  })

  it('正在读时并发的几次验证等同一次读取：读失败时一起失败，都没有计算', async () => {
    const { service, repository, hasher } = setup(undefined)
    let fail: (error: Error) => void = () => {}
    repository.passwordHashParameters.mockReturnValueOnce(new Promise((_resolve, reject) => {
      fail = reject
    }))
    const first = service.verifyCredentials('nobody', 'secret')
    const second = service.verifyCredentials('nobody', 'secret')
    await delay(20)
    fail(new Error('数据库不可用'))
    await expect(first).rejects.toThrow('数据库不可用')
    await expect(second).rejects.toThrow('数据库不可用')
    expect(repository.passwordHashParameters).toHaveBeenCalledTimes(1)
    expect(hasher.events).toEqual([])
  })
})

/**
 * 参数组读不出来时不进入密码验证（M2 Codex 评审 CX2，ADR-007）：用真实的哈希器（Argon2PasswordHasher），把库函数换成只记下
 * 算的是哪组参数的假实现（与 password-hasher.test.ts 相同），核对的是计算本身，不比耗时。
 * 原来读失败被吞掉、照常验证：不存在的用户名只算当前参数，旧参数的账户另比对自己那组，两条路径算的组不同（Codex 的探针复现）
 */
describe('参数组读不出来时不进入验证，恢复之后两条路径算的组相同（M2 Codex 评审 CX2）', () => {
  /** 当前参数与库里一个旧参数账户的参数（与 Codex 的探针相同） */
  const CURRENT = { memoryKib: 19_456, iterations: 2, parallelism: 1 }
  const OLD = 'm=12288,t=3,p=1'

  function realHasher() {
    const computed: string[] = []
    const hasher = new Argon2PasswordHasher(CURRENT, 1, {}, {
      hash: vi.fn(async (_password: string | Uint8Array, options?: Options | null) => {
        computed.push(`m=${options?.memoryCost},t=${options?.timeCost},p=${options?.parallelism}`)
        return 'discarded'
      }),
      // 比对的是哪组：PHC 字符串的参数段；结果总是不通过（错误的密码）
      verify: vi.fn(async (passwordHash: string | Uint8Array) => {
        computed.push(String(passwordHash).split('$')[3] ?? '')
        return false
      }),
    })
    return { hasher, computed }
  }

  it('读失败：不存在与旧参数账户的这次验证都抛出、一组也没算；恢复之后先不存在、再旧参数账户、再不存在，算的组完全相同', async () => {
    // 真实的 PHC 字符串（哈希器先按它解析出账户自己那组参数）
    const veteran: UserCredentials = { user: ALICE, passwordHash: await hash('correct horse battery staple', { memoryCost: 12_288, timeCost: 3, parallelism: 1 }), passwordVersion: 1 }
    const { hasher, computed } = realHasher()
    const repository = {
      findCredentialsByUsername: vi.fn(async (username: string) => (username === 'alice' ? veteran : undefined)),
      passwordHashParameters: vi.fn(async () => [OLD, 'm=19456,t=2,p=1']),
    }
    const unavailable = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014', severity: 'ERROR' })
    repository.passwordHashParameters.mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unavailable)
    const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
    const service = new UsersService(repository as unknown as UsersRepository, hasher, TRANSACTIONS, logger)

    await expect(service.verifyCredentials('nobody', 'wrong long password')).rejects.toBe(unavailable)
    await expect(service.verifyCredentials('alice', 'wrong long password')).rejects.toBe(unavailable)
    expect(computed).toEqual([])
    expect(repository.findCredentialsByUsername).not.toHaveBeenCalled()

    const groups = async (username: string): Promise<string[]> => {
      computed.length = 0
      expect(await service.verifyCredentials(username, 'wrong long password')).toMatchObject({ valid: false })
      return [...computed].sort()
    }
    const missing = await groups('nobody')
    expect(missing).toEqual(['m=12288,t=3,p=1', 'm=19456,t=2,p=1'])
    expect(await groups('alice')).toEqual(missing)
    expect(await groups('nobody')).toEqual(missing)
  })
})

describe('UsersService.findActiveById', () => {
  it('只返回状态为 active 的账户', async () => {
    expect(await setup({ user: ALICE, passwordHash: 'x', passwordVersion: 1 }).service.findActiveById(ALICE.id)).toEqual(ALICE)
    expect(await setup(undefined).service.findActiveById(ALICE.id)).toBeUndefined()
  })
})
