// "应用的一个连接上同时只有一条查询"这项核对自己的测试（support/single-query.ts）：它靠 pg 8 的内部字段判断，
// pg 改了内部结构时这里失败，而不是让核对悄悄失效。用一个与应用同名（application_name）的连接构造并发与逐条两种情形。
import { APPLICATION_NAME } from '@nerve-office/api/testing'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { testDatabaseUrl } from '../support/database.ts'
import { takeConcurrentQueries } from '../support/single-query.ts'

/** 与应用的连接池同名的一个连接（只有这样的连接才被核对） */
async function applicationLikeClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: testDatabaseUrl(), application_name: APPLICATION_NAME })
  await client.connect()
  return client
}

describe('应用的一个连接上同时只有一条查询（集成测试每条用例之后的核对）', () => {
  it('并发两条：后发的那一条被记下；逐条 await：什么也不记', async () => {
    const client = await applicationLikeClient()
    try {
      await Promise.all([client.query('SELECT 1 AS first'), client.query('SELECT 2 AS second')])
      expect(takeConcurrentQueries()).toEqual(['SELECT 2 AS second'])
      await client.query('SELECT 3')
      await client.query('SELECT 4')
      expect(takeConcurrentQueries()).toEqual([])
    }
    finally {
      await client.end()
    }
  })

  it('别的连接（测试自己的，application_name 不同）不核对', async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl(), application_name: 'nerve-office-test' })
    await client.connect()
    try {
      await Promise.all([client.query('SELECT 1'), client.query('SELECT 2')])
      expect(takeConcurrentQueries()).toEqual([])
    }
    finally {
      await client.end()
    }
  })
})
