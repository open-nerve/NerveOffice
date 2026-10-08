// 系统管理员吊销某人的本机密钥（M3-P6 设计 §3.5，US-M3-17）的编排：一个事务里 system-admins 的共享锁复核操作者 → 锁账户行 →
// 吊销的入口 → 审计 → 同一个事务里拼好账户（带当前的本机密钥）。没有这个账户 404；没有密钥时结果为空、不记审计。
// 响应分成这一次的结果（直接来自吊销的入口）与账户的现状（Codex 评审 CX3）：结果不从现状推断。
// 别的账户操作（停用、启用等）的编排见 admin-spaces.service.test.ts；锁、并发与审计的逐字由集成测试覆盖
import type { Principal } from '../auth/index.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { AdminUsersService } from './admin-users.service.ts'

const ROOT = '0199a2c4-0000-7000-8000-000000000001'
const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const NOW = new Date('2026-10-08T03:00:00.000Z')
const ACTOR = { user: { id: ROOT, username: 'root', displayName: '管理员', systemRole: 'admin', status: 'active' }, sessionId: 's', csrfToken: 'c' } as Principal
const ORIGIN = { source: 'http', requestId: 'req-1', clientIp: '127.0.0.1' } as const
const ACCOUNT = { id: AMY, username: 'amy', displayName: '艾米', systemRole: 'member', status: 'disabled', createdAt: NOW } as const

/**
 * account：锁住的账户（没有时 404）；revoked：吊销的入口交回的结果（没有时是"没有可吊销的"）；current：读现状时这个人当前的那一把是第几版
 * （不给时按吊销之后的下一版，没有吊销时为没有）——两者分开给，才摆得出"结果为空、现状却已经有第 1 版"的交错
 */
function setup(options: { readonly account?: typeof ACCOUNT, readonly revoked?: { revokedVersion: number, nextVersion: number }, readonly current?: number } = {}) {
  const calls: string[] = []
  const transaction = { transaction: true }
  const users = {
    lockActingAdmin: vi.fn(async () => {
      calls.push('lockActingAdmin')
    }),
    lockAccount: vi.fn(async () => {
      calls.push('lockAccount')
      return options.account
    }),
  }
  const revocation = {
    revoke: vi.fn(async (_userId: string, _transaction: unknown) => {
      calls.push('revoke')
      return options.revoked
    }),
  }
  const versions = {
    statesOf: vi.fn(async () => {
      calls.push('statesOf')
      const version = options.current ?? options.revoked?.nextVersion
      return new Map(version === undefined ? [] : [[AMY, { version, createdAt: NOW }]])
    }),
  }
  const lockouts = {
    locksOf: vi.fn(async () => {
      calls.push('locksOf')
      return new Map()
    }),
  }
  const audit = {
    record: vi.fn(async (_event: unknown, _options: unknown) => {
      calls.push('audit')
    }),
  }
  const transactions = {
    run: vi.fn(async <T>(work: (transaction: never) => Promise<T>) => {
      calls.push('begin')
      const result = await work(transaction as never)
      calls.push('commit')
      return result
    }),
  }
  const service = new AdminUsersService(users as never, {} as never, {} as never, {} as never, lockouts as never, {} as never, versions as never, revocation as never, audit as never, transactions as never)
  return { service, calls, users, revocation, versions, audit, transaction }
}

describe('AdminUsersService.revokeLocalKey（M3-P6 设计 §3.5）', () => {
  it('锁的顺序：复核操作者 → 锁账户行 → 吊销 → 审计（明细是被吊销的那一版）→ 同一个事务里读账户的视图；响应带着这一次的结果（吊销第 1 版、换成第 2 版）与现状（第 2 版）', async () => {
    const { service, calls, users, revocation, versions, audit, transaction } = setup({ account: ACCOUNT, revoked: { revokedVersion: 1, nextVersion: 2 } })
    const response = await service.revokeLocalKey(ACTOR, AMY, ORIGIN)
    expect(calls).toEqual(['begin', 'lockActingAdmin', 'lockAccount', 'revoke', 'audit', 'locksOf', 'statesOf', 'commit'])
    expect(users.lockActingAdmin).toHaveBeenCalledWith(ROOT, transaction)
    expect(users.lockAccount).toHaveBeenCalledWith(AMY, transaction)
    expect(revocation.revoke).toHaveBeenCalledWith(AMY, transaction)
    expect(audit.record).toHaveBeenCalledWith({ action: 'users.local_key_revoked', actor: { type: 'user', id: ROOT }, target: { type: 'user', id: AMY }, origin: ORIGIN, details: { version: 1 } }, { transaction })
    expect(versions.statesOf).toHaveBeenCalledWith([AMY], transaction)
    expect(response.revoked).toEqual({ version: 1, nextVersion: 2 })
    expect(response.account).toMatchObject({ id: AMY, status: 'disabled', localKey: { version: 2, createdAt: NOW.toISOString() } })
  })

  it('吊销与审计用数据库给出的账户 id（ADR-014），不用路径里的写法', async () => {
    const { service, revocation, audit } = setup({ account: ACCOUNT, revoked: { revokedVersion: 4, nextVersion: 5 } })
    await service.revokeLocalKey(ACTOR, 'path-id', ORIGIN)
    expect(revocation.revoke.mock.calls[0]?.[0]).toBe(AMY)
    expect(audit.record.mock.calls[0]?.[0]).toMatchObject({ target: { type: 'user', id: AMY }, details: { version: 4 } })
  })

  it('没有这个账户：404，不吊销、不记审计', async () => {
    const { service, calls } = setup()
    const failure = await service.revokeLocalKey(ACTOR, AMY, ORIGIN).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AppError)
    expect((failure as AppError).code).toBe('NOT_FOUND')
    expect(calls).toEqual(['begin', 'lockActingAdmin', 'lockAccount'])
  })

  it('没有密钥（从没取过）：结果为空（什么也没吊销），不记审计；现状照样给（本机密钥为空）', async () => {
    const { service, calls, audit } = setup({ account: ACCOUNT })
    const response = await service.revokeLocalKey(ACTOR, AMY, ORIGIN)
    expect(response.revoked).toBeNull()
    expect(response.account).toMatchObject({ id: AMY, localKey: null })
    expect(audit.record).not.toHaveBeenCalled()
    expect(calls).toEqual(['begin', 'lockActingAdmin', 'lockAccount', 'revoke', 'locksOf', 'statesOf', 'commit'])
  })

  it('Codex 评审 CX3：吊销没找到当前的那一把、读现状时却已经有第 1 版（这期间本人第一次取用提交了）——结果仍为空、不记审计，现状照实是第 1 版：结果不从现状推断', async () => {
    const { service, audit } = setup({ account: ACCOUNT, current: 1 })
    const response = await service.revokeLocalKey(ACTOR, AMY, ORIGIN)
    expect(response.revoked).toBeNull()
    expect(response.account.localKey).toEqual({ version: 1, createdAt: NOW.toISOString() })
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('操作者在锁里复核时已经不是有效的系统管理员：抛出，不锁账户、不吊销', async () => {
    const { service, users, revocation } = setup({ account: ACCOUNT, revoked: { revokedVersion: 1, nextVersion: 2 } })
    users.lockActingAdmin.mockRejectedValueOnce(new AppError('PERMISSION_DENIED'))
    await expect(service.revokeLocalKey(ACTOR, AMY, ORIGIN)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(users.lockAccount).not.toHaveBeenCalled()
    expect(revocation.revoke).not.toHaveBeenCalled()
  })
})
