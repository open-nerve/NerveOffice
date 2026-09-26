// 测试数据：直接写库建账户（带个人空间）。本 Phase 没有创建成员的接口（M2 的邀请），初始化管理员也只能执行一次。
import type { TestDatabase } from './database.ts'
import { hash } from '@node-rs/argon2'

export interface TestAccount {
  readonly id: string
  readonly username: string
  readonly password: string
  readonly personalSpaceId: string
}

export interface AccountOptions {
  readonly username: string
  readonly password?: string
  readonly displayName?: string
  readonly systemRole?: 'admin' | 'member'
}

export const DEFAULT_PASSWORD = 'correct horse battery staple'

/** 与应用的默认参数相同（内存 19 MiB、迭代 2 次、并行度 1）：登录时不会触发重新哈希。 */
const ARGON2_DEFAULTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 }

export async function createAccount(database: TestDatabase, options: AccountOptions): Promise<TestAccount> {
  const password = options.password ?? DEFAULT_PASSWORD
  const passwordHash = await hash(password, ARGON2_DEFAULTS)
  return database.query(async (client) => {
    const displayName = options.displayName ?? options.username
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (username, display_name, password_hash, system_role) VALUES ($1, $2, $3, $4) RETURNING id',
      [options.username, displayName, passwordHash, options.systemRole ?? 'member'],
    )
    const id = user.rows[0]?.id
    if (id === undefined)
      throw new Error('建账户没有返回 id')
    const space = await client.query<{ id: string }>(
      'INSERT INTO spaces (type, name, owner_user_id) VALUES (\'personal\', $1, $2) RETURNING id',
      [displayName, id],
    )
    const personalSpaceId = space.rows[0]?.id
    if (personalSpaceId === undefined)
      throw new Error('建个人空间没有返回 id')
    return { id, username: options.username, password, personalSpaceId }
  })
}
