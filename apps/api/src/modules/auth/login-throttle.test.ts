import type { Buffer } from 'node:buffer'
import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import type { LockedForSeconds, LoginThrottleRepository, Reservation, ThrottlePolicy } from './login-throttle.repository.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { LinkThrottle, LoginThrottle } from './login-throttle.ts'
import { keyDigest } from './throttle-keys.ts'

const LOGIN = { maxFailures: 5, accountMaxFailures: 50, ipMaxFailures: 50, windowMinutes: 15, lockoutMinutes: 20 }
const CONFIG = { login: LOGIN, oneTimeLinks: { recordMaxFailures: 10 } } as unknown as AppConfig
const ACCOUNT_KEY = keyDigest('account:alice')
const ACCOUNT_ADDRESS_KEY = keyDigest('account-address:alice|ip:203.0.113.7')
const ADDRESS_KEY = keyDigest('ip:203.0.113.7')
const TRANSACTION = { opaque: true } as unknown as Transaction
const LOGGER = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())

/** 假的仓储：按键给出预先设定的结果，记下每次调用。预检一次查全部三个键；之后被拒绝时只查那一个 */
function setup(options: {
  locked?: LockedForSeconds
  reservations?: Map<string, Reservation | undefined>
  lockedAfterRejection?: LockedForSeconds
} = {}) {
  const repository = {
    lockedFor: vi.fn(async (keys: readonly Buffer[]): Promise<LockedForSeconds> => (keys.length === 3 ? options.locked : options.lockedAfterRejection)),
    reserve: vi.fn(async (key: Buffer, _policy: ThrottlePolicy, _account?: Buffer) => (options.reservations ?? new Map<string, Reservation | undefined>()).get(key.toString('hex'))),
    release: vi.fn(async (_key: Buffer, _window: string, _transaction?: Transaction) => {}),
    reset: vi.fn(async (_key: Buffer, _transaction?: Transaction) => {}),
    purgeExpired: vi.fn(async (_windowMinutes: number) => {}),
  }
  const throttle = new LoginThrottle(repository as unknown as LoginThrottleRepository, CONFIG, LOGGER)
  return { throttle, repository }
}

function reservations(account: Reservation | undefined, accountAddress?: Reservation, address?: Reservation): Map<string, Reservation | undefined> {
  return new Map([[ACCOUNT_KEY.toString('hex'), account], [ACCOUNT_ADDRESS_KEY.toString('hex'), accountAddress], [ADDRESS_KEY.toString('hex'), address]])
}

function free(window: string): Reservation {
  return { window, lockedForSeconds: undefined }
}

const ATTEMPT = { username: 'alice', clientIp: '203.0.113.7' }

describe('LoginThrottle.admit（M2-P6 复核 A1：账户、账户与地址、地址三个维度）', () => {
  it('预检：任一维度锁定中直接拒绝，不占用名额', async () => {
    const { throttle, repository } = setup({ locked: 600 })
    expect(await throttle.admit(ATTEMPT)).toEqual({ admitted: false, retryAfterSeconds: 600 })
    expect(repository.lockedFor).toHaveBeenCalledWith([ACCOUNT_KEY, ACCOUNT_ADDRESS_KEY, ADDRESS_KEY])
    expect(repository.reserve).not.toHaveBeenCalled()
  })

  it('按固定的顺序占名额：账户（宽的上限）→ 账户与地址（小的上限）→ 地址；两个账户相关的维度记着所属账户，地址维度不记', async () => {
    const { throttle, repository } = setup({ reservations: reservations(free('w1'), free('w2'), free('w3')) })
    const admission = await throttle.admit(ATTEMPT)
    expect(admission).toMatchObject({ admitted: true, ticket: { lockedForSeconds: undefined } })
    expect(repository.reserve.mock.calls).toEqual([
      [ACCOUNT_KEY, { maxFailures: 50, windowMinutes: 15, lockoutMinutes: 20 }, ACCOUNT_KEY],
      [ACCOUNT_ADDRESS_KEY, { maxFailures: 5, windowMinutes: 15, lockoutMinutes: 20 }, ACCOUNT_KEY],
      [ADDRESS_KEY, { maxFailures: 50, windowMinutes: 15, lockoutMinutes: 20 }, undefined],
    ])
    expect(repository.release).not.toHaveBeenCalled()
  })

  it('同一个人换一个来源：账户维度是同一个键，账户与地址维度换成另一个键', async () => {
    const { throttle, repository } = setup()
    await throttle.admit({ username: 'alice', clientIp: '198.51.100.9' })
    expect(repository.lockedFor).toHaveBeenCalledWith([ACCOUNT_KEY, keyDigest('account-address:alice|ip:198.51.100.9'), keyDigest('ip:198.51.100.9')])
  })

  it('这次占用触发了锁定：票据带上各维度里最长的锁定时长', async () => {
    const { throttle } = setup({ reservations: reservations({ window: 'w1', lockedForSeconds: 600 }, { window: 'w2', lockedForSeconds: 900 }, { window: 'w3', lockedForSeconds: 1200 }) })
    expect(await throttle.admit(ATTEMPT)).toMatchObject({ admitted: true, ticket: { lockedForSeconds: 1200 } })
  })

  it('账户的名额被拒绝（预检之后刚被锁定）：不再占后面两个维度的名额', async () => {
    const { throttle, repository } = setup({ reservations: reservations(undefined), lockedAfterRejection: 899 })
    expect(await throttle.admit(ATTEMPT)).toEqual({ admitted: false, retryAfterSeconds: 899 })
    expect(repository.reserve).toHaveBeenCalledTimes(1)
    expect(repository.release).not.toHaveBeenCalled()
  })

  it('账户与地址的名额被拒绝：退回已经占到的账户名额（没有验证，不算失败），不占地址的名额', async () => {
    const { throttle, repository } = setup({ reservations: reservations(free('w1'), undefined), lockedAfterRejection: 450 })
    expect(await throttle.admit(ATTEMPT)).toEqual({ admitted: false, retryAfterSeconds: 450 })
    expect(repository.reserve).toHaveBeenCalledTimes(2)
    expect(repository.release.mock.calls).toEqual([[ACCOUNT_KEY, 'w1']])
    expect(repository.lockedFor).toHaveBeenLastCalledWith([ACCOUNT_ADDRESS_KEY])
  })

  it('地址的名额被拒绝：退回已经占到的两个账户相关的名额', async () => {
    const { throttle, repository } = setup({ reservations: reservations(free('w1'), free('w2'), undefined), lockedAfterRejection: 300 })
    expect(await throttle.admit(ATTEMPT)).toEqual({ admitted: false, retryAfterSeconds: 300 })
    expect(repository.release.mock.calls).toEqual([[ACCOUNT_KEY, 'w1'], [ACCOUNT_ADDRESS_KEY, 'w2']])
    expect(repository.lockedFor).toHaveBeenLastCalledWith([ADDRESS_KEY])
  })

  it('占名额时出错（例如账户与地址那一维等锁超时）：已经占到的账户名额退回（还没有验证，不算失败），原样抛出，不再占地址的名额（M2-P6 第 3 片复验 建议 1）', async () => {
    const { throttle, repository } = setup({ reservations: reservations(free('w1')) })
    const busy = new Error('canceling statement due to lock timeout')
    repository.reserve.mockImplementation(async (key: Buffer) => {
      if (key.equals(ACCOUNT_ADDRESS_KEY))
        throw busy
      return free('w1')
    })
    await expect(throttle.admit(ATTEMPT)).rejects.toBe(busy)
    expect(repository.reserve).toHaveBeenCalledTimes(2)
    expect(repository.release.mock.calls).toEqual([[ACCOUNT_KEY, 'w1']])
  })

  it('占名额出错之后退回也失败：记一条告警，抛出的仍是原来的错误', async () => {
    const warn = vi.spyOn(AppLogger.prototype, 'warn')
    const { throttle, repository } = setup()
    const busy = new Error('canceling statement due to lock timeout')
    repository.reserve.mockResolvedValueOnce(free('w1')).mockRejectedValueOnce(busy)
    repository.release.mockRejectedValueOnce(new Error('退回也繁忙'))
    await expect(throttle.admit(ATTEMPT)).rejects.toBe(busy)
    expect(warn).toHaveBeenCalledWith('退回登录限流的名额失败，这次尝试按一次失败计', expect.objectContaining({ err: expect.any(Error) as unknown }))
    warn.mockRestore()
  })

  it('第一个维度占名额就出错：没有要退回的', async () => {
    const { throttle, repository } = setup()
    repository.reserve.mockRejectedValueOnce(new Error('canceling statement due to lock timeout'))
    await expect(throttle.admit(ATTEMPT)).rejects.toThrow('lock timeout')
    expect(repository.release).not.toHaveBeenCalled()
  })

  it('被拒绝后查锁定时，锁定恰好结束：至少让客户端等 1 秒', async () => {
    const { throttle } = setup({ reservations: reservations(undefined), lockedAfterRejection: undefined })
    expect(await throttle.admit(ATTEMPT)).toEqual({ admitted: false, retryAfterSeconds: 1 })
  })

  it('没有合法的客户端地址：地址相关的两个维度用固定的键，不跳过', async () => {
    const { throttle, repository } = setup()
    await throttle.admit({ username: 'alice' })
    expect(repository.lockedFor).toHaveBeenCalledWith([ACCOUNT_KEY, keyDigest('account-address:alice|ip:unknown'), keyDigest('ip:unknown')])
  })
})

describe('LoginTicket.succeeded', () => {
  it('按固定的顺序：清除账户、账户与地址的计数，退回地址的名额（之前的失败照算），都在调用方的事务里', async () => {
    const { throttle, repository } = setup({ reservations: reservations(free('w1'), free('w2'), free('w3')) })
    const admission = await throttle.admit(ATTEMPT)
    if (!admission.admitted)
      throw new Error('应该放行')
    await admission.ticket.succeeded(TRANSACTION)
    expect(repository.reset.mock.calls).toEqual([[ACCOUNT_KEY, TRANSACTION], [ACCOUNT_ADDRESS_KEY, TRANSACTION]])
    expect(repository.release.mock.calls).toEqual([[ADDRESS_KEY, 'w3', TRANSACTION]])
    const [accountOrder = 0, accountAddressOrder = 0] = repository.reset.mock.invocationCallOrder
    expect(accountOrder).toBeLessThan(accountAddressOrder)
    expect(accountAddressOrder).toBeLessThan(repository.release.mock.invocationCallOrder[0] ?? 0)
  })
})

describe('LoginTicket.abandoned', () => {
  it('没有验证就放弃：三个维度的名额都退回，不算失败，不在事务里', async () => {
    const { throttle, repository } = setup({ reservations: reservations(free('w1'), free('w2'), { window: 'w3', lockedForSeconds: 900 }) })
    const admission = await throttle.admit(ATTEMPT)
    if (!admission.admitted)
      throw new Error('应该放行')
    await admission.ticket.abandoned()
    expect(repository.release.mock.calls).toEqual([[ACCOUNT_KEY, 'w1'], [ACCOUNT_ADDRESS_KEY, 'w2'], [ADDRESS_KEY, 'w3']])
    expect(repository.reset).not.toHaveBeenCalled()
  })
})

describe('LoginThrottle.purgeExpired', () => {
  it('按配置的窗口清理', async () => {
    const { throttle, repository } = setup()
    await throttle.purgeExpired()
    expect(repository.purgeExpired).toHaveBeenCalledWith(15)
  })
})

describe('LinkThrottle（M2-P1 设计 §3.4）', () => {
  const LINK_KEY = keyDigest('link:ip:203.0.113.7')
  const RECORD_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'

  function linkSetup(reservation: Reservation | undefined, locked?: LockedForSeconds) {
    const repository = {
      lockedFor: vi.fn(async (): Promise<LockedForSeconds> => locked),
      reserve: vi.fn(async (_key: Buffer, _policy: ThrottlePolicy, _account?: Buffer) => reservation),
      release: vi.fn(async (_key: Buffer, _window: string, _transaction?: Transaction) => {}),
      reset: vi.fn(async (_key: Buffer, _transaction?: Transaction) => {}),
      purgeExpired: vi.fn(async () => {}),
    }
    return { repository, throttle: new LinkThrottle(repository as unknown as LoginThrottleRepository, CONFIG, LOGGER) }
  }

  it('只按客户端地址计数，键另起前缀（不与登录的地址维度混在一起），阈值沿用登录的地址维度，不记所属账户', async () => {
    const { throttle, repository } = linkSetup({ window: 'w1', lockedForSeconds: undefined })
    const admission = await throttle.admit('203.0.113.7')
    expect(admission).toMatchObject({ admitted: true })
    expect(repository.lockedFor).toHaveBeenCalledWith([LINK_KEY])
    expect(repository.reserve).toHaveBeenCalledWith(LINK_KEY, { maxFailures: 50, windowMinutes: 15, lockoutMinutes: 20 }, undefined)
    expect(LINK_KEY.equals(ADDRESS_KEY)).toBe(false)
  })

  it('令牌可用（成功）：只退回这次的名额，不清除之前的失败', async () => {
    const { throttle, repository } = linkSetup({ window: 'w1', lockedForSeconds: undefined })
    const admission = await throttle.admit('203.0.113.7')
    if (!admission.admitted)
      throw new Error('应该放行')
    await admission.ticket.succeeded(TRANSACTION)
    expect(repository.release).toHaveBeenCalledWith(LINK_KEY, 'w1', TRANSACTION)
    expect(repository.reset).not.toHaveBeenCalled()
  })

  it('锁定中：拒绝，给出剩余的秒数', async () => {
    const { throttle } = linkSetup(undefined, 120)
    expect(await throttle.admit('203.0.113.7')).toEqual({ admitted: false, retryAfterSeconds: 120 })
  })

  it('找到了但不能用的链接（M2-P6）：按用途与记录计数，上限另行配置，窗口与锁定时长沿用登录的', async () => {
    const recordKey = keyDigest(`link-record:password_reset:${RECORD_ID}`)
    const { throttle, repository } = linkSetup({ window: 'w1', lockedForSeconds: undefined })
    expect(await throttle.admitRejectedRecord('password_reset', RECORD_ID)).toMatchObject({ admitted: true })
    expect(repository.lockedFor).toHaveBeenCalledWith([recordKey])
    expect(repository.reserve).toHaveBeenCalledWith(recordKey, { maxFailures: 10, windowMinutes: 15, lockoutMinutes: 20 }, undefined)
  })

  it('找到了但不能用的链接已经锁定：拒绝，给出剩余的秒数', async () => {
    const { throttle } = linkSetup(undefined, 300)
    expect(await throttle.admitRejectedRecord('invitation', RECORD_ID)).toEqual({ admitted: false, retryAfterSeconds: 300 })
  })
})
