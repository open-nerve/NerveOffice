import process from 'node:process'
import pg from 'pg'

/** 本机开发数据库（deploy/dev/compose.yaml）；CI 用环境变量指向服务容器。 */
const LOCAL_DEVELOPMENT_URL = 'postgres://nerve:nerve_dev_only@127.0.0.1:54318/nerve_office'

export function testDatabaseUrl(): string {
  return process.env.NERVE_TEST_DATABASE_URL ?? LOCAL_DEVELOPMENT_URL
}

/** 用一个独立的连接执行 fn，结束后关闭连接。 */
export async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 5_000 })
  await client.connect()
  try {
    return await fn(client)
  }
  finally {
    await client.end()
  }
}
