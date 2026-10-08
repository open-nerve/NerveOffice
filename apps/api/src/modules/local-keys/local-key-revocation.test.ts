// 吊销的入口（M3-P6 设计 §3.5）：标记、擦掉密钥材料、插下一版（用现在的主密钥包装）；没有当前的时什么也不写。
// 锁的顺序（admin 先锁账户行）、两个并发的吊销与审计由集成测试覆盖（local-keys.test.ts、local-key-locks.test.ts）
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LocalKeyRevocation } from './local-key-revocation.ts'
import { FakeLocalKeysRepository, keyring, TRANSACTION } from './local-keys.test-support.ts'

const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'

function setup() {
  const ring = keyring()
  const repository = new FakeLocalKeysRepository()
  return { ring, repository, revocation: new LocalKeyRevocation(repository.asRepository(), ring) }
}

describe('LocalKeyRevocation', () => {
  it('有当前的一把：先吊销它（记下时刻、擦掉密钥材料），再插下一版——用现在的主密钥包装、绑定这个人与新的版本，与原来的不是同一把', async () => {
    const { ring, repository, revocation } = setup()
    const original = randomBytes(32)
    repository.seedCurrent(ring, AMY, 1, original)
    expect(await revocation.revoke(AMY, TRANSACTION)).toEqual({ revokedVersion: 1, currentVersion: 2 })
    expect(repository.calls).toEqual(['revokeCurrent', 'insertNext'])
    expect(repository.revokeCurrent).toHaveBeenCalledWith(AMY, TRANSACTION)
    const [first, second] = repository.rows
    expect(first).toMatchObject({ version: 1, material: null, revokedAt: repository.now })
    expect(second).toMatchObject({ userId: AMY, version: 2, revokedAt: null })
    const material = second?.material
    if (material === undefined || material === null)
      throw new Error('第 2 版没有密钥材料')
    expect(material.masterKeyId.toString('hex')).toBe(ring.currentMasterKeyId)
    const next = ring.unwrap(material, { userId: AMY, version: 2 })
    expect(next).toHaveLength(32)
    expect(next.equals(original)).toBe(false)
    expect(repository.insertNext.mock.calls[0]?.[3]).toBe(TRANSACTION)
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
