import type { AssetUploadActor } from '@nerve-office/api'
import type { AssetUploadResponse } from '@nerve-office/contracts'
import type { TestDatabase } from './database.ts'
import type { LoggedIn } from './session-client.ts'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { assetUploadResponseSchema } from '@nerve-office/contracts'
import { expect } from 'vitest'
import { asUser } from './session-client.ts'

/** 供服务级故障与崩溃测试使用真实会话；HTTP 用例仍走登录入口。 */
export async function createAssetActor(database: TestDatabase, userId: string): Promise<AssetUploadActor> {
  const sessionId = await database.query(async client => (await client.query<{ id: string }>(`
    INSERT INTO auth_sessions (user_id, token_hash, idle_expires_at, absolute_expires_at)
    VALUES ($1, $2, now() + interval '1 hour', now() + interval '1 day') RETURNING id
  `, [userId, randomBytes(32)])).rows[0]!.id)
  return { userId, sessionId }
}

/** 自有样本经真实上传接口写入，供权限矩阵与只读快照的路由覆盖使用。 */
export async function uploadTestAsset(baseUrl: string, session: LoggedIn, file = 'minimum.png', mime = 'image/png', extension = 'png'): Promise<AssetUploadResponse> {
  const bytes = await readFile(new URL(`../../../../apps/api/src/modules/assets/testdata/${file}`, import.meta.url))
  const response = await asUser(baseUrl, session, '/api/assets', { method: 'POST', binary: { contentType: mime, bytes }, headers: { 'X-Asset-Extension': extension } })
  expect(response.status).toBe(201)
  return assetUploadResponseSchema.parse(await response.json())
}
