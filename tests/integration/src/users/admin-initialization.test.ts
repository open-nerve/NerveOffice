// 初始化首个管理员（P3 设计 §3.4，US-M1-01）：经程序接口 initializeAdmin（命令行走的是同一条路径）与真实 PostgreSQL。
import type { AppConfig } from '@nerve-office/api'
import type { TestDatabase } from '../support/database.ts'
import { AppError, initializeAdmin, loadConfig } from '@nerve-office/api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { testEnvironment } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { captureLogs } from '../support/log-capture.ts'

const PASSWORD = 'correct horse battery staple'

let database: TestDatabase
let config: AppConfig

beforeEach(async () => {
  database = await createTestDatabase()
  config = loadConfig(testEnvironment(database.url))
})

afterEach(async () => {
  await database.drop()
})

async function rows<T extends Record<string, unknown>>(query: string): Promise<T[]> {
  return database.query(async client => (await client.query<T>(query)).rows)
}

async function counts(): Promise<Record<string, string>> {
  const [row] = await rows<Record<string, string>>(`
    SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM spaces) AS spaces, (SELECT count(*) FROM audit_events) AS audit`)
  return row ?? {}
}

describe('US-M1-01 初始化首个管理员', () => {
  it('空库中创建系统管理员与个人空间，并记入审计；日志里没有密码', async () => {
    const logs = captureLogs()
    const admin = await initializeAdmin(config, { username: ' Admin ', displayName: '系统管理员', password: PASSWORD }, { logDestination: logs.destination })

    expect(await rows('SELECT id, username, display_name, system_role, status, password_hash FROM users')).toEqual([{
      id: admin.userId,
      username: 'admin',
      display_name: '系统管理员',
      system_role: 'admin',
      status: 'active',
      password_hash: expect.stringMatching(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/) as unknown,
    }])
    expect(await rows('SELECT id, type, name, status, owner_user_id, visible_to_all FROM spaces')).toEqual([{
      id: admin.personalSpaceId,
      type: 'personal',
      name: '系统管理员',
      status: 'active',
      owner_user_id: admin.userId,
      visible_to_all: false,
    }])
    expect(await rows('SELECT action, actor_type, actor_id, target_type, target_id, source, request_id, client_ip, details FROM audit_events')).toEqual([{
      action: 'users.admin_initialized',
      actor_type: 'system',
      actor_id: null,
      target_type: 'user',
      target_id: admin.userId,
      source: 'cli',
      request_id: null,
      client_ip: null,
      details: { username: 'admin' },
    }])
    expect(logs.text()).not.toContain(PASSWORD)
  })

  it('显示名不填时用用户名', async () => {
    await initializeAdmin(config, { username: 'root', password: PASSWORD }, { logDestination: captureLogs().destination })
    expect(await rows('SELECT display_name FROM users')).toEqual([{ display_name: 'root' }])
  })

  it('已有系统管理员时再次执行报错，数据不变', async () => {
    await initializeAdmin(config, { username: 'admin', password: PASSWORD }, { logDestination: captureLogs().destination })
    const before = await counts()
    await expect(initializeAdmin(config, { username: 'another', password: PASSWORD }, { logDestination: captureLogs().destination }))
      .rejects
      .toMatchObject({ code: 'ADMIN_ALREADY_INITIALIZED' })
    expect(await counts()).toEqual(before)
  })

  it('两个并发的初始化只有一个成功', async () => {
    const results = await Promise.allSettled(['first', 'second'].map(async username =>
      initializeAdmin(config, { username, password: PASSWORD }, { logDestination: captureLogs().destination })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const [rejected] = results.filter(result => result.status === 'rejected')
    expect(rejected?.reason).toBeInstanceOf(AppError)
    expect(rejected?.reason).toMatchObject({ code: 'ADMIN_ALREADY_INITIALIZED' })
    expect(await counts()).toEqual({ users: '1', spaces: '1', audit: '1' })
  })

  it('用户名已被普通账户占用（不区分大小写）：USERNAME_TAKEN，什么都不写', async () => {
    await createAccount(database, { username: 'alice' })
    const before = await counts()
    await expect(initializeAdmin(config, { username: 'ALICE', password: PASSWORD }, { logDestination: captureLogs().destination }))
      .rejects
      .toMatchObject({ code: 'USERNAME_TAKEN' })
    expect(await counts()).toEqual(before)
  })

  it.each([
    ['密码太短', { username: 'admin', password: 'short' }, '密码至少 12 个字符'],
    ['密码含控制字符（例如标准输入多了一个换行）', { username: 'admin', password: `${PASSWORD}\n` }, '密码不能包含控制字符'],
    ['用户名不合规', { username: '张三', password: PASSWORD }, '用户名为 3–32 个字符'],
    ['显示名含控制字符', { username: 'admin', displayName: '系统\n管理员', password: PASSWORD }, '显示名不能包含控制字符'],
  ])('输入不合法（%s）时拒绝，什么都不写', async (_case, input, message) => {
    await expect(initializeAdmin(config, input, { logDestination: captureLogs().destination }))
      .rejects
      .toMatchObject({ code: 'REQUEST_INVALID', message: expect.stringContaining(message) as unknown })
    expect(await counts()).toEqual({ users: '0', spaces: '0', audit: '0' })
  })
})
