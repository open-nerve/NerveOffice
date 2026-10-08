// 在测试进程里启动真实的 api 应用（与生产相同的 createApplication 与管线），监听随机端口。
import type { ApplicationOptions, ApplicationRuntime } from '@nerve-office/api'
import type { LogCapture } from './log-capture.ts'
import { Buffer } from 'node:buffer'
import { createApplication, loadServerConfig } from '@nerve-office/api'
import { captureLogs } from './log-capture.ts'

export interface TestApp {
  readonly baseUrl: string
  readonly runtime: ApplicationRuntime
  /** 应用写的日志 */
  readonly logs: LogCapture
  close: () => Promise<void>
}

export interface TestAppOptions {
  /** 这个测试文件自己的数据库（createTestDatabase），规范 §8.1 */
  databaseUrl: string
  /** 覆盖或补充的环境变量 */
  env?: Readonly<Record<string, string>>
  /** 只在测试里存在的模块（例如挂一个慢请求的控制器） */
  additionalModules?: ApplicationOptions['additionalModules']
}

/** 测试里的公开地址：状态变更请求要带与它相同的 Origin（P3 设计 §3.5）。本机 HTTP，Cookie 不带 Secure */
export const TEST_PUBLIC_ORIGIN = 'http://127.0.0.1:4100'

/**
 * 集成测试的本机密钥的主密钥（M3-P6 设计 §3.4）：固定的、可读的测试密钥（base64 解出来是 nerve-office-test-only-masterkey，
 * 公开地址是 HTTPS 时应用拒绝这种密钥）。同一个测试文件里重启应用、另起一个应用实例都是同一把；用例据它在测试这一侧解开库里的包装结果，
 * 证明服务端确实是按设计的格式加密保存的（support/local-keys.ts）。只给应用进程（serverEnvironment）
 */
export const TEST_LOCAL_KEYS_MASTER_KEY = 'bmVydmUtb2ZmaWNlLXRlc3Qtb25seS1tYXN0ZXJrZXk='

/**
 * 公开地址是 HTTPS 的用例用的主密钥：HTTPS 时应用拒绝全是可打印字符的主密钥（入库的开发、测试用密钥不会被抄进正式部署），
 * 这一把的字节（0x80…0x9f）都不在可打印的范围里，同样是固定的测试值
 */
export const TEST_HTTPS_LOCAL_KEYS_MASTER_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => 0x80 + index)).toString('base64')

/**
 * 测试里命令行与应用共用的配置：只监听本机的随机端口；连接池上限 4，免得并行的测试文件用完数据库的连接。
 * 回收站的自动清理、修订记录与回执的保留期清理默认关掉：测试里不要有后台的定时器自己改数据、占连接（要它们的用例自己打开，
 * 见 jobs 的集成测试）。
 * 这里没有本机密钥的主密钥：迁移、初始化管理员与签发重置链接的命令不需要它（M3-P6 设计 §3.4，最小权限），经它跑这些命令的用例照常通过
 * 就是证明；应用进程用 serverEnvironment
 */
export function testEnvironment(databaseUrl: string, overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    NERVE_DATABASE_URL: databaseUrl,
    NERVE_PUBLIC_ORIGIN: TEST_PUBLIC_ORIGIN,
    NERVE_HTTP_HOST: '127.0.0.1',
    NERVE_HTTP_PORT: '0',
    NERVE_DATABASE_POOL_MAX: '4',
    NERVE_TRASH_PURGE_ENABLED: 'false',
    NERVE_REVISION_PURGE_ENABLED: 'false',
    ...overrides,
  }
}

/** 测试里应用进程的配置：在 testEnvironment 之上加测试的主密钥（覆盖成空字符串就是没设） */
export function serverEnvironment(databaseUrl: string, overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return testEnvironment(databaseUrl, { NERVE_LOCAL_KEYS_MASTER_KEY: TEST_LOCAL_KEYS_MASTER_KEY, ...overrides })
}

export async function startTestApp(options: TestAppOptions): Promise<TestApp> {
  const config = loadServerConfig(serverEnvironment(options.databaseUrl, options.env))
  const logs = captureLogs()
  const runtime = await createApplication(config, { logDestination: logs.destination, additionalModules: options.additionalModules })
  const { port } = await runtime.listen()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    runtime,
    logs,
    close: async () => {
      await runtime.shutdown('测试结束')
    },
  }
}
