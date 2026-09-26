// 真实进程的启动与退出（P2 设计 §3.3、§3.9）：用构建产物启动 api。
import type { ApiProcess } from '../support/api-process.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { testEnvironment } from '../support/api-app.ts'
import { startApiProcess } from '../support/api-process.ts'

const started: ApiProcess[] = []

function start(env: Readonly<Record<string, string>>): ApiProcess {
  const api = startApiProcess(env)
  started.push(api)
  return api
}

afterEach(() => {
  // 用例失败时不留下进程
  for (const api of started.splice(0))
    api.kill('SIGKILL')
})

describe('api 进程', () => {
  it('配置缺失时启动失败：退出码 1，日志带 CONFIG_INVALID 并列出变量名', async () => {
    const api = start({})
    expect((await api.exited).code).toBe(1)
    expect(api.output()).toContain('CONFIG_INVALID')
    expect(api.output()).toContain('NERVE_DATABASE_URL')
  })

  it('启动后开始监听；收到 SIGTERM 后退出，退出码 0', async () => {
    const api = start(testEnvironment())
    const listening = await api.waitForLog(entry => String(entry.message).startsWith('HTTP 服务已启动'))
    const port = /:(\d+)$/.exec(String(listening.message))?.[1]
    const response = await fetch(`http://127.0.0.1:${port}/api/health/live`)
    expect(response.status).toBe(200)

    api.kill('SIGTERM')
    expect(await api.exited).toEqual({ code: 0, signal: null })
    expect(api.output()).toContain('已退出')
  })
})
