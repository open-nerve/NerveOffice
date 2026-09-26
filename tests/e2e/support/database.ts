// E2E 的测试数据：直接写库（本 Phase 没有创建成员与文档的接口）。每个测试建自己的账户，测试之间互不影响。
import { randomBytes } from 'node:crypto'
import { hash } from '@node-rs/argon2'
import pg from 'pg'
import { e2eDatabaseUrl } from './environment.ts'

export async function withDatabase<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: e2eDatabaseUrl(), connectionTimeoutMillis: 5_000 })
  await client.connect()
  try {
    return await fn(client)
  }
  finally {
    await client.end()
  }
}

export interface TestUser {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly password: string
  readonly personalSpaceId: string
}

/** 与应用的默认参数相同：登录时不会触发重新哈希 */
const ARGON2_DEFAULTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 }

/** 新账户与它的个人空间。用户名带随机后缀：三个浏览器并行跑同一个用例时互不影响 */
export async function createUser(prefix: string, displayName = prefix): Promise<TestUser> {
  const username = `${prefix}-${randomBytes(4).toString('hex')}`
  const password = `password-${randomBytes(8).toString('hex')}`
  const passwordHash = await hash(password, ARGON2_DEFAULTS)
  return withDatabase(async (client) => {
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (username, display_name, password_hash, system_role) VALUES ($1, $2, $3, \'member\') RETURNING id',
      [username, displayName, passwordHash],
    )
    const id = user.rows[0]?.id ?? ''
    const space = await client.query<{ id: string }>('INSERT INTO spaces (type, name, owner_user_id) VALUES (\'personal\', $1, $2) RETURNING id', [displayName, id])
    return { id, username, displayName, password, personalSpaceId: space.rows[0]?.id ?? '' }
  })
}

export async function createDocument(owner: TestUser, title: string): Promise<string> {
  return withDatabase(async (client) => {
    const result = await client.query<{ id: string }>(
      'INSERT INTO documents (space_id, type, title, created_by) VALUES ($1, \'sheet\', $2, $3) RETURNING id',
      [owner.personalSpaceId, title, owner.id],
    )
    return result.rows[0]?.id ?? ''
  })
}

/** 一次写入 count 份文档，标题为"<前缀> 1"…"<前缀> count"（需要"加载更多"的用例：超过一页） */
export async function createDocuments(owner: TestUser, titlePrefix: string, count: number): Promise<void> {
  await withDatabase(async (client) => {
    await client.query(
      'INSERT INTO documents (space_id, type, title, created_by) SELECT $1, \'sheet\', $2 || \' \' || n, $3 FROM generate_series(1, $4::int) AS n',
      [owner.personalSpaceId, titlePrefix, owner.id, count],
    )
  })
}

/** 让这个人的全部会话过期（模拟空闲过期） */
export async function expireSessions(user: TestUser): Promise<void> {
  await withDatabase(async (client) => {
    await client.query('UPDATE auth_sessions SET idle_expires_at = now() - interval \'1 second\' WHERE user_id = $1', [user.id])
  })
}
