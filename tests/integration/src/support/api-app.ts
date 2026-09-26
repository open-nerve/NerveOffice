// 在测试进程里启动真实的 api 应用（与生产相同的 createApplication 与管线），监听随机端口。
import type { ApplicationOptions, ApplicationRuntime } from '@nerve-office/api'
import { createApplication, loadConfig } from '@nerve-office/api'
import { testDatabaseUrl } from './database.ts'

export interface TestApp {
  readonly baseUrl: string
  readonly runtime: ApplicationRuntime
  close: () => Promise<void>
}

export interface TestAppOptions {
  /** 覆盖或补充的环境变量 */
  env?: Readonly<Record<string, string>>
  /** 只在测试里存在的模块（例如挂一个慢请求的控制器） */
  additionalModules?: ApplicationOptions['additionalModules']
}

/** 测试里应用的默认配置：只监听本机的随机端口；连接池上限 4，免得并行的测试文件用完数据库的连接。 */
export function testEnvironment(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    NERVE_DATABASE_URL: testDatabaseUrl(),
    NERVE_HTTP_HOST: '127.0.0.1',
    NERVE_HTTP_PORT: '0',
    NERVE_DATABASE_POOL_MAX: '4',
    ...overrides,
  }
}

export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const config = loadConfig(testEnvironment(options.env))
  const runtime = await createApplication(config, { logger: false, additionalModules: options.additionalModules })
  const { port } = await runtime.listen()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    runtime,
    close: async () => {
      await runtime.shutdown('测试结束')
    },
  }
}
