// 版本与摘要的读取（M3-P6 设计 §3.5、§3.6）：不加锁、不解包、不带密钥材料，在调用方的事务或只读快照里读
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LocalKeyVersions } from './local-key-versions.ts'
import { FakeLocalKeysRepository, keyring, TRANSACTION } from './local-keys.test-support.ts'

const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'
const CAT = '0199a2c4-0000-7000-8000-00000000000c'

describe('LocalKeyVersions', () => {
  it('当前的版本：从没取过为 null；有的话是当前那一把的版本；按给出的事务读', async () => {
    const repository = new FakeLocalKeysRepository()
    const versions = new LocalKeyVersions(repository.asRepository())
    expect(await versions.currentVersionOf(AMY, TRANSACTION)).toBeNull()
    repository.seedCurrent(keyring(), AMY, 3, randomBytes(32))
    expect(await versions.currentVersionOf(AMY, TRANSACTION)).toBe(3)
    expect(repository.currentVersionOf).toHaveBeenLastCalledWith(AMY, TRANSACTION)
  })

  it('一批人的摘要（一次查询）：只有版本与生成的时刻，没有的人不在结果里', async () => {
    const repository = new FakeLocalKeysRepository()
    const ring = keyring()
    repository.seedCurrent(ring, AMY, 1, randomBytes(32))
    repository.seedCurrent(ring, BEN, 2, randomBytes(32))
    const states = await new LocalKeyVersions(repository.asRepository()).statesOf([AMY, BEN, CAT], TRANSACTION)
    expect([...states.entries()]).toEqual([[AMY, { version: 1, createdAt: repository.now }], [BEN, { version: 2, createdAt: repository.now }]])
    expect(repository.currentOf.mock.calls).toEqual([[[AMY, BEN, CAT], TRANSACTION]])
  })
})
