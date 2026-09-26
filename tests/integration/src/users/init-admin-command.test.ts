// 初始化管理员的命令（P3 设计 §3.4，US-M1-01）：用构建产物启动真实进程。密码不出现在参数、输出与日志里。
import type { ApiProcess, ApiProcessOptions } from '../support/api-process.ts'
import type { TestDatabase } from '../support/database.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testEnvironment } from '../support/api-app.ts'
import { startApiProcess } from '../support/api-process.ts'
import { createTestDatabase } from '../support/database.ts'

const PASSWORD = 'correct horse battery staple'

let database: TestDatabase
const started: ApiProcess[] = []

beforeEach(async () => {
  database = await createTestDatabase()
})

afterEach(async () => {
  for (const command of started.splice(0))
    command.kill('SIGKILL')
  await database.drop()
})

function run(options: ApiProcessOptions): ApiProcess {
  const command = startApiProcess(testEnvironment(database.url), 'init-admin', options)
  started.push(command)
  return command
}

async function userCount(): Promise<string | undefined> {
  return database.query(async client => (await client.query<{ count: string }>('SELECT count(*) AS count FROM users')).rows[0]?.count)
}

describe('US-M1-01 初始化管理员的命令', () => {
  it('--password-stdin：成功，退出码 0；再执行一次退出码 1，说明已经初始化；输出里都没有密码', async () => {
    const first = run({ args: ['--username', 'Admin', '--display-name', '系统管理员', '--password-stdin'], stdin: `${PASSWORD}\n` })
    expect((await first.exited).code).toBe(0)
    await first.waitForLog(entry => entry.msg === '已初始化系统管理员' && entry.username === 'admin')
    expect(first.output()).not.toContain(PASSWORD)

    const second = run({ args: ['--username', 'other', '--password-stdin'], stdin: PASSWORD })
    expect((await second.exited).code).toBe(1)
    await second.waitForLog(entry => entry.code === 'ADMIN_ALREADY_INITIALIZED')
    expect(second.output()).not.toContain(PASSWORD)
    expect(await userCount()).toBe('1')
  })

  it('密码不合规：退出码 1，说明原因，什么都不写', async () => {
    const command = run({ args: ['--username', 'admin', '--password-stdin'], stdin: 'short\n' })
    expect((await command.exited).code).toBe(1)
    await command.waitForLog(entry => entry.code === 'REQUEST_INVALID' && String(entry.msg).includes('密码至少 12 个字符'))
    expect(await userCount()).toBe('0')
  })

  it.each([
    ['缺少用户名', ['--password-stdin'], '缺少 --username'],
    ['把密码写在参数里', ['--username', 'admin', `--password=${PASSWORD}`], '密码不能出现在命令行参数里'],
    ['标准输入不是终端又没有 --password-stdin', ['--username', 'admin'], '请用 --password-stdin'],
  ])('用法错误（%s）：退出码 2，打印用法', async (_case, args, message) => {
    const command = run({ args })
    expect((await command.exited).code).toBe(2)
    expect(command.output()).toContain(message)
    expect(command.output()).toContain('用法：init-admin')
    expect(await userCount()).toBe('0')
  })
})
