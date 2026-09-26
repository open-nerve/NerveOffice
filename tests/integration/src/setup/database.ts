// 每个测试文件执行前确认数据库可以连接，连不上时给出明确的处理办法。
// 放在 beforeAll 里而不是全局准备步骤里：列举测试（vitest list，用于故事对照）时不执行，不需要数据库。
import { beforeAll } from 'vitest'
import { testDatabaseUrl, withClient } from '../support/database.ts'

beforeAll(async () => {
  try {
    await withClient(async client => client.query('SELECT 1'))
  }
  catch (error) {
    const url = new URL(testDatabaseUrl())
    throw new Error(`连不上集成测试数据库 ${url.host}${url.pathname}：先执行 pnpm db:up，或用 NERVE_TEST_DATABASE_URL 指定数据库`, { cause: error })
  }
})
