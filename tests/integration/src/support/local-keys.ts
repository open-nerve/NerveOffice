// 本机密钥（M3-P6）的测试辅助：取用与吊销的请求、库里的行，以及包装格式（设计 §3.3）在测试这一侧的独立实现——用测试的主密钥解开
// 库里的包装结果、给测试自己插进库里的行包装一把密钥。不经应用的代码：两边各写一份，对得上才说明库里存的就是设计写的格式
// （HKDF-SHA256 按用途派生包装键与标识；AES-256-GCM，IV 12 ‖ 密文 32 ‖ 标签 16；AAD 绑定格式标签、用户、版本与主密钥标识）。
import type { LocalKey } from '@nerve-office/contracts'
import type { TestDatabase } from './database.ts'
import type { LoggedIn } from './session-client.ts'
import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { localKeySchema } from '@nerve-office/contracts'
import { expect } from 'vitest'
import { TEST_LOCAL_KEYS_MASTER_KEY } from './api-app.ts'
import { parseExact } from './contracts.ts'
import { asUser } from './session-client.ts'

/** 一把密钥属于谁、第几版 */
export interface LocalKeyOwner {
  readonly userId: string
  readonly version: number
}

/** 库里一行的密钥材料 */
export interface WrappedMaterial {
  readonly masterKeyId: Buffer
  readonly wrappedKey: Buffer
}

function derive(masterKey: string, info: string, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(masterKey, 'base64'), Buffer.alloc(0), info, length))
}

/** 主密钥的标识（16 字节） */
export function masterKeyIdOf(masterKey: string = TEST_LOCAL_KEYS_MASTER_KEY): Buffer {
  return derive(masterKey, 'nerve-office/local-keys/master-key-id/v1', 16)
}

function aadOf(owner: LocalKeyOwner, masterKeyId: Buffer): Buffer {
  return Buffer.from(JSON.stringify(['nerve-office/local-key/v1', owner.userId, owner.version, masterKeyId.toString('hex')]), 'utf8')
}

/** 按设计的格式包装一把原始密钥（测试自己往库里插一行时用） */
export function wrapLocalKey(rawKey: Buffer, owner: LocalKeyOwner, masterKey: string = TEST_LOCAL_KEYS_MASTER_KEY): WrappedMaterial {
  const masterKeyId = masterKeyIdOf(masterKey)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', derive(masterKey, 'nerve-office/local-keys/wrap/v1', 32), iv, { authTagLength: 16 })
  cipher.setAAD(aadOf(owner, masterKeyId))
  return { masterKeyId, wrappedKey: Buffer.concat([iv, cipher.update(rawKey), cipher.final(), cipher.getAuthTag()]) }
}

/** 按设计的格式解开库里的一行（解不开时抛出） */
export function unwrapLocalKey(material: WrappedMaterial, owner: LocalKeyOwner, masterKey: string = TEST_LOCAL_KEYS_MASTER_KEY): Buffer {
  expect(material.masterKeyId.equals(masterKeyIdOf(masterKey)), '不是这把主密钥包装的').toBe(true)
  expect(material.wrappedKey).toHaveLength(60)
  const decipher = createDecipheriv('aes-256-gcm', derive(masterKey, 'nerve-office/local-keys/wrap/v1', 32), material.wrappedKey.subarray(0, 12), { authTagLength: 16 })
  decipher.setAAD(aadOf(owner, material.masterKeyId))
  decipher.setAuthTag(material.wrappedKey.subarray(44))
  return Buffer.concat([decipher.update(material.wrappedKey.subarray(12, 44)), decipher.final()])
}

/** 库里一个人的一行本机密钥 */
export interface LocalKeyRow {
  readonly version: number
  readonly masterKeyId: Buffer | null
  readonly wrappedKey: Buffer | null
  readonly createdAt: Date
  readonly revokedAt: Date | null
}

/** 这个人在库里的全部本机密钥（按版本） */
export async function localKeyRowsOf(database: TestDatabase, userId: string): Promise<LocalKeyRow[]> {
  return database.query(async client => (await client.query<LocalKeyRow>(
    `SELECT version, master_key_id AS "masterKeyId", wrapped_key AS "wrappedKey", created_at AS "createdAt", revoked_at AS "revokedAt"
     FROM user_local_keys WHERE user_id = $1 ORDER BY version`,
    [userId],
  )).rows)
}

/** 库里当前的那一把的密钥材料（测试的主密钥解得开）；没有时失败 */
export async function currentMaterialOf(database: TestDatabase, userId: string): Promise<WrappedMaterial & { readonly version: number }> {
  const current = (await localKeyRowsOf(database, userId)).find(row => row.revokedAt === null)
  if (current === undefined || current.masterKeyId === null || current.wrappedKey === null)
    throw new Error('库里没有当前的本机密钥')
  return { version: current.version, masterKeyId: current.masterKeyId, wrappedKey: current.wrappedKey }
}

/** 本人取当前的本机密钥（POST /api/local-key） */
export async function fetchLocalKey(baseUrl: string, session: LoggedIn, headers?: Record<string, string | undefined>): Promise<Response> {
  return asUser(baseUrl, session, '/api/local-key', { method: 'POST', headers })
}

/** 取用成功：200，按契约逐字核对 */
export async function takeLocalKey(baseUrl: string, session: LoggedIn): Promise<LocalKey> {
  const response = await fetchLocalKey(baseUrl, session)
  expect(response.status, await response.clone().text()).toBe(200)
  return parseExact(localKeySchema, await response.json())
}

/** 系统管理员吊销某人的本机密钥（POST /api/admin/users/{id}/local-key/revoke） */
export async function revokeLocalKey(baseUrl: string, admin: LoggedIn, userId: string): Promise<Response> {
  return asUser(baseUrl, admin, `/api/admin/users/${userId}/local-key/revoke`, { method: 'POST' })
}
