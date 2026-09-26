import { describe, expect, it } from 'vitest'
import { withClient } from './support/database.ts'

// 开发、CI 与生产使用同一个 PostgreSQL 大版本与排序规则（M1 总设计 §2.2）
describe('集成测试数据库的环境', () => {
  it('是 PostgreSQL 18', async () => {
    const versionNum = await withClient(async (client) => {
      const result = await client.query<{ server_version_num: string }>('SHOW server_version_num')
      return Number(result.rows[0]!.server_version_num)
    })
    expect(Math.floor(versionNum / 10_000)).toBe(18)
  })

  it('当前库使用 UTF8 编码，排序规则是内置提供者的 C.UTF-8', async () => {
    const row = await withClient(async (client) => {
      const result = await client.query<{ encoding: string, provider: string, locale: string | null }>(
        `SELECT pg_encoding_to_char(encoding) AS encoding, datlocprovider AS provider, datlocale AS locale
           FROM pg_database WHERE datname = current_database()`,
      )
      return result.rows[0]!
    })
    expect(row).toEqual({ encoding: 'UTF8', provider: 'b', locale: 'C.UTF-8' })
  })

  it('开启了数据页校验和', async () => {
    const checksums = await withClient(async (client) => {
      const result = await client.query<{ data_checksums: string }>('SHOW data_checksums')
      return result.rows[0]!.data_checksums
    })
    expect(checksums).toBe('on')
  })
})
