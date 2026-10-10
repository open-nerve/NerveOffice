// 建模板时别的迁移（别的检出、别的分支）的模板只删没人在用的，不用 FORCE（M4-P1 S7）：原来两个迁移不同的检出同时跑集成测试时，
// 建模板的一方 FORCE 删掉另一方的模板（连带断开连在上面的会话）。在真实的 PostgreSQL 上造两个"别的哈希"的模板：一个有连接在用——不删，
// 连接断开之后下一次建库时删掉；一个没人用——删掉。正以它为模板复制的（等锁超时）由 support/database.test.ts 的判断覆盖
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { createTestDatabase, databaseUrl, withClient, withTemplateLock } from '../support/database.ts'

const inUse = `nerve_it_tpl_${randomBytes(6).toString('hex')}`
const unused = `nerve_it_tpl_${randomBytes(6).toString('hex')}`

async function remaining(): Promise<string[]> {
  return withClient(async client => (await client.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname = ANY($1) ORDER BY datname', [[inUse, unused]])).rows.map(row => row.datname))
}

/** 等连到这个库的会话都没了（客户端断开之后服务端的进程还要一会儿才退出） */
async function untilDisconnected(name: string): Promise<void> {
  const deadline = performance.now() + 10_000
  while ((await withClient(async client => client.query('SELECT 1 FROM pg_stat_activity WHERE datname = $1', [name]))).rowCount !== 0) {
    if (performance.now() > deadline)
      throw new Error(`10 秒内连到 ${name} 的会话没有退出`)
    await delay(20)
  }
}

afterAll(async () => {
  await withClient(async (client) => {
    for (const name of [inUse, unused])
      await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`)
  })
})

describe('建模板时别的迁移的模板', () => {
  it('有连接在用的不删、连接断开之后下一次建库时删掉；没人用的删掉', async () => {
    const holder = new pg.Client({ connectionString: databaseUrl(inUse) })
    try {
      await withTemplateLock(async (client) => {
        for (const name of [inUse, unused])
          await client.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`)
        // 有连接之后才允许其他测试清理模板；建库到连接之间尚不能算“没人用”。
        await holder.connect()
      })
      const first = await createTestDatabase()
      await first.drop()
      expect(await remaining()).toEqual([inUse])
      expect((await holder.query<{ one: number }>('SELECT 1 AS one')).rows).toEqual([{ one: 1 }])
    }
    finally {
      await holder.end()
    }
    await untilDisconnected(inUse)
    const second = await createTestDatabase()
    await second.drop()
    expect(await remaining()).toEqual([])
  })
})
