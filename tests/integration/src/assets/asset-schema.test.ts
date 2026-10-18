import type { TestDatabase } from '../support/database.ts'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { createTestDatabase } from '../support/database.ts'

let database: TestDatabase
let uploader: string
const hash = 'a'.repeat(64)
beforeAll(async () => {
  database = await createTestDatabase()
  uploader = (await createPassiveAccount(database, { username: 'asset-schema-uploader' })).id
})
afterAll(async () => database?.drop())

describe('0027 真实迁移的资源约束', () => {
  it('配额单例、计数上限与预留的摘要/字节范围由数据库兜底', async () => {
    for (const values of [[2, 0, 0], [1, -1, 0], [1, 1099511627777, 0], [1, 0, -1], [1, 0, 1000001]])
      await expect(database.query(async client => client.query('INSERT INTO asset_quota (id, used_bytes, used_assets) VALUES ($1,$2,$3)', values))).rejects.toMatchObject({ code: '23514' })
    for (const values of [['A'.repeat(64), 1], ['a'.repeat(63), 1], [hash, 0], [hash, 5242881]])
      await expect(database.query(async client => client.query('INSERT INTO asset_object_claims (sha256, bytes) VALUES ($1,$2)', values))).rejects.toMatchObject({ code: '23514' })
  })

  it('对象拒绝非规范键、媒体类型、尺寸/帧/总像素及字节越界；边界值可存', async () => {
    const valid = [hash, `objects/aa/${hash}`, 'image/webp', 4000, 4000, 2, 5242880]
    const insert = 'INSERT INTO asset_objects (sha256, storage_key, mime_type, width, height, frames, bytes) VALUES ($1,$2,$3,$4,$5,$6,$7)'
    for (const [column, value] of [[0, 'A'.repeat(64)], [1, `objects/ab/${hash}`], [2, 'image/svg+xml'], [3, 0], [3, 8193], [4, -1], [5, 0], [5, 101], [5, 3], [6, 0], [6, 5242881]] as const) {
      const values = [...valid]
      values[column] = value
      await expect(database.query(async client => client.query(insert, values))).rejects.toMatchObject({ code: '23514' })
    }
    await expect(database.query(async client => client.query(insert, [hash, `objects/aa/${hash}`, 'image/png', 2, 2, 2, 100]))).rejects.toMatchObject({ code: '23514' })
    await expect(database.query(async client => client.query(insert, [hash, `objects/aa/${hash}`, 'image/webp', 8192, 8192, 1, 100]))).rejects.toMatchObject({ code: '23514' })
    // 正例只核对迁移约束，不制造正式文件；整个事务回滚，不留下破坏账本的夹具。
    await database.query(async (client) => {
      await client.query('BEGIN')
      try {
        await client.query(insert, valid)
        expect((await client.query('SELECT sha256 FROM asset_objects')).rowCount).toBe(1)
      }
      finally {
        await client.query('ROLLBACK')
      }
    })
  })

  it('资源必须同时指向存在的上传者与对象，已引用对象不能直接删除', async () => {
    await expect(database.query(async client => client.query('INSERT INTO assets (uploader_id, object_hash) VALUES ($1,$2)', [uploader, hash]))).rejects.toMatchObject({ code: '23503' })
    await database.query(async (client) => {
      await client.query('BEGIN')
      try {
        await client.query('INSERT INTO asset_objects (sha256, storage_key, mime_type, width, height, frames, bytes) VALUES ($1,$2,\'image/png\',1,1,1,100)', [hash, `objects/aa/${hash}`])
        await client.query('SAVEPOINT missing_uploader')
        await expect(client.query('INSERT INTO assets (uploader_id, object_hash) VALUES ($1,$2)', [randomUUID(), hash])).rejects.toMatchObject({ code: '23503' })
        await client.query('ROLLBACK TO SAVEPOINT missing_uploader')
        await client.query('INSERT INTO assets (uploader_id, object_hash) VALUES ($1,$2)', [uploader, hash])
        // PostgreSQL 区分不存在的外键（23503）与 ON DELETE RESTRICT（23001）。
        await expect(client.query('DELETE FROM asset_objects WHERE sha256 = $1', [hash])).rejects.toMatchObject({ code: '23001', constraint: 'assets_object_hash_asset_objects_sha256_fk' })
      }
      finally {
        await client.query('ROLLBACK')
      }
    })
  })
})
