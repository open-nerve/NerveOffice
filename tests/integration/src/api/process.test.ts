// 真实进程的启动与退出、迁移命令（P2 设计 §3.3、§3.7、§3.9）：用构建产物启动。
import type { ApiProcess } from '../support/api-process.ts'
import { readExpectedMigrations } from '@nerve-office/api'
import { afterEach, describe, expect, it } from 'vitest'
import { testEnvironment } from '../support/api-app.ts'
import { startApiProcess } from '../support/api-process.ts'
import { createTestDatabase } from '../support/database.ts'

const started: ApiProcess[] = []

function start(env: Readonly<Record<string, string>>, entry?: 'main' | 'migrate'): ApiProcess {
  const api = startApiProcess(env, entry)
  started.push(api)
  return api
}

afterEach(() => {
  // 用例失败时不留下进程
  for (const api of started.splice(0))
    api.kill('SIGKILL')
})

describe('迁移命令', () => {
  it('对空库执行全部迁移；再执行一次时说明已是最新；退出码都是 0', async () => {
    const database = await createTestDatabase({ migrated: false })
    try {
      const first = start({ NERVE_DATABASE_URL: database.url }, 'migrate')
      expect((await first.exited).code).toBe(0)
      await first.waitForLog(entry => entry.msg === `已执行 ${readExpectedMigrations().length} 个迁移`)
      const second = start({ NERVE_DATABASE_URL: database.url }, 'migrate')
      expect((await second.exited).code).toBe(0)
      await second.waitForLog(entry => entry.msg === '库结构已是最新，不需要迁移')
    }
    finally {
      await database.drop()
    }
  })

  it('配置缺失时退出码 1', async () => {
    const migrate = start({}, 'migrate')
    expect((await migrate.exited).code).toBe(1)
    await migrate.waitForLog(entry => entry.code === 'CONFIG_INVALID')
  })
})

describe('api 进程', () => {
  it('配置缺失时启动失败：退出码 1，日志的错误码为 CONFIG_INVALID，并列出变量名', async () => {
    const api = start({})
    expect((await api.exited).code).toBe(1)
    const entry = await api.waitForLog(log => log.code === 'CONFIG_INVALID')
    expect(entry).toMatchObject({ level: 'fatal', issues: [{ variable: 'NERVE_DATABASE_URL', problem: '缺少' }] })
  })

  it('启动后开始监听；收到 SIGTERM 后退出，退出码 0', async () => {
    const api = start(testEnvironment())
    const listening = await api.waitForLog(entry => entry.msg === 'HTTP 服务已启动')
    const response = await fetch(`http://127.0.0.1:${String(listening.port)}/api/health/live`)
    expect(response.status).toBe(200)

    api.kill('SIGTERM')
    expect(await api.exited).toEqual({ code: 0, signal: null })
    await api.waitForLog(entry => entry.msg === '已退出')
  })
})
