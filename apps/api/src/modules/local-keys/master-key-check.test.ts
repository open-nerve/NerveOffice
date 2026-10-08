// 启动时核对主密钥（M3-P6 设计 §3.4）：记下现在的主密钥的标识；库里有当前的本机密钥是别的主密钥包装的就记 error（把数与处置）；
// 只记日志、照常启动，查询失败时跳过；最多等 2 秒（启动自检共同的做法，shared/startup-check.ts）
import type { MasterKeyUsage } from './local-keys.repository.ts'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STARTUP_CHECK_WAIT_MS } from '../../shared/startup-check.ts'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { FakeLocalKeysRepository, keyring } from './local-keys.test-support.ts'
import { FOREIGN_MASTER_KEY_ERROR, MasterKeyCheck } from './master-key-check.ts'

const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'
const CAT = '0199a2c4-0000-7000-8000-00000000000c'
const DAN = '0199a2c4-0000-7000-8000-00000000000d'

function setup() {
  const ring = keyring()
  const repository = new FakeLocalKeysRepository()
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  const info = vi.spyOn(AppLogger.prototype, 'info')
  const warn = vi.spyOn(AppLogger.prototype, 'warn')
  const error = vi.spyOn(AppLogger.prototype, 'error')
  return { ring, repository, check: new MasterKeyCheck(repository.asRepository(), ring, logger), info, warn, error }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MasterKeyCheck', () => {
  it('库里当前的本机密钥都是现在的主密钥包装的（或者一把也没有）：一条 info，带主密钥的标识与把数', async () => {
    const empty = setup()
    await empty.check.onApplicationBootstrap()
    expect(empty.info).toHaveBeenCalledWith('本机密钥的主密钥已就绪', { masterKeyId: empty.ring.currentMasterKeyId, currentKeys: 0 })
    expect(empty.error).not.toHaveBeenCalled()

    const { ring, repository, check, info, error } = setup()
    repository.seedCurrent(ring, AMY, 1, randomBytes(32))
    repository.seedCurrent(ring, BEN, 2, randomBytes(32))
    await check.onApplicationBootstrap()
    expect(info).toHaveBeenLastCalledWith('本机密钥的主密钥已就绪', { masterKeyId: ring.currentMasterKeyId, currentKeys: 2 })
    expect(error).not.toHaveBeenCalled()
  })

  it('有当前的本机密钥是别的主密钥包装的（主密钥换了、丢了）：一条 error，带各自的标识与把数、处置的说明；照常启动。把数按当前的密钥一共几把算，不是别的主密钥有几个（审查 A3：运维据它判断有多少人要吊销）', async () => {
    const { ring, repository, check, info, error } = setup()
    const lost = keyring()
    const other = keyring()
    repository.seedCurrent(ring, AMY, 1, randomBytes(32))
    // 同一把丢了的主密钥包装了两个人的
    repository.seedCurrent(lost, BEN, 1, randomBytes(32))
    repository.seedCurrent(lost, DAN, 2, randomBytes(32))
    repository.seedCurrent(other, CAT, 4, randomBytes(32))
    await expect(check.onApplicationBootstrap()).resolves.toBeUndefined()
    expect(info).not.toHaveBeenCalled()
    const foreignMasterKeys = [{ masterKeyId: lost.currentMasterKeyId, keys: 2 }, { masterKeyId: other.currentMasterKeyId, keys: 1 }]
      .toSorted((a, b) => a.masterKeyId.localeCompare(b.masterKeyId))
    expect(error).toHaveBeenCalledWith(FOREIGN_MASTER_KEY_ERROR, { masterKeyId: ring.currentMasterKeyId, currentKeys: 1, foreignKeys: 3, foreignMasterKeys })
    expect(FOREIGN_MASTER_KEY_ERROR).toContain('逐个吊销')
  })

  it('查询失败（数据库不可达、还没有迁移）：记一条告警后跳过，不影响启动', async () => {
    const { repository, check, warn } = setup()
    repository.currentUsageByMasterKey.mockRejectedValueOnce(new Error('relation "user_local_keys" does not exist'))
    await expect(check.onApplicationBootstrap()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('没能核对'), expect.objectContaining({ err: expect.any(Error) as unknown }))
  })

  it('查询很慢：最多等 2 秒就照常启动，有了结果再记', async () => {
    vi.useFakeTimers()
    try {
      const { ring, repository, check, warn, info } = setup()
      let answer: (usage: MasterKeyUsage[]) => void = () => {}
      repository.currentUsageByMasterKey.mockImplementationOnce(async () => new Promise<MasterKeyUsage[]>((resolve) => {
        answer = resolve
      }))
      let started = false
      const bootstrap = check.onApplicationBootstrap().then(() => {
        started = true
      })
      await vi.advanceTimersByTimeAsync(STARTUP_CHECK_WAIT_MS - 1)
      expect(started).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await bootstrap
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`超过 ${STARTUP_CHECK_WAIT_MS} 毫秒`), { masterKeyId: ring.currentMasterKeyId })
      expect(info).not.toHaveBeenCalled()
      answer([{ masterKeyId: Buffer.from(ring.currentMasterKeyId, 'hex'), keys: 5 }])
      await vi.waitFor(() => expect(info).toHaveBeenCalledWith('本机密钥的主密钥已就绪', { masterKeyId: ring.currentMasterKeyId, currentKeys: 5 }))
    }
    finally {
      vi.useRealTimers()
    }
  })
})
