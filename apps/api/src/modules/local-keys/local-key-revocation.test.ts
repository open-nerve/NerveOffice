// 吊销的入口（M3-P6 设计 §3.5）：标记、擦掉密钥材料、插下一版（用现在的主密钥包装）；没有当前的时什么也不写。
// 下一版的生成时刻（上一版被吊销的那一刻，仓储在 SQL 里取）、锁的顺序（admin 先锁账户行）、两个并发的吊销、吊销与取用的交错、
// 会话时区不是 UTC 时的时间线与审计由集成测试覆盖（local-keys.test.ts、local-key-races.test.ts）
import type * as Keyring from './master-keyring.ts'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { LocalKeyRevocation } from './local-key-revocation.ts'
import { FakeLocalKeysRepository, isZeroed, keyring, TRANSACTION } from './local-keys.test-support.ts'
import { generateLocalKey } from './master-keyring.ts'

// 生成的下一版用完清零（审查 A2）只能从同一个 Buffer 上看出来：包住 generateLocalKey（默认照常生成），要看的用例经 nextGenerated 给出那一把
vi.mock('./master-keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof Keyring>()
  return { ...actual, generateLocalKey: vi.fn(actual.generateLocalKey) }
})

/** 下一次生成的原始密钥由测试给出：返回吊销拿到的那个 Buffer 与清零之前的字节 */
function nextGenerated(): { readonly key: Buffer, readonly bytes: Buffer } {
  const key = randomBytes(32)
  const bytes = Buffer.from(key)
  vi.mocked(generateLocalKey).mockImplementationOnce(() => key)
  return { key, bytes }
}

const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'

function setup() {
  const ring = keyring()
  const repository = new FakeLocalKeysRepository()
  return { ring, repository, revocation: new LocalKeyRevocation(repository.asRepository(), ring) }
}

describe('LocalKeyRevocation', () => {
  it('有当前的一把：先吊销它（记下时刻、擦掉密钥材料），再插下一版——用现在的主密钥包装、绑定这个人与新的版本，与原来的不是同一把；时刻不经这里（仓储在 SQL 里取上一版被吊销的时刻，复验 C2）', async () => {
    const { ring, repository, revocation } = setup()
    const original = randomBytes(32)
    repository.seedCurrent(ring, AMY, 1, original)
    expect(await revocation.revoke(AMY, TRANSACTION)).toEqual({ revokedVersion: 1, currentVersion: 2 })
    expect(repository.calls).toEqual(['revokeCurrent', 'insertNext'])
    expect(repository.revokeCurrent).toHaveBeenCalledWith(AMY, TRANSACTION)
    const [first, second] = repository.rows
    expect(first).toMatchObject({ version: 1, material: null, revokedAt: repository.revokedAt })
    expect(second).toMatchObject({ userId: AMY, version: 2, revokedAt: null })
    // 插下一版只给这个人、新的版本、包装结果与事务：生成时刻由仓储在同一个事务里从上一版取（时刻不在仓储与服务之间传）
    expect(repository.insertNext).toHaveBeenCalledWith(AMY, 2, second?.material, TRANSACTION)
    const material = second?.material
    if (material === undefined || material === null)
      throw new Error('第 2 版没有密钥材料')
    expect(material.masterKeyId.toString('hex')).toBe(ring.currentMasterKeyId)
    const next = ring.unwrap(material, { userId: AMY, version: 2 })
    expect(next).toHaveLength(32)
    expect(next.equals(original)).toBe(false)
  })

  it('再吊销一次：吊销第 2 版、插第 3 版；版本从 1 起连续，任何时刻至多一把当前的', async () => {
    const { ring, repository, revocation } = setup()
    repository.seedCurrent(ring, AMY, 1, randomBytes(32))
    await revocation.revoke(AMY, TRANSACTION)
    expect(await revocation.revoke(AMY, TRANSACTION)).toEqual({ revokedVersion: 2, currentVersion: 3 })
    expect(repository.rows.map(row => [row.version, row.revokedAt === null, row.material === null])).toEqual([[1, false, true], [2, false, true], [3, true, false]])
  })

  it('没有当前的一把（从没取过）：返回 undefined，什么也不插；别人的不受影响', async () => {
    const { ring, repository, revocation } = setup()
    repository.seedCurrent(ring, BEN, 1, randomBytes(32))
    expect(await revocation.revoke(AMY, TRANSACTION)).toBeUndefined()
    expect(repository.calls).toEqual(['revokeCurrent'])
    expect(repository.rows).toHaveLength(1)
    expect(repository.rows[0]).toMatchObject({ userId: BEN, revokedAt: null })
  })

  it('插下一版失败（撞上约束）：错误照常抛出，由调用方的事务回滚', async () => {
    const { ring, repository, revocation } = setup()
    repository.seedCurrent(ring, AMY, 1, randomBytes(32))
    repository.insertNext.mockRejectedValueOnce(new Error('违反约束'))
    await expect(revocation.revoke(AMY, TRANSACTION)).rejects.toThrow('违反约束')
  })
})

describe('生成的下一版的原始密钥用完清零（M3-P6 设计 §3.3，审查 A2：下一版不交给任何人，包装之后 Buffer 不留着）', () => {
  it('成功：插进去之后全是 0；库里那一版解开是清零之前的字节', async () => {
    const { ring, repository, revocation } = setup()
    repository.seedCurrent(ring, AMY, 1, randomBytes(32))
    const { key, bytes } = nextGenerated()
    await revocation.revoke(AMY, TRANSACTION)
    expect(isZeroed(key)).toBe(true)
    const material = repository.rows[1]?.material
    if (material === undefined || material === null)
      throw new Error('第 2 版没有密钥材料')
    expect(ring.unwrap(material, { userId: AMY, version: 2 }).equals(bytes)).toBe(true)
  })

  it('插下一版失败：照样清零，错误照常抛出', async () => {
    const { ring, repository, revocation } = setup()
    repository.seedCurrent(ring, AMY, 1, randomBytes(32))
    const { key } = nextGenerated()
    repository.insertNext.mockRejectedValueOnce(new Error('违反约束'))
    await expect(revocation.revoke(AMY, TRANSACTION)).rejects.toThrow('违反约束')
    expect(isZeroed(key)).toBe(true)
  })

  it('包装抛错：照样清零，错误照常抛出，下一版没有插', async () => {
    const { ring, repository, revocation } = setup()
    repository.seedCurrent(ring, AMY, 1, randomBytes(32))
    const { key } = nextGenerated()
    vi.spyOn(ring, 'wrap').mockImplementationOnce(() => {
      throw new Error('包装失败')
    })
    await expect(revocation.revoke(AMY, TRANSACTION)).rejects.toThrow('包装失败')
    expect(isZeroed(key)).toBe(true)
    expect(repository.insertNext).not.toHaveBeenCalled()
  })
})
