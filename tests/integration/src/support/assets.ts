import type { AssetUploadActor } from '@nerve-office/api'
import type { TestDatabase } from './database.ts'
import { randomBytes } from 'node:crypto'

/** 供服务级故障与崩溃测试使用真实会话；HTTP 用例仍走登录入口。 */
export async function createAssetActor(database: TestDatabase, userId: string): Promise<AssetUploadActor> {
  const sessionId = await database.query(async client => (await client.query<{ id: string }>(`
    INSERT INTO auth_sessions (user_id, token_hash, idle_expires_at, absolute_expires_at)
    VALUES ($1, $2, now() + interval '1 hour', now() + interval '1 day') RETURNING id
  `, [userId, randomBytes(32)])).rows[0]!.id)
  return { userId, sessionId }
}
