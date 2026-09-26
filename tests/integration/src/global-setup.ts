import { testDatabaseUrl, withClient } from './support/database.ts'

/** 集成测试开始前确认数据库可以连接，连不上时给出明确的处理办法。 */
export default async function setup(): Promise<void> {
  try {
    await withClient(async client => client.query('SELECT 1'))
  }
  catch (error) {
    const url = new URL(testDatabaseUrl())
    throw new Error(`连不上集成测试数据库 ${url.host}${url.pathname}：先执行 pnpm db:up，或用 NERVE_TEST_DATABASE_URL 指定数据库`, { cause: error })
  }
}
