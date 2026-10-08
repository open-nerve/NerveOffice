// 本人取当前的本机密钥（M3-P6 设计 §3.5）：一个写事务——第一条语句核对这次登录 → 读当前的 → 有就解包；没有就生成第 1 版插入，
// 插进去了交出刚生成的，没插进去（并发的另一次取用赢了）就再读一次。解不开时抛出、不自动重新生成。
// 仓储是假的（local-keys.test-support.ts），主密钥环是真的；库里的语句、并发与确定的交错由集成测试覆盖
import type { Principal } from '../auth/index.ts'
import type { Transaction } from '../database/index.ts'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { LocalKeyService } from './local-key.service.ts'
import { FakeLocalKeysRepository, keyring, TRANSACTION } from './local-keys.test-support.ts'
import { LocalKeyUnwrapError } from './master-keyring.ts'

const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const SESSION = '0199a2c4-0000-7000-8000-0000000000e1'
const PRINCIPAL = { user: { id: AMY, username: 'amy', displayName: '艾米', systemRole: 'member', status: 'active' }, sessionId: SESSION, csrfToken: 'csrf' } as Principal

function setup(options: { readonly sessionActive?: boolean, readonly repository?: FakeLocalKeysRepository } = {}) {
  const ring = keyring()
  const repository = options.repository ?? new FakeLocalKeysRepository()
  const calls = repository.calls
  const sessions = {
    requireActive: vi.fn(async (_sessionId: string, _transaction: Transaction) => {
      calls.push('requireActive')
      if (options.sessionActive === false)
        throw new AppError('SESSION_EXPIRED')
    }),
  }
  const transactions = {
    run: vi.fn(async <T>(work: (transaction: Transaction) => Promise<T>) => {
      calls.push('begin')
      try {
        const result = await work(TRANSACTION)
        calls.push('commit')
        return result
      }
      catch (error) {
        calls.push('rollback')
        throw error
      }
    }),
  }
  const service = new LocalKeyService(repository.asRepository(), ring, sessions as never, transactions as never)
  return { ring, repository, calls, sessions, service }
}

/** 库里当前的那一把用这个环解开（按用户与版本） */
function storedKeyOf(repository: FakeLocalKeysRepository, ring: ReturnType<typeof keyring>): string {
  const row = repository.rows.find(candidate => candidate.revokedAt === null)
  if (row === undefined || row.material === null)
    throw new Error('没有当前的一把')
  return ring.unwrap(row.material, { userId: row.userId, version: row.version }).toString('base64')
}

describe('LocalKeyService.fetch', () => {
  it('第一次取：在一个写事务里先核对这次登录，读不到当前的就生成第 1 版、包装之后插入，交出刚生成的；库里那一行解开就是它', async () => {
    const { ring, repository, calls, sessions, service } = setup()
    const fetched = await service.fetch(PRINCIPAL)
    expect(fetched.version).toBe(1)
    expect(Buffer.from(fetched.key, 'base64')).toHaveLength(32)
    expect(calls).toEqual(['begin', 'requireActive', 'findCurrent', 'insertFirst', 'commit'])
    expect(sessions.requireActive).toHaveBeenCalledWith(SESSION, TRANSACTION)
    expect(repository.findCurrent).toHaveBeenCalledWith(AMY, TRANSACTION)
    expect(repository.insertFirst.mock.calls[0]?.[2]).toBe(TRANSACTION)
    expect(storedKeyOf(repository, ring)).toBe(fetched.key)
    // 包装绑定这个人与第 1 版：换个人、换版本都解不开
    const material = repository.rows[0]?.material
    if (material === undefined || material === null)
      throw new Error('没有密钥材料')
    expect(() => ring.unwrap(material, { userId: '0199a2c4-0000-7000-8000-00000000000b', version: 1 })).toThrow(LocalKeyUnwrapError)
    expect(() => ring.unwrap(material, { userId: AMY, version: 2 })).toThrow(LocalKeyUnwrapError)
  })

  it('已有当前的一把：解开交出，不生成、不插入；再取还是同一把', async () => {
    const { ring, repository, calls, service } = setup()
    const raw = randomBytes(32)
    repository.seedCurrent(ring, AMY, 3, raw)
    expect(await service.fetch(PRINCIPAL)).toEqual({ version: 3, key: raw.toString('base64') })
    expect(await service.fetch(PRINCIPAL)).toEqual({ version: 3, key: raw.toString('base64') })
    expect(calls).toEqual(['begin', 'requireActive', 'findCurrent', 'commit', 'begin', 'requireActive', 'findCurrent', 'commit'])
    expect(repository.insertFirst).not.toHaveBeenCalled()
  })

  it('并发的另一次取用先插了第 1 版（这次没插进去）：再读一次，交出赢的那一把，而不是自己生成的', async () => {
    const { ring, repository, calls, service } = setup()
    const winner = randomBytes(32)
    // 这次读的时候还没有；插入之前别的请求插了第 1 版并提交
    repository.insertFirst.mockImplementationOnce(async (userId: string) => {
      calls.push('insertFirst')
      repository.seedCurrent(ring, userId, 1, winner)
      return false
    })
    expect(await service.fetch(PRINCIPAL)).toEqual({ version: 1, key: winner.toString('base64') })
    expect(calls).toEqual(['begin', 'requireActive', 'findCurrent', 'insertFirst', 'findCurrent', 'commit'])
    expect(repository.rows).toHaveLength(1)
  })

  it('这次登录在事务里核对时已经失效：401 SESSION_EXPIRED，不读也不写（守卫之后、事务之前撤销的情形）', async () => {
    const { repository, calls, service } = setup({ sessionActive: false })
    const failure = await service.fetch(PRINCIPAL).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AppError)
    expect((failure as AppError).code).toBe('SESSION_EXPIRED')
    expect(calls).toEqual(['begin', 'requireActive', 'rollback'])
    expect(repository.rows).toEqual([])
  })

  it('当前的一把是别的主密钥包装的、或者包装结果对不上：抛 LocalKeyUnwrapError（意外错误，500），不自动重新生成', async () => {
    const lost = setup()
    lost.repository.seedCurrent(keyring(), AMY, 2, randomBytes(32))
    const unknown = await lost.service.fetch(PRINCIPAL).catch((error: unknown) => error)
    expect(unknown).toBeInstanceOf(LocalKeyUnwrapError)
    expect(unknown).toMatchObject({ reason: 'unknown_master_key', userId: AMY, version: 2 })
    expect(lost.repository.insertFirst).not.toHaveBeenCalled()
    expect(lost.calls.at(-1)).toBe('rollback')

    const tampered = setup()
    tampered.repository.seedCurrent(tampered.ring, AMY, 1, randomBytes(32))
    const material = tampered.repository.rows[0]?.material
    if (material === undefined || material === null)
      throw new Error('没有密钥材料')
    material.wrappedKey[50] = (material.wrappedKey[50] ?? 0) ^ 0x01
    expect(await tampered.service.fetch(PRINCIPAL).catch((error: unknown) => error)).toMatchObject({ reason: 'not_authentic', version: 1 })
    expect(tampered.repository.rows).toHaveLength(1)
  })

  it('第 1 版没插进去、却也读不到当前的（这个人只有吊销了的，违反不变量 I20）：报错，不交出任何密钥', async () => {
    const repository = new FakeLocalKeysRepository()
    repository.rows.push({ userId: AMY, version: 1, material: null, createdAt: repository.now, revokedAt: repository.now })
    const { service, calls } = setup({ repository })
    await expect(service.fetch(PRINCIPAL)).rejects.toThrow('第 1 版没插进去，却也读不到当前的本机密钥')
    expect(calls).toEqual(['begin', 'requireActive', 'findCurrent', 'insertFirst', 'findCurrent', 'rollback'])
  })

  it('只按调用者自己的 id 取：会话守卫给出的账户', async () => {
    const { repository, service } = setup()
    await service.fetch(PRINCIPAL)
    expect(repository.findCurrent.mock.calls.map(([userId]) => userId)).toEqual([AMY])
    expect(repository.insertFirst.mock.calls.map(([userId]) => userId)).toEqual([AMY])
  })
})
