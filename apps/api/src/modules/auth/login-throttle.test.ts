import type { Buffer } from 'node:buffer'
import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import type { LockedForSeconds, LoginThrottleRepository, Reservation, ThrottlePolicy } from './login-throttle.repository.ts'
import { describe, expect, it, vi } from 'vitest'
import { LoginThrottle } from './login-throttle.ts'
import { keyDigest } from './throttle-keys.ts'

const LOGIN = { maxFailures: 5, ipMaxFailures: 50, windowMinutes: 15, lockoutMinutes: 20 }
const USER_KEY = keyDigest('user:alice')
const ADDRESS_KEY = keyDigest('ip:203.0.113.7')
const TRANSACTION = { opaque: true } as unknown as Transaction

/** 假的仓储：按键给出预先设定的结果，记下每次调用。 */
function setup(options: {
  locked?: LockedForSeconds
  reservations?: Map<string, Reservation | undefined>
  lockedAfterRejection?: LockedForSeconds
} = {}) {
  const repository = {
    lockedFor: vi.fn(async (keys: readonly Buffer[]): Promise<LockedForSeconds> => (keys.length === 2 ? options.locked : options.lockedAfterRejection)),
    reserve: vi.fn(async (key: Buffer, _policy: ThrottlePolicy) => (options.reservations ?? new Map<string, Reservation | undefined>()).get(key.toString('hex'))),
    release: vi.fn(async (_key: Buffer, _window: string, _transaction?: Transaction) => {}),
    reset: vi.fn(async (_key: Buffer, _transaction?: Transaction) => {}),
    purgeExpired: vi.fn(async (_windowMinutes: number) => {}),
  }
  const throttle = new LoginThrottle(repository as unknown as LoginThrottleRepository, { login: LOGIN } as unknown as AppConfig)
  return { throttle, repository }
}

function reservations(user: Reservation | undefined, address?: Reservation): Map<string, Reservation | undefined> {
  return new Map([[USER_KEY.toString('hex'), user], [ADDRESS_KEY.toString('hex'), address]])
}

const ATTEMPT = { username: 'alice', clientIp: '203.0.113.7' }

describe('LoginThrottle.admit', () => {
  it('预检：任一维度锁定中直接拒绝，不占用名额', async () => {
    const { throttle, repository } = setup({ locked: 600 })
    expect(await throttle.admit(ATTEMPT)).toEqual({ admitted: false, retryAfterSeconds: 600 })
    expect(repository.lockedFor).toHaveBeenCalledWith([USER_KEY, ADDRESS_KEY])
    expect(repository.reserve).not.toHaveBeenCalled()
  })

  it('先用户名、再地址，各占一个名额，用各自的上限', async () => {
    const { throttle, repository } = setup({ reservations: reservations({ window: 'w1', lockedForSeconds: undefined }, { window: 'w2', lockedForSeconds: undefined }) })
    const admission = await throttle.admit(ATTEMPT)
    expect(admission).toMatchObject({ admitted: true, ticket: { lockedForSeconds: undefined } })
    expect(repository.reserve.mock.calls).toEqual([
      [USER_KEY, { maxFailures: 5, windowMinutes: 15, lockoutMinutes: 20 }],
      [ADDRESS_KEY, { maxFailures: 50, windowMinutes: 15, lockoutMinutes: 20 }],
    ])
    expect(repository.release).not.toHaveBeenCalled()
  })

  it('这次占用触发了锁定：票据带上两个维度里较长的锁定时长', async () => {
    const { throttle } = setup({ reservations: reservations({ window: 'w1', lockedForSeconds: 900 }, { window: 'w2', lockedForSeconds: 1200 }) })
    expect(await throttle.admit(ATTEMPT)).toMatchObject({ admitted: true, ticket: { lockedForSeconds: 1200 } })
  })

  it('用户名的名额被拒绝（预检之后刚被锁定）：不再占地址的名额', async () => {
    const { throttle, repository } = setup({ reservations: reservations(undefined), lockedAfterRejection: 899 })
    expect(await throttle.admit(ATTEMPT)).toEqual({ admitted: false, retryAfterSeconds: 899 })
    expect(repository.reserve).toHaveBeenCalledTimes(1)
    expect(repository.release).not.toHaveBeenCalled()
  })

  it('地址的名额被拒绝：退回已经占到的用户名名额（没有验证，不算失败）', async () => {
    const { throttle, repository } = setup({ reservations: reservations({ window: 'w1', lockedForSeconds: undefined }, undefined), lockedAfterRejection: 300 })
    expect(await throttle.admit(ATTEMPT)).toEqual({ admitted: false, retryAfterSeconds: 300 })
    expect(repository.release).toHaveBeenCalledWith(USER_KEY, 'w1')
    expect(repository.lockedFor).toHaveBeenLastCalledWith([ADDRESS_KEY])
  })

  it('被拒绝后查锁定时，锁定恰好结束：至少让客户端等 1 秒', async () => {
    const { throttle } = setup({ reservations: reservations(undefined), lockedAfterRejection: undefined })
    expect(await throttle.admit(ATTEMPT)).toEqual({ admitted: false, retryAfterSeconds: 1 })
  })

  it('没有合法的客户端地址：地址维度用固定的键，不跳过', async () => {
    const unknown = keyDigest('ip:unknown')
    const { throttle, repository } = setup()
    await throttle.admit({ username: 'alice' })
    expect(repository.lockedFor).toHaveBeenCalledWith([USER_KEY, unknown])
  })
})

describe('LoginTicket.succeeded', () => {
  it('清除用户名的计数，退回地址的名额（之前的失败照算），都在调用方的事务里', async () => {
    const { throttle, repository } = setup({ reservations: reservations({ window: 'w1', lockedForSeconds: undefined }, { window: 'w2', lockedForSeconds: undefined }) })
    const admission = await throttle.admit(ATTEMPT)
    if (!admission.admitted)
      throw new Error('应该放行')
    await admission.ticket.succeeded(TRANSACTION)
    expect(repository.reset).toHaveBeenCalledWith(USER_KEY, TRANSACTION)
    expect(repository.release).toHaveBeenCalledWith(ADDRESS_KEY, 'w2', TRANSACTION)
    expect(repository.reset.mock.invocationCallOrder[0]).toBeLessThan(repository.release.mock.invocationCallOrder[0] ?? 0)
  })
})

describe('LoginThrottle.purgeExpired', () => {
  it('按配置的窗口清理', async () => {
    const { throttle, repository } = setup()
    await throttle.purgeExpired()
    expect(repository.purgeExpired).toHaveBeenCalledWith(15)
  })
})
